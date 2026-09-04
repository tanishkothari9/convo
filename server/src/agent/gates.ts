/**
 * The gates.
 *
 * Adapted from `shopping_agent/gates.py` in anthropics/commerce-agents
 * (Apache-2.0), with Convo's extension: that blueprint deliberately handles no
 * payment, so the money gate below — recomputing the chargeable total from
 * catalogue prices and refusing anything the model states — is Convo's own and
 * is the point at which a conversational storefront becomes a real one.
 *
 * Three rules hold here regardless of which model is running:
 *
 *  1. Provenance. A cart write accepts only product ids a catalogue or order
 *     tool returned in this conversation.
 *  2. Caps. Quantity per line, lines per cart, and total per order are values
 *     in config, applied after the write is computed and reported when applied.
 *  3. Money. The chargeable amount is recomputed server-side from live
 *     catalogue prices immediately before the provider is called. No amount
 *     the model produced is ever sent to a payment provider.
 */
import { audit, carts, orders, products, provenance } from '../db/repo.js'
import { transaction } from '../db/index.js'
import type { OrderLineItem, PricedCart, Tenant } from '../domain/types.js'
import { formatMoney } from '../lib/money.js'
import { log } from '../lib/logger.js'
import { resolveProvider } from '../commerce/registry.js'
import { ProviderApiError, ProviderConfigError } from '../commerce/types.js'
import type { AgentConfig } from './config.js'
import { failed, held, ok, type ToolOutcome } from './outcome.js'
import {
  priceCart,
  Unavailable,
  type StorefrontBackend,
  type StorefrontSession,
} from './storefront.js'

export const PROVENANCE_GATE = 'provenance'
export const STOCK_GATE = 'stock'
export const EMPTY_CART_GATE = 'empty_cart'
export const AMOUNT_GATE = 'amount'

function provenanceError(productId: string): string {
  return (
    `product_id ${productId} was not returned by a catalogue or order tool in this conversation. ` +
    'Resolve it first: call get_product_details with this exact id (text search does not match ' +
    'product ids), or find it with search_catalog, then use a product_id from those results.'
  )
}

/** Held outcome when `productId` has no provenance in this conversation, else null. */
export function checkProvenance(session: StorefrontSession, productId: string): ToolOutcome | null {
  if (provenance.has(session.tenantId, session.conversationId, productId)) return null
  return held(PROVENANCE_GATE, provenanceError(productId))
}

/**
 * Update and remove also accept a line already in the cart, which may predate
 * the provenance record.
 */
function provenanceOrCart(session: StorefrontSession, productId: string): ToolOutcome | null {
  if (checkProvenance(session, productId) === null) return null
  const cart = carts.ensureOpen(session.tenantId, session.conversationId)
  if (cart.items.some((item) => item.productId === productId)) return null
  return held(PROVENANCE_GATE, provenanceError(productId))
}

// One cart write at a time per conversation: a turn's tool calls can overlap.
const cartLocks = new Map<string, Promise<unknown>>()

async function withCartLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const previous = cartLocks.get(conversationId) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  cartLocks.set(
    conversationId,
    next.catch(() => undefined),
  )
  try {
    return await next
  } finally {
    if (cartLocks.get(conversationId) === next) cartLocks.delete(conversationId)
  }
}

function cartSummary(cart: PricedCart): string {
  if (cart.lines.length === 0) return 'the cart is empty'
  const items = `${cart.itemCount} item${cart.itemCount === 1 ? '' : 's'}`
  return `${items}, subtotal ${formatMoney(cart.subtotalMinor, cart.currency)}`
}

function cartComponent(cart: PricedCart) {
  return {
    component: 'cart',
    payload: {
      cart_id: cart.cartId,
      currency: cart.currency,
      item_count: cart.itemCount,
      subtotal_minor: cart.subtotalMinor,
      subtotal_display: formatMoney(cart.subtotalMinor, cart.currency),
      lines: cart.lines.map((line) => ({
        product_id: line.productId,
        name: line.name,
        image_url: line.imageUrl,
        quantity: line.quantity,
        unit_price_minor: line.unitPriceMinor,
        unit_price_display: formatMoney(line.unitPriceMinor, cart.currency),
        line_total_minor: line.lineTotalMinor,
        line_total_display: formatMoney(line.lineTotalMinor, cart.currency),
        in_stock: line.inStock,
        available_stock: line.availableStock,
        price_changed: line.priceChangedSinceAdd,
      })),
    },
  }
}

