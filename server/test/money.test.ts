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
const { cartPayload, gatedAddToCart, gatedCheckout, gatedConfirmPayment, viewCart } = await import(
  '../src/agent/gates.js'
)
const { ConvoStorefront, ensureSession, priceCart } = await import('../src/agent/storefront.js')
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
let otherTenantId = ''

/** A brand that is on the marketplace shelf and can take money. */
function listedBrand(name: string, slug: string): string {
  const tenant = tenants.create({ name, slug })
  connections.upsert({
    tenantId: tenant.id,
    providerType: 'manual',
    capabilities: 'catalog+payment',
    credentialsEnc: null,
    credentialsHint: null,
  })
  connections.activate(tenant.id, 'manual', ['catalog', 'payment'])
  tenants.update(tenant.id, { isListed: true })
  return tenant.id
}

before(() => {
  db()
  tenantId = listedBrand('Test Brand', `test-${process.pid}`)
  otherTenantId = listedBrand('Other Brand', `other-${process.pid}`)
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
function scenario(name: string, priceMajor: number, stock: number, brand = tenantId) {
  const product = products.create({
    tenantId: brand,
    name,
    priceMinor: priceMajor * 100,
    stock,
    currency: 'INR',
  })
  const session = ensureSession(`cust-${name}-${Math.random()}`, 'INR')
  provenance.remember(session.conversationId, [{ productId: product.id, tenantId: brand }])
  return { product, session, tenant: tenants.byId(brand)! }
}

/** Puts a second brand's product into the same conversation and cart. */
async function alsoFrom(session: { conversationId: string; customerSessionId: string; currency: string }, name: string, priceMajor: number, stock = 5) {
  const product = products.create({
    tenantId: otherTenantId,
    name,
    priceMinor: priceMajor * 100,
    stock,
    currency: 'INR',
  })
  provenance.remember(session.conversationId, [{ productId: product.id, tenantId: otherTenantId }])
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  return product
}

test('checkout is held on an empty cart and nothing is staged', async () => {
  const { session } = scenario('empty-cart-item', 100, 5)
  const outcome = await gatedCheckout({ session, config })
  assert.equal(outcome.heldBy, 'empty_cart')
  assert.equal(orders.listForConversation(session.conversationId).length, 0)
})

test('the charged total is recomputed from the catalogue, not from the cart snapshot', async () => {
  const { product, session } = scenario('repriced-item', 1000, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })

  // The merchant changes the price while the item sits in the cart.
  products.update(tenantId, product.id, { priceMinor: 150_000 })

  const outcome = await gatedCheckout({ session, config })
  assert.equal(outcome.isError, false)
  const order = orders.listForConversation(session.conversationId)[0]!
  // 2 × the new price, not 2 × the price at add time.
  assert.equal(order.totalAmountMinor, 300_000)
})

test('an item that sells out between the cart and checkout stops the charge', async () => {
  const { product, session } = scenario('sells-out-item', 500, 3)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })

  products.update(tenantId, product.id, { stock: 0 })

  const outcome = await gatedCheckout({ session, config })
  assert.equal(outcome.heldBy, 'stock')
  assert.equal(orders.listForConversation(session.conversationId).length, 0)

  const blocked = audit
    .list(tenantId, 50)
    .find((entry) => entry.actionType === 'checkout.blocked' && entry.outcome === 'blocked')
  assert.ok(blocked, 'the refusal is in the audit trail')
})

test('a payment cannot be confirmed without a valid signature', async () => {
  const { product, session } = scenario('unsigned-item', 700, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })
  const order = orders.listForConversation(session.conversationId)[0]!
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
  const { product, session } = scenario('paid-item', 400, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })
  await gatedCheckout({ session, config })
  const order = orders.listForConversation(session.conversationId)[0]!
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

  // The receipt has to say where it is going, or the customer never gets a
  // chance to notice it is headed to the wrong house.
  const receipt = outcome.components.find((c) => c.component === 'order_confirmation')!
  const shownAddress = receipt.payload.shipping_address as { city?: string } | null
  assert.equal(shownAddress?.city, 'Mysuru', 'the confirmation did not show the delivery address')
  assert.ok(
    audit.list(tenantId, 50).some((e) => e.actionType === 'payment.confirmed' && e.orderId === order.id),
  )
})

