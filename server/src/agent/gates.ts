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
 *
 * A fourth rule arrives with the marketplace: a cart spanning several brands
 * is settled as one order per brand, each on that brand's own payment account.
 * Convo never holds anyone else's money, so there is no merchant of record to
 * become and no float to reconcile.
 */
import { audit, carts, orders, products, provenance, tenants } from '../db/repo.js'
import { transaction } from '../db/index.js'
import { id } from '../lib/ids.js'
import type { Order, OrderLineItem, PricedCart, PricedLine } from '../domain/types.js'
import { formatMoney } from '../lib/money.js'
import { log } from '../lib/logger.js'
import { resolveProvider } from '../commerce/registry.js'
import type { ShippingAddress } from '../domain/address.js'
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
export const ADDRESS_GATE = 'address'

function provenanceError(productId: string): string {
  return (
    `product_id ${productId} was not returned by a catalogue or order tool in this conversation. ` +
    'Resolve it first: call get_product_details with this exact id (text search does not match ' +
    'product ids), or find it with search_catalog, then use a product_id from those results.'
  )
}

/** Held outcome when `productId` has no provenance in this conversation, else null. */
export function checkProvenance(session: StorefrontSession, productId: string): ToolOutcome | null {
  if (provenance.has(session.conversationId, productId)) return null
  return held(PROVENANCE_GATE, provenanceError(productId))
}

/**
 * Update and remove also accept a line already in the cart, which may predate
 * the provenance record.
 */