// ── cart writes ─────────────────────────────────────────────────────────────

export async function gatedAddToCart(args: {
  backend: StorefrontBackend
  config: AgentConfig
  session: StorefrontSession
  productId: string
  quantity: number
}): Promise<ToolOutcome> {
  const { backend, config, session, productId } = args
  const blocked = checkProvenance(session, productId)
  if (blocked) return blocked

  const requested = Math.max(1, args.quantity)

  return withCartLock(session.conversationId, async () => {
    const current = await backend.getCart(session)
    const existing = current.lines.find((line) => line.productId === productId)
    if (!existing && current.lines.length >= config.maxCartLines) {
      return failed(`The cart is full at ${config.maxCartLines} lines.`)
    }
    const room = config.maxQuantityPerItem - (existing?.quantity ?? 0)
    if (room <= 0) {
      return failed(`That item is already at the per-item limit of ${config.maxQuantityPerItem}.`)
    }
    const allowed = Math.min(requested, room)

    try {
      const cart = await backend.addToCart(session, productId, allowed)
      // The confirmation names the id, not the title: catalogue text stays fenced.
      const capped = allowed < requested ? ` (capped at the per-item limit of ${config.maxQuantityPerItem})` : ''
      return ok(`Added ${productId} x${allowed}${capped}. Cart now has ${cartSummary(cart)}.`, [
        cartComponent(cart),
      ])
    } catch (error) {
      if (error instanceof Unavailable) return held(STOCK_GATE, error.message)
      throw error
    }
  })
}

export async function gatedUpdateCartItem(args: {
  backend: StorefrontBackend
  config: AgentConfig
  session: StorefrontSession
  productId: string
  quantity: number
}): Promise<ToolOutcome> {
  const { backend, config, session, productId } = args
  const requested = Math.max(0, args.quantity)
  const applied = Math.min(requested, config.maxQuantityPerItem)

  return withCartLock(session.conversationId, async () => {
    const blocked = provenanceOrCart(session, productId)
    if (blocked) return blocked
    try {
      const cart = await backend.updateCartItem(session, productId, applied)
      const capped =
        applied < requested ? ` (capped at the per-item limit of ${config.maxQuantityPerItem})` : ''
      return ok(`Updated quantity${capped}. Cart now has ${cartSummary(cart)}.`, [cartComponent(cart)])
    } catch (error) {
      if (error instanceof Unavailable) return held(STOCK_GATE, error.message)
      throw error
    }
  })
}

export async function gatedRemoveFromCart(args: {
  backend: StorefrontBackend
  session: StorefrontSession
  productId: string
}): Promise<ToolOutcome> {
  const { backend, session, productId } = args
  return withCartLock(session.conversationId, async () => {
    const blocked = provenanceOrCart(session, productId)
    if (blocked) return blocked
    const cart = await backend.removeFromCart(session, productId)
    return ok(`Removed ${productId}. Cart now has ${cartSummary(cart)}.`, [cartComponent(cart)])
  })
}

export async function viewCart(args: {
  backend: StorefrontBackend
  session: StorefrontSession
}): Promise<ToolOutcome> {
  const cart = await args.backend.getCart(args.session)
  if (cart.lines.length === 0) return ok('The cart is empty.', [cartComponent(cart)])
  return ok(`The cart has ${cartSummary(cart)}.`, [cartComponent(cart)])
}

export { cartComponent }

// ── the money gate ──────────────────────────────────────────────────────────

/**
 * Locks the cart and creates a payment order.
 *
 * The chargeable amount is computed here, from `priceCart`, which reads live
 * catalogue prices. Whatever the model said the total was is not consulted,
 * not passed in, and cannot be passed in — `checkout` takes no amount
 * argument. Stock is re-checked at this moment too, because an item can sell
 * out between the add and the checkout.
 */