test('an order superseded by a newer checkout cannot be paid', async () => {
  const { product, session } = scenario('superseded-item', 300, 10)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })
  const first = orders.listForConversation(session.conversationId)[0]!

  // The customer keeps shopping, then checks out again.
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })

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
  const { product, session } = scenario('kept-cart-item', 250, 10)
  const second = products.create({ tenantId, name: 'second-item', priceMinor: 75_000, stock: 4 })
  provenance.remember(session.conversationId, [{ productId: second.id, tenantId }])

  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })

  // Instead of paying, the customer adds something else.
  await gatedAddToCart({ backend, config, session, productId: second.id, quantity: 1 })

  const cart = carts.ensureOpen(session.conversationId)
  assert.equal(cart.items.length, 2, 'the earlier item is still in the cart')

  await gatedCheckout({ session, config })
  const latest = orders.listForConversation(session.conversationId)[0]!
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
  const cart = carts.ensureOpen(session.conversationId)
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
  assert.equal(carts.ensureOpen(session.conversationId).items.length, 0)
})


// ── Delivery address ────────────────────────────────────────────────────────

test('an order with nowhere to send it cannot be paid, even with a valid signature', async () => {
  const { product, session } = scenario('no-address-item', 600, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })
  const order = orders.listForConversation(session.conversationId)[0]!

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
  const { product, session } = scenario('frozen-address-item', 300, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })
  const order = orders.listForConversation(session.conversationId)[0]!

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
  const { product, session } = scenario('prefill-item', 200, 9)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })
  const first = orders.listForConversation(session.conversationId)[0]!
  orders.setShippingAddress(tenantId, first.id, readAddress(GOOD_ADDRESS))

  const recalled = orders.lastShippingAddress(session.conversationId)!
  assert.equal(recalled.name, 'Anika Rao')

  // And it does not leak into another conversation.
  const other = ensureSession(tenantId, `other-${Math.random()}`, 'INR')
  assert.equal(orders.lastShippingAddress(other.conversationId), null)
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

test('a returning customer is not asked for the same address twice', async () => {
  const { product, session } = scenario('repeat-buyer-item', 450, 20)

  // First purchase: the address is given once.
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })
  const first = orders.listForConversation(session.conversationId)[0]!
  orders.setShippingAddress(tenantId, first.id, readAddress(GOOD_ADDRESS))

  const firstPayment = 'cvpay_repeat_one'
  await gatedConfirmPayment({
    session,
    orderId: first.id,
    payload: {
      payment_id: firstPayment,
      signature: signManualPayment(first.providerOrderId!, firstPayment),
    },
  })
  assert.equal(orders.byId(tenantId, first.id)!.status, 'paid')

  // Second purchase: the address arrives already attached, so the order is
  // payable without the customer touching a form.
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  const outcome = await gatedCheckout({ session, config })
  const second = orders.listForConversation(session.conversationId)[0]!

  assert.notEqual(second.id, first.id)
  assert.equal(second.shippingAddress?.postalCode, '570001', 'the address was not carried forward')

  const card = outcome.components.find((c) => c.component === 'checkout')!
  assert.ok(card.payload.shipping_address, 'the card should open showing where this is going')

  const secondPayment = 'cvpay_repeat_two'
  const paid = await gatedConfirmPayment({
    session,
    orderId: second.id,
    payload: {
      payment_id: secondPayment,
      signature: signManualPayment(second.providerOrderId!, secondPayment),
    },
  })
  assert.equal(paid.isError, false)
  assert.equal(orders.byId(tenantId, second.id)!.status, 'paid')
})

test('an address follows the shopper across brands, but not to another shopper', async () => {
  const { product, session } = scenario('cross-brand-address-item', 100, 3)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await gatedCheckout({ session, config })
  const order = orders.listForConversation(session.conversationId)[0]!
  orders.setShippingAddress(tenantId, order.id, readAddress(GOOD_ADDRESS))

  // The address belongs to the shopper, not to a brand: buying from a second
  // label in the same thread must not mean typing it again.
  assert.deepEqual(orders.lastShippingAddress(session.conversationId), readAddress(GOOD_ADDRESS))

  const stranger = ensureSession(`stranger-${process.pid}`, 'INR')
  assert.equal(
    orders.lastShippingAddress(stranger.conversationId),
    null,
    'an address leaked to another shopper',
  )
})