function provenanceOrCart(session: StorefrontSession, productId: string): ToolOutcome | null {
  if (checkProvenance(session, productId) === null) return null
  const cart = carts.ensureOpen(session.conversationId)
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

/**
 * Changing the cart after a checkout was staged.
 *
 * `checkout` locks the cart so nothing moves while a payment is in flight. If
 * the customer goes back to shopping instead of paying, that lock would
 * otherwise strand their items in a cart they can no longer reach and start
 * them a fresh empty one. So a cart write reopens the locked cart and cancels
 * the order that locked it — they are telling us they are not done.
 */
function reopenAfterCheckout(session: StorefrontSession, reasoning: string | null): void {
  const open = carts.ensureOpen(session.conversationId)
  if (open.items.length > 0) return

  const locked = carts.latestLocked(session.conversationId)
  if (!locked || locked.items.length === 0) return

  // Once any brand in a split checkout has been paid, the cart is history and
  // reopening it would put goods already bought back on the shopping list.
  const onThisCart = orders
    .listForConversation(session.conversationId, 50)
    .filter((order) => order.cartId === locked.id)
  if (onThisCart.some((order) => order.status === 'paid')) return

  const pending = onThisCart.filter(
    (order) => order.status === 'created' || order.status === 'awaiting_payment',
  )

  transaction(() => {
    for (const order of pending) {
      orders.setStatus(order.tenantId, order.id, 'cancelled', {
        failureReason: 'The customer went back to shopping before paying.',
      })
      audit.record({
        tenantId: order.tenantId,
        conversationId: session.conversationId,
        cartId: locked.id,
        orderId: order.id,
        actionType: 'payment.failed',
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        outcome: 'blocked',
        reasoning,
        detail: { reason: 'cart reopened before payment' },
      })
    }
    // The empty cart opened above is discarded; the locked one becomes current.
    if (open.id !== locked.id) carts.setStatus(open.id, 'abandoned')
    carts.setStatus(locked.id, 'open')
  })
}

function cartSummary(cart: PricedCart): string {
  if (cart.lines.length === 0) return 'the cart is empty'
  const items = `${cart.itemCount} item${cart.itemCount === 1 ? '' : 's'}`
  return `${items}, subtotal ${formatMoney(cart.subtotalMinor, cart.currency)}`
}

/**
 * The cart, as a component.
 *
 * `kind` splits the two ways it reaches the page: `cart_state` is the running
 * cart panel keeping itself in sync after a write, and `cart` is an inline
 * card the agent chose to post with `present_cart`. Same payload, different
 * placement — which is why a write no longer leaves a duplicate card behind.
 */
function cartComponent(cart: PricedCart, kind: 'cart' | 'cart_state' = 'cart_state') {
  return { component: kind, payload: cartPayload(cart) }
}

/**
 * The cart as the page reads it.
 *
 * Split out of `cartComponent` so the routes that hand a cart back directly —
 * the panel's refresh, and the history a reload rebuilds from — return the
 * same shape the agent emits. They used to return the internal record instead,
 * which meant a customer who reloaded with items in their cart got a badge
 * showing nothing and a sheet of blank prices.
 */
export function cartPayload(cart: PricedCart) {
  return {
    cart_id: cart.cartId,
    currency: cart.currency,
    item_count: cart.itemCount,
    subtotal_minor: cart.subtotalMinor,
    subtotal_display: formatMoney(cart.subtotalMinor, cart.currency),
    // Grouped for the sheet, which shows a heading per brand: a cart with
    // two labels in it is two deliveries and two charges, and the customer
    // should see that before checkout rather than after.
    brands: [...new Set(cart.lines.map((line) => line.brandName))],
    lines: cart.lines.map((line) => ({
      product_id: line.productId,
      tenant_id: line.tenantId,
      brand_name: line.brandName,
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
    reopenAfterCheckout(session, 'customer added another item after staging a checkout')
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
    reopenAfterCheckout(session, 'customer changed a quantity after staging a checkout')
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
    reopenAfterCheckout(session, 'customer removed an item after staging a checkout')
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
 * Locks the cart and stages one payment order per brand.
 *
 * The chargeable amount is computed here, from `priceCart`, which reads live
 * catalogue prices. Whatever the model said the total was is not consulted,
 * not passed in, and cannot be passed in — `checkout` takes no amount
 * argument. Stock is re-checked at this moment too, because an item can sell
 * out between the add and the checkout.
 *
 * The split is per brand because each brand takes payment on its own account.
 * It is all-or-nothing: if any brand in the cart cannot take money right now,
 * nothing is staged and the customer is told which brand and why. A checkout
 * that half-worked is worse than one that did not start.
 */
export async function gatedCheckout(args: {
  session: StorefrontSession
  config: AgentConfig
  /** The model's own words for why it is checking out, recorded in the audit log. */
  reasoning?: string | null
  note?: string | null
}): Promise<ToolOutcome> {
  const { session, config } = args

  return withCartLock(session.conversationId, async () => {
    const cart = carts.ensureOpen(session.conversationId)
    const priced = priceCart(session, cart.id)

    // ── empty cart ──────────────────────────────────────────────────────────
    if (priced.lines.length === 0) {
      // Deliberately unaudited: no brand was involved, so this belongs in no
      // brand's ledger. The audit log is each merchant's record of its own
      // money, not a log of everything the agent tried.
      return held(EMPTY_CART_GATE, 'The cart is empty, so there is nothing to check out.')
    }

    // ── stock, re-checked at the moment of charge ───────────────────────────
    const shortfalls = priced.lines.filter((line) => !line.inStock)
    if (shortfalls.length > 0) {
      for (const brand of brandsOf(shortfalls)) {
        audit.record({
          tenantId: brand,
          conversationId: session.conversationId,
          cartId: cart.id,
          actionType: 'checkout.blocked',
          amountMinor: sumOf(shortfalls.filter((line) => line.tenantId === brand)),
          currency: priced.currency,
          outcome: 'blocked',
          reasoning: args.reasoning ?? null,
          detail: {
            gate: STOCK_GATE,
            items: shortfalls
              .filter((line) => line.tenantId === brand)
              .map((line) => ({
                product_id: line.productId,
                wanted: line.quantity,
                available: line.availableStock,
              })),
          },
        })
      }
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
    const totalMinor = sumOf(priced.lines)
    if (totalMinor <= 0 || totalMinor > config.maxOrderTotalMinor) {
      // Recorded against every brand in the cart: each of them lost a sale to
      // this limit and each is entitled to see why.
      for (const brand of brandsOf(priced.lines)) {
        audit.record({
          tenantId: brand,
          conversationId: session.conversationId,
          cartId: cart.id,
          actionType: 'checkout.blocked',
          amountMinor: sumOf(priced.lines.filter((line) => line.tenantId === brand)),
          currency: priced.currency,
          outcome: 'blocked',
          reasoning: args.reasoning ?? null,
          detail: { gate: AMOUNT_GATE, limit_minor: config.maxOrderTotalMinor },
        })
      }
      return held(
        AMOUNT_GATE,
        'This order is outside the limits Convo accepts in chat. Ask the customer to get in touch with the brand directly.',
      )
    }

    /*
     * One group per brand, resolved before anything is written.
     *
     * Every provider is checked up front so a cart with a misconfigured brand
     * in it fails before a single order exists, rather than halfway through
     * staging. The message names the brand, because "checkout failed" tells a
     * customer nothing they can act on.
     */
    const groups: {
      tenantId: string
      brandName: string
      requiresShipping: boolean
      lines: PricedLine[]
      amountMinor: number
      lineItems: OrderLineItem[]
      provider: ReturnType<typeof resolveProvider>
    }[] = []

    for (const tenantId of brandsOf(priced.lines)) {
      const lines = priced.lines.filter((line) => line.tenantId === tenantId)
      const tenant = tenants.byId(tenantId)
      if (!tenant || !tenant.isListed) {
        return failed(
          `${lines[0]!.brandName} is no longer available on Convo. Tell the customer, offer to ` +
            'remove those items, and check out with the rest.',
        )
      }
      let provider
      try {
        provider = resolveProvider(tenantId)
      } catch {
        return failed(
          `${tenant.name} cannot take payments right now, so nothing was charged. Tell the ` +
            'customer which brand it is and offer to check out the rest without it.',
        )
      }
      if (!provider.adapter.capabilities.payment) {
        return failed(
          `${tenant.name} is not set up to take payments, so nothing was charged. Tell the ` +
            'customer which brand it is and offer to check out the rest without it.',
        )
      }
      groups.push({
        tenantId,
        brandName: tenant.name,
        requiresShipping: tenant.requiresShipping,
        lines,
        amountMinor: sumOf(lines),
        lineItems: lines.map((line) => ({
          productId: line.productId,
          name: line.name,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: line.lineTotalMinor,
        })),
        provider,
      })
    }

    // Staging a new checkout supersedes any earlier order in this conversation
    // that could still be paid. Without this an order card further up the
    // transcript keeps a live pay button against a cart that has since changed,
    // which is a second charge waiting to happen.
    const superseded = orders.pendingForConversation(session.conversationId)

    /*
     * Carry the address forward.
     *
     * A customer who has already said where they live should not be asked
     * again — so the last address used in this conversation is attached to
     * each new order as it is staged, not merely offered to a form. That means
     * the orders are payable the moment they appear. Changing it is one tap on
     * the card, and it changes every brand's order at once, because a shopper
     * has one doorstep however many labels they bought from.
     */
    const needsShipping = groups.some((group) => group.requiresShipping)
    const carriedAddress = needsShipping ? orders.lastShippingAddress(session.conversationId) : null

    const checkoutId = id('cko')

    // The cart is locked and the orders recorded before any provider is called,
    // so a provider that answers slowly cannot be charged for twice.
    const staged = transaction(() => {
      for (const stale of superseded) {
        orders.setStatus(stale.tenantId, stale.id, 'cancelled', {
          failureReason: 'Replaced by a newer order in the same conversation.',
        })
        audit.record({
          tenantId: stale.tenantId,
          conversationId: session.conversationId,
          cartId: stale.cartId,
          orderId: stale.id,
          actionType: 'payment.failed',
          amountMinor: stale.totalAmountMinor,
          currency: stale.currency,
          outcome: 'blocked',
          reasoning: 'superseded by a newer checkout',
          detail: { reason: 'superseded' },
        })
      }
      carts.setStatus(cart.id, 'locked')

      const created: Order[] = []
      for (const group of groups) {
        audit.record({
          tenantId: group.tenantId,
          conversationId: session.conversationId,
          cartId: cart.id,
          actionType: 'cart.locked',
          amountMinor: group.amountMinor,
          currency: priced.currency,
          outcome: 'ok',
          reasoning: args.reasoning ?? null,
          detail: {
            line_count: group.lineItems.length,
            item_count: group.lines.reduce((sum, line) => sum + line.quantity, 0),
            checkout_id: checkoutId,
            brands_in_checkout: groups.length,
          },
        })
        const order = orders.create({
          tenantId: group.tenantId,
          cartId: cart.id,
          conversationId: session.conversationId,
          checkoutId,
          totalAmountMinor: group.amountMinor,
          currency: priced.currency,
          providerType: group.provider.providerType,
          providerOrderId: null,
          lineItems: group.lineItems,
          status: 'created',
        })
        if (carriedAddress && group.requiresShipping) {
          orders.setShippingAddress(group.tenantId, order.id, carriedAddress)
        }
        created.push(order)
      }
      return created
    })

    /*
     * Now the providers, one per brand.
     *
     * If any call fails the whole checkout is unwound: every order staged
     * above is cancelled and the cart handed back intact. Leaving one brand
     * payable and another failed would present a customer with half a purchase
     * and no way to reason about it.
     */
    type Handle = Awaited<
      ReturnType<(typeof groups)[number]['provider']['adapter']['createPaymentOrder']>
    >
    const handles: { order: Order; group: (typeof groups)[number]; handle: Handle }[] = []
    for (const [index, group] of groups.entries()) {
      const order = staged[index]!
      try {
        const handle = await group.provider.adapter.createPaymentOrder(group.provider.credentials, {
          amountMinor: group.amountMinor,
          currency: priced.currency,
          receipt: order.id,
          lines: group.lineItems.map((line) => ({
            productId: line.productId,
            name: line.name,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor,
            lineTotalMinor: line.lineTotalMinor,
          })),
          notes: { checkout: checkoutId },
        })

        // A provider that acknowledges a different amount is refused outright.
        if (handle.amountMinor !== group.amountMinor) {
          throw new ProviderApiError('The payment provider acknowledged a different amount.')
        }
        handles.push({ order, group, handle })
      } catch (error) {
        const reason =
          error instanceof ProviderConfigError
            ? `${group.brandName}’s payment provider is not configured correctly.`
            : error instanceof ProviderApiError
              ? `${group.brandName}’s payment provider could not start this payment.`
              : `The payment for ${group.brandName} could not be started.`
        transaction(() => {
          carts.setStatus(cart.id, 'open')
          for (const stagedOrder of staged) {
            orders.setStatus(stagedOrder.tenantId, stagedOrder.id, 'failed', {
              failureReason: reason,
            })
            audit.record({
              tenantId: stagedOrder.tenantId,
              conversationId: session.conversationId,
              cartId: cart.id,
              orderId: stagedOrder.id,
              actionType: 'payment.attempted',
              amountMinor: stagedOrder.totalAmountMinor,
              currency: priced.currency,
              outcome: 'failed',
              reasoning: args.reasoning ?? null,
              detail: { provider: stagedOrder.providerType, reason, checkout_id: checkoutId },
            })
          }
        })
        log.warn('checkout failed at the provider', {
          tenantId: group.tenantId,
          checkoutId,
          provider: group.provider.providerType,
          message: error instanceof Error ? error.message : 'unknown',
        })
        return failed(
          `${reason} Nothing has been charged and the cart is unchanged. Tell the customer ` +
            'plainly and offer to try again.',
        )
      }
    }

    transaction(() => {
      for (const { order, group, handle } of handles) {
        orders.setStatus(group.tenantId, order.id, 'awaiting_payment')
        orders.setProviderOrderId(group.tenantId, order.id, handle.providerOrderId)
        audit.record({
          tenantId: group.tenantId,
          conversationId: session.conversationId,
          cartId: cart.id,
          orderId: order.id,
          actionType: 'order.created',
          amountMinor: group.amountMinor,
          currency: priced.currency,
          outcome: 'ok',
          reasoning: args.reasoning ?? null,
          detail: {
            provider: group.provider.providerType,
            provider_order_id: handle.providerOrderId,
            mock: handle.isMock,
            checkout_id: checkoutId,
          },
        })
      }
    })

    const note = args.note ? sanitizeNote(args.note) : null
    const split =
      groups.length === 1
        ? ''
        : ` The cart spans ${groups.length} brands, so it is ${groups.length} separate orders, ` +
          'each paid to that brand. Say so plainly in one sentence — a customer seeing two ' +
          'charges should have been told to expect two.'

    return ok(
      `Checkout ${checkoutId} is staged for ${formatMoney(totalMinor, priced.currency)} across ` +
        `${groups.length} order${groups.length === 1 ? '' : 's'} and the payment panel is open. ` +
        'Totals were recomputed from catalogue prices server-side; state no amount of your own. ' +
        `Nothing is paid until confirm_payment succeeds.${split}`,
      [
        {
          component: 'checkout',
          payload: {
            checkout_id: checkoutId,
            currency: priced.currency,
            total_minor: totalMinor,
            total_display: formatMoney(totalMinor, priced.currency),
            item_count: priced.itemCount,
            note,
            requires_address: needsShipping,
            // Already attached, not merely suggested: present means these
            // orders can be paid for as they stand.
            shipping_address: carriedAddress,
            // Everywhere this customer has had something sent, so a second
            // purchase is a choice from a list rather than a form.
            saved_addresses: needsShipping
              ? orders.savedShippingAddresses(session.conversationId)
              : [],
            orders: handles.map(({ order, group, handle }) => ({
              order_id: order.id,
              brand_name: group.brandName,
              status: 'awaiting_payment',
              requires_address: group.requiresShipping,
              total_minor: group.amountMinor,
              total_display: formatMoney(group.amountMinor, priced.currency),
              lines: group.lineItems.map((line) => ({
                product_id: line.productId,
                name: line.name,
                quantity: line.quantity,
                unit_price_display: formatMoney(line.unitPriceMinor, priced.currency),
                line_total_display: formatMoney(line.lineTotalMinor, priced.currency),
              })),
              payment: {
                provider: handle.provider,
                provider_label: group.provider.adapter.displayName,
                provider_order_id: handle.providerOrderId,
                public_key: handle.publicKey,
                is_mock: handle.isMock,
                amount_minor: handle.amountMinor,
                currency: handle.currency,
              },
            })),
          },
        },
      ],
    )
  })
}

/** The distinct brands in a set of priced lines, in first-seen order. */
function brandsOf(lines: PricedLine[]): string[] {
  return [...new Set(lines.map((line) => line.tenantId))]
}

function sumOf(lines: PricedLine[]): number {
  return lines.reduce((sum, line) => sum + line.lineTotalMinor, 0)
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
  // The conversation is the authorisation. A shopper does not know which brand
  // an order belongs to, and should not have to — but they cannot confirm one
  // that did not come out of their own thread.
  const order = orders.forCustomer(session.conversationId, orderId)
  if (!order) return failed('No such order for this conversation.')
  if (order.status === 'paid') {
    return ok(`Order ${order.id} is already paid.`, [orderConfirmationComponent(order.id, order)])
  }
  if (order.status === 'cancelled') {
    return ok(
      `Order ${order.id} was cancelled or replaced by a newer one, so it cannot be paid. ` +
        'Tell the customer nothing was charged and offer to check out again.',
      [
        {
          component: 'payment_failed',
          payload: {
            order_id: order.id,
            reason:
              order.failureReason ?? 'This order was replaced by a newer one and cannot be paid.',
            total_display: formatMoney(order.totalAmountMinor, order.currency),
          },
        },
      ],
    )
  }

  /*
   * Nothing gets marked paid without somewhere to send it.
   *
   * Enforced here rather than by the form, because the form is a suggestion —
   * it runs in a browser the customer controls. An order that reaches "paid"
   * with no address is money taken for a parcel nobody can post.
   */
  const tenant = tenants.byId(order.tenantId)
  if (tenant?.requiresShipping && !order.shippingAddress) {
    audit.record({
      tenantId: order.tenantId,
      conversationId: session.conversationId,
      cartId: order.cartId,
      orderId: order.id,
      actionType: 'checkout.blocked',
      amountMinor: order.totalAmountMinor,
      currency: order.currency,
      outcome: 'blocked',
      reasoning: args.reasoning ?? null,
      detail: { gate: ADDRESS_GATE },
    })
    return held(
      ADDRESS_GATE,
      'This order has no delivery address, so it cannot be paid for. The customer fills that in ' +
        'on the order card; ask them to complete it there rather than typing it in the chat.',
    )
  }

  const { adapter, credentials, providerType } = resolveProvider(order.tenantId)

  audit.record({
    tenantId: order.tenantId,
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
      tenantId: order.tenantId,
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
      orders.setStatus(order.tenantId, order.id, 'failed', {
        failureReason: result.failureReason,
        providerPaymentId: result.providerPaymentId,
      })
      // Only hand the cart back if no sibling brand in this checkout has been
      // paid. Reopening a cart that is half bought would put goods the
      // customer already owns back on their shopping list.
      const siblings = orders.byCheckout(session.conversationId, order.checkoutId)
      if (!siblings.some((sibling) => sibling.status === 'paid')) {
        carts.setStatus(order.cartId, 'open')
      }
      audit.record({
        tenantId: order.tenantId,
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
        tenantId: order.tenantId,
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
      products.reserveStock(order.tenantId, line.productId, line.quantity)
    }
    const updated = orders.setStatus(order.tenantId, order.id, 'paid', {
      providerPaymentId: result.providerPaymentId,
      failureReason: null,
    })
    // The cart is only spent once every brand in the checkout has been paid.
    // With two brands, paying the first must not close the cart the second is
    // still waiting on.
    const siblings = orders.byCheckout(session.conversationId, order.checkoutId)
    if (siblings.every((sibling) => sibling.status === 'paid')) {
      carts.setStatus(order.cartId, 'converted')
    }
    audit.record({
      tenantId: order.tenantId,
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

function orderConfirmationComponent(
  orderId: string,
  order: {
    tenantId: string
    checkoutId: string
    conversationId: string
    totalAmountMinor: number
    currency: string
    lineItems: OrderLineItem[]
    providerPaymentId: string | null
    shippingAddress: ShippingAddress | null
  },
) {
  // A receipt that does not name the seller is not a receipt. With a split
  // checkout the customer gets one of these per brand, and the name is the
  // only thing telling them apart.
  const brandName = tenants.byId(order.tenantId)?.name ?? null

  // What is still owed elsewhere in the same checkout, so the card can say
  // "one more to pay" rather than implying the whole cart is settled.
  const siblings = orders.byCheckout(order.conversationId, order.checkoutId)
  const unpaid = siblings.filter((sibling) => sibling.status !== 'paid')

  return {
    component: 'order_confirmation',
    payload: {
      order_id: orderId,
      status: 'paid',
      brand_name: brandName,
      orders_in_checkout: siblings.length,
      orders_remaining: unpaid.length,
      total_minor: order.totalAmountMinor,
      total_display: formatMoney(order.totalAmountMinor, order.currency),
      currency: order.currency,
      payment_reference: order.providerPaymentId,
      // On the receipt as well as the order card: this is the last moment a
      // customer will look, and the cheapest place to catch a parcel headed
      // to the wrong house.
      shipping_address: order.shippingAddress,
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