export async function gatedCheckout(args: {
  session: StorefrontSession
  tenant: Tenant
  config: AgentConfig
  /** The model's own words for why it is checking out, recorded in the audit log. */
  reasoning?: string | null
  note?: string | null
}): Promise<ToolOutcome> {
  const { session, tenant, config } = args

  return withCartLock(session.conversationId, async () => {
    const cart = carts.ensureOpen(session.tenantId, session.conversationId)
    const priced = priceCart(session, cart.id)

    // ── empty cart ──────────────────────────────────────────────────────────
    if (priced.lines.length === 0) {
      audit.record({
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        cartId: cart.id,
        actionType: 'checkout.blocked',
        outcome: 'blocked',
        reasoning: args.reasoning ?? null,
        detail: { gate: EMPTY_CART_GATE },
      })
      return held(EMPTY_CART_GATE, 'The cart is empty, so there is nothing to check out.')
    }

    // ── stock, re-checked at the moment of charge ───────────────────────────
    const shortfalls = priced.lines.filter((line) => !line.inStock)
    if (shortfalls.length > 0) {
      audit.record({
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        cartId: cart.id,
        actionType: 'checkout.blocked',
        amountMinor: priced.subtotalMinor,
        currency: priced.currency,
        outcome: 'blocked',
        reasoning: args.reasoning ?? null,
        detail: {
          gate: STOCK_GATE,
          items: shortfalls.map((line) => ({
            product_id: line.productId,
            wanted: line.quantity,
            available: line.availableStock,
          })),
        },
      })
      const description = shortfalls
        .map((line) =>
          line.availableStock === 0
            ? `${line.productId} sold out`
            : `${line.productId} has only ${line.availableStock} left, the cart has ${line.quantity}`,
        )
        .join('; ')
      return held(
        STOCK_GATE,
        `Checkout stopped and nothing was charged: ${description}. Tell the customer which item ` +
          'it is and that it went out of stock while they were shopping, then offer to remove it ' +
          'and check out with the rest, or to find something close. Do not call checkout again ' +
          'until the cart has changed.',
      )
    }

    // ── the authoritative amount ────────────────────────────────────────────
    const amountMinor = priced.subtotalMinor
    if (amountMinor <= 0 || amountMinor > config.maxOrderTotalMinor) {
      audit.record({
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        cartId: cart.id,
        actionType: 'checkout.blocked',
        amountMinor,
        currency: priced.currency,
        outcome: 'blocked',
        reasoning: args.reasoning ?? null,
        detail: { gate: AMOUNT_GATE, limit_minor: config.maxOrderTotalMinor },
      })
      return held(
        AMOUNT_GATE,
        'This order is outside the limits this brand accepts in chat. Ask the customer to get in touch with the brand directly.',
      )
    }

    const lineItems: OrderLineItem[] = priced.lines.map((line) => ({
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
    }))

    const { providerType, adapter, credentials } = resolveProvider(session.tenantId)
    if (!adapter.capabilities.payment) {
      return failed(`${adapter.displayName} is not set up to take payments for this brand.`)
    }

    // The cart is locked and the order recorded before the provider is called,
    // so a provider that answers slowly cannot be charged for twice.
    const order = transaction(() => {
      carts.setStatus(session.tenantId, cart.id, 'locked')
      audit.record({
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        cartId: cart.id,
        actionType: 'cart.locked',
        amountMinor,
        currency: priced.currency,
        outcome: 'ok',
        reasoning: args.reasoning ?? null,
        detail: { line_count: lineItems.length, item_count: priced.itemCount },
      })
      return orders.create({
        tenantId: session.tenantId,
        cartId: cart.id,
        conversationId: session.conversationId,
        totalAmountMinor: amountMinor,
        currency: priced.currency,
        providerType,
        providerOrderId: null,
        lineItems,
        status: 'created',
      })
    })

    try {
      const handle = await adapter.createPaymentOrder(credentials, {
        amountMinor,
        currency: priced.currency,
        receipt: order.id,
        lines: lineItems.map((line) => ({
          productId: line.productId,
          name: line.name,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: line.lineTotalMinor,
        })),
        notes: { tenant: tenant.slug },
      })

      // A provider that acknowledges a different amount is refused outright.
      if (handle.amountMinor !== amountMinor) {
        throw new ProviderApiError('The payment provider acknowledged a different amount.')
      }

      transaction(() => {
        orders.setStatus(session.tenantId, order.id, 'awaiting_payment')
        orders.setProviderOrderId(session.tenantId, order.id, handle.providerOrderId)
        audit.record({
          tenantId: session.tenantId,
          conversationId: session.conversationId,
          cartId: cart.id,
          orderId: order.id,
          actionType: 'order.created',
          amountMinor,
          currency: priced.currency,
          outcome: 'ok',
          reasoning: args.reasoning ?? null,
          detail: {
            provider: providerType,
            provider_order_id: handle.providerOrderId,
            mock: handle.isMock,
          },
        })
      })

      const note = args.note ? sanitizeNote(args.note) : null

      return ok(
        `Order ${order.id} is staged for ${formatMoney(amountMinor, priced.currency)} and the ` +
          'payment panel is open for the customer. The total was recomputed from catalogue prices ' +
          'server-side; state no amount of your own. Nothing is paid until confirm_payment succeeds.',
        [
          {
            component: 'order_summary',
            payload: {
              order_id: order.id,
              status: 'awaiting_payment',
              currency: priced.currency,
              total_minor: amountMinor,
              total_display: formatMoney(amountMinor, priced.currency),
              item_count: priced.itemCount,
              note,
              lines: lineItems.map((line) => ({
                product_id: line.productId,
                name: line.name,
                quantity: line.quantity,
                unit_price_display: formatMoney(line.unitPriceMinor, priced.currency),
                line_total_display: formatMoney(line.lineTotalMinor, priced.currency),
              })),
              payment: {
                provider: handle.provider,
                provider_label: adapter.displayName,
                provider_order_id: handle.providerOrderId,
                public_key: handle.publicKey,
                is_mock: handle.isMock,
                amount_minor: handle.amountMinor,
                currency: handle.currency,
              },
            },
          },
        ],
      )
    } catch (error) {
      // The provider refused or was unreachable. Nothing was charged; give the
      // cart back so the customer can try again.
      const reason =
        error instanceof ProviderConfigError
          ? 'This brand’s payment provider is not configured correctly.'
          : error instanceof ProviderApiError
            ? 'The payment provider could not start this payment.'
            : 'The payment could not be started.'
      transaction(() => {
        carts.setStatus(session.tenantId, cart.id, 'open')
        orders.setStatus(session.tenantId, order.id, 'failed', { failureReason: reason })
        audit.record({
          tenantId: session.tenantId,
          conversationId: session.conversationId,
          cartId: cart.id,
          orderId: order.id,
          actionType: 'payment.attempted',
          amountMinor,
          currency: priced.currency,
          outcome: 'failed',
          reasoning: args.reasoning ?? null,
          detail: { provider: providerType, reason },
        })
      })
      log.warn('checkout failed at the provider', {
        tenantId: session.tenantId,
        orderId: order.id,
        provider: providerType,
        message: error instanceof Error ? error.message : 'unknown',
      })
      return failed(
        `${reason} Nothing has been charged and the cart is unchanged. Tell the customer plainly ` +
          'and offer to try again.',
      )
    }
  })
}