test('the cart the page is handed is the cart the agent emits', async () => {
  /*
   * These were two different shapes for months: the agent's component used
   * snake_case with display strings, and the routes that hand a cart back
   * directly returned the internal record. Nothing failed loudly — a customer
   * who reloaded with items in their cart just got a badge showing nothing and
   * a sheet of blank prices. Both go through cartPayload now, and this fails
   * if either grows a field the other lacks.
   */
  const { product, session } = scenario('shape-item', 250, 4)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })
  await alsoFrom(session, 'shape-item-b', 125)

  const outcome = await viewCart({ backend, session })
  const emitted = outcome.components!.find((c) => c.component === 'cart_state')!.payload
  const handed = cartPayload(priceCart(session, carts.ensureOpen(session.conversationId).id))

  assert.deepEqual(handed, emitted, 'the route and the component disagree about the cart')

  // The fields the page actually reads, named here so removing one fails.
  for (const key of ['cart_id', 'item_count', 'subtotal_display', 'brands', 'lines']) {
    assert.ok(key in handed, `the cart payload lost ${key}`)
  }
  const [line] = handed.lines
  for (const key of ['product_id', 'brand_name', 'name', 'unit_price_display', 'line_total_display']) {
    assert.ok(key in line!, `a cart line lost ${key}`)
  }
  assert.deepEqual([...handed.brands].sort(), ['Other Brand', 'Test Brand'])
})

// ── the split ───────────────────────────────────────────────────────────────

test('a cart spanning two brands is charged as one order per brand', async () => {
  const { product, session } = scenario('split-a-item', 400, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 2 })
  await alsoFrom(session, 'split-b-item', 250)

  const outcome = await gatedCheckout({ session, config })
  assert.equal(outcome.isError, false)

  const staged = orders.listForConversation(session.conversationId)
  assert.equal(staged.length, 2, 'a two-brand cart did not split into two orders')
  assert.deepEqual(
    [...new Set(staged.map((order) => order.tenantId))].sort(),
    [tenantId, otherTenantId].sort(),
  )
  // One checkout, so the card can present them together.
  assert.equal(new Set(staged.map((order) => order.checkoutId)).size, 1)
  // Each brand is charged for its own goods and nobody else's.
  const byBrand = new Map(staged.map((order) => [order.tenantId, order.totalAmountMinor]))
  assert.equal(byBrand.get(tenantId), 80_000)
  assert.equal(byBrand.get(otherTenantId), 25_000)
})

