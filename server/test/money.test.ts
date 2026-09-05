/**
 * The money path, end to end against a real database.
 *
 * These are the rules that must hold whatever the model asks for: the total is
 * recomputed from the catalogue, an item that sells out stops the charge, an
 * order that has been superseded cannot be paid, and a customer who keeps
 * shopping does not lose their cart.
 */
process.env.DATABASE_PATH = `./data/test-${process.pid}.db`
process.env.CONVO_SECRET = 'test-secret-for-the-money-path-000000000000'

import { strict as assert } from 'node:assert'
import { after, before, test } from 'node:test'
import { rmSync } from 'node:fs'

const { db, closeDb } = await import('../src/db/index.js')
const { carts, connections, orders, products, provenance, tenants, audit } = await import(
  '../src/db/repo.js'
)
const { gatedAddToCart, gatedCheckout, gatedConfirmPayment } = await import('../src/agent/gates.js')
const { ConvoStorefront, ensureSession } = await import('../src/agent/storefront.js')
const { DEFAULT_AGENT_CONFIG } = await import('../src/agent/config.js')
const { signManualPayment } = await import('../src/commerce/manual.js')
const { readAddress, AddressError } = await import('../src/domain/address.js')

const GOOD_ADDRESS = {
  name: 'Anika Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  line2: 'Near Devaraja Market',
  city: 'Mysuru',
  state: 'Karnataka',
  postalCode: '570001',
}

const backend = new ConvoStorefront()
const config = DEFAULT_AGENT_CONFIG

let tenantId = ''

before(() => {
  db()
  const tenant = tenants.create({ name: 'Test Brand', slug: `test-${process.pid}` })
  tenantId = tenant.id
  connections.upsert({
    tenantId,
    providerType: 'manual',
    capabilities: 'catalog+payment',
    credentialsEnc: null,
    credentialsHint: null,
  })
  connections.activate(tenantId, 'manual', ['catalog', 'payment'])
})