/**
 * Confirms a payment.
 *
 * Verification is the adapter's, server-side, against the order id Convo holds
 * — not the one the browser reported. A verified payment that does not match
 * the recorded amount is refused. Every outcome is written to the audit log.
 */
export async function gatedConfirmPayment(args: {
  session: StorefrontSession
  orderId: string
  payload: Record<string, unknown>
  reasoning?: string | null
}): Promise<ToolOutcome> {
  const { session, orderId } = args
  const order = orders.byId(session.tenantId, orderId)
  if (!order) return failed('No such order for this conversation.')
  if (order.conversationId !== session.conversationId) {
    return failed('That order belongs to a different conversation.')
  }
  if (order.status === 'paid') {
    return ok(`Order ${order.id} is already paid.`, [orderConfirmationComponent(order.id, order)])
  }

  const { adapter, credentials, providerType } = resolveProvider(session.tenantId)

  audit.record({
    tenantId: session.tenantId,
    conversationId: session.conversationId,
    cartId: order.cartId,
    orderId: order.id,
    actionType: 'payment.attempted',
    amountMinor: order.totalAmountMinor,
    currency: order.currency,
    outcome: 'ok',
    reasoning: args.reasoning ?? null,
    detail: { provider: providerType },
  })

  let result
  try {
    result = await adapter.verifyPayment(credentials, {
      ...args.payload,
      // The server's own order id is what gets signed, never the client's.
      expectedOrderId: order.providerOrderId,
    })
  } catch (error) {
    log.error('payment verification threw', {
      tenantId: session.tenantId,
      orderId: order.id,
      message: error instanceof Error ? error.message : 'unknown',
    })
    result = {
      verified: false,
      providerPaymentId: null,
      providerOrderId: order.providerOrderId,
      capturedAmountMinor: null,
      failureReason: 'Convo could not reach the payment provider to confirm this payment.',
    }
  }

  if (!result.verified) {
    const signatureProblem = /signature/i.test(result.failureReason ?? '')
    transaction(() => {
      orders.setStatus(session.tenantId, order.id, 'failed', {
        failureReason: result.failureReason,
        providerPaymentId: result.providerPaymentId,
      })
      carts.setStatus(session.tenantId, order.cartId, 'open')
      audit.record({
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        cartId: order.cartId,
        orderId: order.id,
        actionType: signatureProblem ? 'payment.signature_rejected' : 'payment.failed',
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        outcome: 'failed',
        reasoning: args.reasoning ?? null,
        detail: { provider: providerType, reason: result.failureReason },
      })
    })
    return ok(
      `Payment for ${order.id} did not go through: ${result.failureReason ?? 'the provider declined it'}. ` +
        'Nothing has been charged and the cart is intact. Tell the customer plainly, without ' +
        'speculating about the reason, and offer to try again.',
      [
        {
          component: 'payment_failed',
          payload: {
            order_id: order.id,
            reason: result.failureReason ?? 'The payment did not complete.',
            total_display: formatMoney(order.totalAmountMinor, order.currency),
          },
        },
      ],
    )
  }

  // Verified. Confirm the amount matches what Convo recorded before marking paid.
  if (
    result.capturedAmountMinor !== null &&
    result.capturedAmountMinor !== order.totalAmountMinor
  ) {
    transaction(() => {
      audit.record({
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        cartId: order.cartId,
        orderId: order.id,
        actionType: 'payment.failed',
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        outcome: 'failed',
        reasoning: args.reasoning ?? null,
        detail: {
          provider: providerType,
          reason: 'captured amount did not match the recorded order total',
          captured_minor: result.capturedAmountMinor,
        },
      })
    })
    return failed(
      'The amount the provider captured does not match this order. It has been flagged for the ' +
        'brand to review; tell the customer their order is on hold and the brand will be in touch.',
    )
  }

  const paid = transaction(() => {
    // Stock comes off the shelf only once payment is confirmed.
    for (const line of order.lineItems) {
      products.reserveStock(session.tenantId, line.productId, line.quantity)
    }
    carts.setStatus(session.tenantId, order.cartId, 'converted')
    const updated = orders.setStatus(session.tenantId, order.id, 'paid', {
      providerPaymentId: result.providerPaymentId,
      failureReason: null,
    })
    audit.record({
      tenantId: session.tenantId,
      conversationId: session.conversationId,
      cartId: order.cartId,
      orderId: order.id,
      actionType: 'payment.confirmed',
      amountMinor: order.totalAmountMinor,
      currency: order.currency,
      outcome: 'ok',
      reasoning: args.reasoning ?? null,
      detail: {
        provider: providerType,
        provider_payment_id: result.providerPaymentId,
        signature_verified: true,
      },
    })
    return updated!
  })

  return ok(
    `Payment for ${order.id} is confirmed. Say so in one sentence; the confirmation card carries the figures.`,
    [orderConfirmationComponent(order.id, paid)],
  )
}

function orderConfirmationComponent(orderId: string, order: { totalAmountMinor: number; currency: string; lineItems: OrderLineItem[]; providerPaymentId: string | null }) {
  return {
    component: 'order_confirmation',
    payload: {
      order_id: orderId,
      status: 'paid',
      total_minor: order.totalAmountMinor,
      total_display: formatMoney(order.totalAmountMinor, order.currency),
      currency: order.currency,
      payment_reference: order.providerPaymentId,
      lines: order.lineItems.map((line) => ({
        product_id: line.productId,
        name: line.name,
        quantity: line.quantity,
        line_total_display: formatMoney(line.lineTotalMinor, order.currency),
      })),
    },
  }
}

function sanitizeNote(note: string): string {
  return note.replace(/\s+/g, ' ').trim().slice(0, 300)
}