test('paying one brand in a split checkout does not settle the other', async () => {
  const { product, session } = scenario('split-pay-a', 300, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await alsoFrom(session, 'split-pay-b', 150)
  await gatedCheckout({ session, config })

  const staged = orders.listForConversation(session.conversationId)
  const [first, second] = staged as [(typeof staged)[number], (typeof staged)[number]]
  for (const order of staged) orders.setShippingAddress(order.tenantId, order.id, readAddress(GOOD_ADDRESS))

  const paid = await gatedConfirmPayment({
    session,
    orderId: first.id,
    payload: {
      order_id: first.providerOrderId,
      payment_id: 'pay_split_1',
      signature: signManualPayment(first.providerOrderId!, 'pay_split_1'),
    },
  })
  assert.equal(paid.isError, false)
  assert.equal(orders.byId(first.tenantId, first.id)!.status, 'paid')

  // The other brand is still owed, and the cart stays locked until it is not.
  assert.equal(orders.byId(second.tenantId, second.id)!.status, 'awaiting_payment')
  assert.equal(carts.byId(first.cartId)!.status, 'locked')

  const rest = await gatedConfirmPayment({
    session,
    orderId: second.id,
    payload: {
      order_id: second.providerOrderId,
      payment_id: 'pay_split_2',
      signature: signManualPayment(second.providerOrderId!, 'pay_split_2'),
    },
  })
  assert.equal(rest.isError, false)
  assert.equal(carts.byId(first.cartId)!.status, 'converted', 'the cart did not close once both brands were paid')
})

test('a half-paid checkout does not hand the cart back', async () => {
  const { product, session } = scenario('split-halfpaid-a', 200, 5)
  await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
  await alsoFrom(session, 'split-halfpaid-b', 100)
  await gatedCheckout({ session, config })

  const staged = orders.listForConversation(session.conversationId)
  const [first, second] = staged as [(typeof staged)[number], (typeof staged)[number]]
  for (const order of staged) orders.setShippingAddress(order.tenantId, order.id, readAddress(GOOD_ADDRESS))

  await gatedConfirmPayment({
    session,
    orderId: first.id,
    payload: {
      order_id: first.providerOrderId,
      payment_id: 'pay_half_1',
      signature: signManualPayment(first.providerOrderId!, 'pay_half_1'),
    },
  })

  // The second brand declines. The cart must stay shut: reopening it would put
  // goods the shopper has already paid for back on their shopping list.
  const declined = await gatedConfirmPayment({
    session,
    orderId: second.id,
    payload: { order_id: second.providerOrderId, payment_id: 'pay_half_2', signature: 'nonsense' },
  })
  assert.equal(declined.isError, false)
  assert.equal(orders.byId(second.tenantId, second.id)!.status, 'failed')
  assert.notEqual(carts.byId(first.cartId)!.status, 'open', 'a half-paid cart was handed back')
})

test('a customer who has sent to several places gets a list, deduplicated', async () => {
  const { product, session } = scenario('multi-address-item', 500, 30)
  const send = async (address: Record<string, unknown>) => {
    await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
    await gatedCheckout({ session, config })
    const order = orders.listForConversation(session.conversationId)[0]!
    orders.setShippingAddress(tenantId, order.id, readAddress(address))
    const payment = `cvpay_${Math.random().toString(36).slice(2, 10)}`
    await gatedConfirmPayment({
      session,
      orderId: order.id,
      payload: { payment_id: payment, signature: signManualPayment(order.providerOrderId!, payment) },
    })
  }

  await send(GOOD_ADDRESS)
  await send({
    ...GOOD_ADDRESS,
    name: 'Ravi Rao',
    line1: '44 Sampige Road',
    city: 'Bengaluru',
    postalCode: '560003',
  })
  // The same place again: it must not appear twice.
  await send(GOOD_ADDRESS)

  const saved = orders.savedShippingAddresses(session.conversationId)
  assert.equal(saved.length, 2, 'the list should hold two distinct places')
  assert.equal(saved[0]!.city, 'Mysuru', 'most recently used comes first')
  assert.ok(saved.some((a) => a.city === 'Bengaluru'))
})

test('the same street with a different recipient is a separate entry', async () => {
  const { product, session } = scenario('gift-address-item', 500, 20)
  const send = async (name: string) => {
    await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
    await gatedCheckout({ session, config })
    const order = orders.listForConversation(session.conversationId)[0]!
    orders.setShippingAddress(tenantId, order.id, readAddress({ ...GOOD_ADDRESS, name }))
    const payment = `cvpay_${Math.random().toString(36).slice(2, 10)}`
    await gatedConfirmPayment({
      session,
      orderId: order.id,
      payload: { payment_id: payment, signature: signManualPayment(order.providerOrderId!, payment) },
    })
  }

  await send('Anika Rao')
  await send('Lakshmi Rao')

  const saved = orders.savedShippingAddresses(session.conversationId)
  assert.equal(saved.length, 2, 'a gift to someone else at the same flat is a different delivery')
})

test('the saved list is capped so a card cannot become a scrolling problem', async () => {
  const { product, session } = scenario('many-address-item', 400, 40)
  for (let i = 0; i < 8; i += 1) {
    await gatedAddToCart({ backend, config, session, productId: product.id, quantity: 1 })
    await gatedCheckout({ session, config })
    const order = orders.listForConversation(session.conversationId)[0]!
    orders.setShippingAddress(
      tenantId,
      order.id,
      readAddress({ ...GOOD_ADDRESS, line1: `${10 + i} MG Road` }),
    )
    const payment = `cvpay_${Math.random().toString(36).slice(2, 10)}`
    await gatedConfirmPayment({
      session,
      orderId: order.id,
      payload: { payment_id: payment, signature: signManualPayment(order.providerOrderId!, payment) },
    })
  }

  assert.equal(orders.savedShippingAddresses(session.conversationId).length, 5)
})