after(() => {
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${process.env.DATABASE_PATH}${suffix}`)
    } catch {
      /* nothing to clean up */
    }
  }
})

/** A fresh conversation with one product already seen. */
function scenario(name: string, priceMajor: number, stock: number) {
  const product = products.create({
    tenantId,
    name,
    priceMinor: priceMajor * 100,
    stock,
    currency: 'INR',
  })
  const session = ensureSession(tenantId, `cust-${name}-${Math.random()}`, 'INR')
  provenance.remember(tenantId, session.conversationId, [product.id])
  return { product, session, tenant: tenants.byId(tenantId)! }
}

test('checkout is held on an empty cart and nothing is staged', async () => {
  const { session, tenant } = scenario('empty-cart-item', 100, 5)
  const outcome = await gatedCheckout({ session, tenant, config })
  assert.equal(outcome.heldBy, 'empty_cart')
  assert.equal(orders.listForConversation(tenantId, session.conversationId).length, 0)
})

test('the charged total is recomputed from the catalogue, not from the cart snapshot', async () => {
  const { product, session, tenant } = scenario('repriced-item', 1000, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })

  // The merchant changes the price while the item sits in the cart.
  products.update(tenantId, product.id, { priceMinor: 150_000 })

  const outcome = await gatedCheckout({ session, tenant, config })
  assert.equal(outcome.isError, false)
  const order = orders.listForConversation(tenantId, session.conversationId)[0]!
  // 2 × the new price, not 2 × the price at add time.
  assert.equal(order.totalAmountMinor, 300_000)
})

test('an item that sells out between the cart and checkout stops the charge', async () => {
  const { product, session, tenant } = scenario('sells-out-item', 500, 3)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })

  products.update(tenantId, product.id, { stock: 0 })

  const outcome = await gatedCheckout({ session, tenant, config })
  assert.equal(outcome.heldBy, 'stock')
  assert.equal(orders.listForConversation(tenantId, session.conversationId).length, 0)

  const blocked = audit
    .list(tenantId, 50)
    .find((entry) => entry.actionType === 'checkout.blocked' && entry.outcome === 'blocked')
  assert.ok(blocked, 'the refusal is in the audit trail')
})

test('a payment cannot be confirmed without a valid signature', async () => {
  const { product, session, tenant } = scenario('unsigned-item', 700, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, tenant, config })
  const order = orders.listForConversation(tenantId, session.conversationId)[0]!
  // Otherwise valid, so the refusal below is the signature and nothing else.
  orders.setShippingAddress(tenantId, order.id, readAddress(GOOD_ADDRESS))

  const outcome = await gatedConfirmPayment({
    session,
    orderId: order.id,
    payload: { payment_id: 'made_up', signature: 'not-a-signature' },
  })
  assert.match(outcome.text, /did not go through/i)
  assert.equal(orders.byId(tenantId, order.id)!.status, 'failed')
})

test('a correctly signed payment marks the order paid and takes the stock', async () => {
  const { product, session, tenant } = scenario('paid-item', 400, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })
  await gatedCheckout({ session, tenant, config })
  const order = orders.listForConversation(tenantId, session.conversationId)[0]!
  orders.setShippingAddress(tenantId, order.id, readAddress(GOOD_ADDRESS))

  const paymentId = 'cvpay_test_ok'
  const outcome = await gatedConfirmPayment({
    session,
    orderId: order.id,
    payload: {
      payment_id: paymentId,
      signature: signManualPayment(order.providerOrderId!, paymentId),
    },
  })

  assert.equal(outcome.isError, false)
  assert.equal(orders.byId(tenantId, order.id)!.status, 'paid')
  assert.equal(products.byId(tenantId, product.id)!.stock, 3, 'stock comes off only once paid')
  assert.ok(
    audit.list(tenantId, 50).some((e) => e.actionType === 'payment.confirmed' && e.orderId === order.id),
  )
})

test('an order superseded by a newer checkout cannot be paid', async () => {
  const { product, session, tenant } = scenario('superseded-item', 300, 10)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, tenant, config })
  const first = orders.listForConversation(tenantId, session.conversationId)[0]!

  // The customer keeps shopping, then checks out again.
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, tenant, config })

  assert.equal(orders.byId(tenantId, first.id)!.status, 'cancelled')

  const paymentId = 'cvpay_test_stale'
  const outcome = await gatedConfirmPayment({
    session,
    orderId: first.id,
    payload: {
      payment_id: paymentId,
      signature: signManualPayment(first.providerOrderId!, paymentId),
    },
  })
  // A valid signature is not enough: the order is no longer payable.
  assert.match(outcome.text, /cancelled or replaced/i)
  assert.equal(orders.byId(tenantId, first.id)!.status, 'cancelled')
})

test('shopping on after staging a checkout keeps the cart rather than starting a new one', async () => {
  const { product, session, tenant } = scenario('kept-cart-item', 250, 10)
  const second = products.create({ tenantId, name: 'second-item', priceMinor: 75_000, stock: 4 })
  provenance.remember(tenantId, session.conversationId, [second.id])

  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, tenant, config })

  // Instead of paying, the customer adds something else.
  await gatedAddToCart({ backend, config, session, productId: second.id, quantity: 1 })

  const cart = carts.ensureOpen(tenantId, session.conversationId)
  assert.equal(cart.items.length, 2, 'the earlier item is still in the cart')

  await gatedCheckout({ session, tenant, config })
  const latest = orders.listForConversation(tenantId, session.conversationId)[0]!
  assert.equal(latest.totalAmountMinor, 25_000 + 75_000)
})

test('the per-item cap is applied and reported, never silently exceeded', async () => {
  const { product, session } = scenario('capped-item', 100, 500)
  const outcome = await gatedAddToCart({
    backend,
    config,
    session,
    productId: product.id,
    quantity: config.maxQuantityPerItem + 40,
  })
  assert.match(outcome.text, /capped at the per-item limit/i)
  const cart = carts.ensureOpen(tenantId, session.conversationId)
  assert.equal(cart.items[0]!.quantity, config.maxQuantityPerItem)
})

test('a cart write for a product this conversation has not seen is held', async () => {
  const { session } = scenario('provenance-item', 100, 5)
  const unseen = products.create({ tenantId, name: 'never-shown', priceMinor: 9900, stock: 5 })

  const outcome = await gatedAddToCart({
    backend,
    config,
    session,
    productId: unseen.id,
    quantity: 1,
  })
  assert.equal(outcome.heldBy, 'provenance')
  assert.equal(carts.ensureOpen(tenantId, session.conversationId).items.length, 0)
})


// ── Delivery address ────────────────────────────────────────────────────────

test('an order with nowhere to send it cannot be paid, even with a valid signature', async () => {
  const { product, session, tenant } = scenario('no-address-item', 600, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, tenant, config })
  const order = orders.listForConversation(tenantId, session.conversationId)[0]!

  const paymentId = 'cvpay_no_address'
  const outcome = await gatedConfirmPayment({
    session,
    orderId: order.id,
    payload: {
      payment_id: paymentId,
      signature: signManualPayment(order.providerOrderId!, paymentId),
    },
  })

  assert.equal(outcome.heldBy, 'address')
  assert.notEqual(orders.byId(tenantId, order.id)!.status, 'paid')
  assert.equal(products.byId(tenantId, product.id)!.stock, 5, 'stock left the shelf without an address')
})

test('the address is frozen onto the order it was given for', async () => {
  const { product, session, tenant } = scenario('frozen-address-item', 300, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, tenant, config })
  const order = orders.listForConversation(tenantId, session.conversationId)[0]!

  orders.setShippingAddress(tenantId, order.id, readAddress(GOOD_ADDRESS))
  const stored = orders.byId(tenantId, order.id)!.shippingAddress!
  assert.equal(stored.city, 'Mysuru')
  assert.equal(stored.postalCode, '570001')

  // A later order gets its own copy, so changing one cannot rewrite history.
  orders.setShippingAddress(
    tenantId,
    order.id,
    readAddress({ ...GOOD_ADDRESS, city: 'Bengaluru', postalCode: '560001' }),
  )
  assert.equal(orders.byId(tenantId, order.id)!.shippingAddress!.city, 'Bengaluru')
})

test('an address is pre-filled from the last one used in the same conversation', async () => {
  const { product, session, tenant } = scenario('prefill-item', 200, 9)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, tenant, config })
  const first = orders.listForConversation(tenantId, session.conversationId)[0]!
  orders.setShippingAddress(tenantId, first.id, readAddress(GOOD_ADDRESS))

  const recalled = orders.lastShippingAddress(tenantId, session.conversationId)!
  assert.equal(recalled.name, 'Anika Rao')

  // And it does not leak into another conversation.
  const other = ensureSession(tenantId, `other-${Math.random()}`, 'INR')
  assert.equal(orders.lastShippingAddress(tenantId, other.conversationId), null)
})

test('an address is validated and normalised however it was typed', () => {
  const messy = readAddress({
    ...GOOD_ADDRESS,
    name: '  Anika   Rao ',
    phone: '+91 98765-43210',
    line1: '12  MG Road',
    postalCode: '570 001',
  })
  assert.equal(messy.name, 'Anika Rao')
  assert.equal(messy.phone, '9876543210')
  assert.equal(messy.line1, '12 MG Road')
  assert.equal(messy.postalCode, '570001')
  assert.equal(messy.country, 'India')
})

test('an address that could not be delivered to is refused', () => {
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ ...GOOD_ADDRESS, name: 'A' }, 'name'],
    [{ ...GOOD_ADDRESS, phone: '12345' }, 'phone'],
    [{ ...GOOD_ADDRESS, phone: '1234567890' }, 'phone'],
    [{ ...GOOD_ADDRESS, line1: '' }, 'line1'],
    [{ ...GOOD_ADDRESS, city: '' }, 'city'],
    [{ ...GOOD_ADDRESS, state: 'Atlantis' }, 'state'],
    [{ ...GOOD_ADDRESS, postalCode: '57000' }, 'postalCode'],
    [{ ...GOOD_ADDRESS, postalCode: '070001' }, 'postalCode'],
  ]
  for (const [input, field] of bad) {
    assert.throws(
      () => readAddress(input),
      (error: unknown) => error instanceof AddressError && error.field === field,
      `accepted an undeliverable address, expected ${field} to fail`,
    )
  }
})
