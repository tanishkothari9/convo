/**
 * The public shop: everything a customer's browser talks to.
 *
 * One surface for every brand. No authentication — a customer is anonymous.
 * Identity is the unguessable customer session id in an httpOnly cookie,
 * minted here and never accepted from a request body, so one customer's
 * conversation, cart, and orders are not reachable from another's.
 *
 * Order routes take an order id and prove ownership with the conversation, not
 * with a brand: a shopper does not know which brand an order belongs to, and a
 * cart spanning two brands produces two orders they are equally entitled to.
 */
import { Router, type Request, type Response } from 'express'
import {
  audit,
  carts,
  conversations,
  messages as messageStore,
  orders,
  products,
  tenants,
} from '../db/repo.js'
import { badRequest, notFound, requireString, route } from '../lib/http.js'
import { limiters } from '../lib/ratelimit.js'
import { RateLimitError } from '../lib/security.js'
import { token } from '../lib/ids.js'
import { formatMoney } from '../lib/money.js'
import { env } from '../env.js'
import { log } from '../lib/logger.js'
import { runTurn, type TurnEvent } from '../agent/loop.js'
import { ensureSession, priceCart } from '../agent/storefront.js'
import { gatedConfirmPayment } from '../agent/gates.js'
import { mockRazorpay } from '../commerce/razorpay/mock.js'
import { signManualPayment } from '../commerce/manual.js'
import { resolveProvider } from '../commerce/registry.js'
import { AddressError, readAddress } from '../domain/address.js'
import type { Order, Product } from '../domain/types.js'

export const shopRoutes = Router()

const CUSTOMER_COOKIE = 'convo_customer'

/** The shop's settlement currency. One marketplace, one currency, for now. */
const CURRENCY = 'INR'

/** The customer's session id, minted on first contact. */
function customerSession(req: Request, res: Response): string {
  const existing = req.cookies?.[CUSTOMER_COOKIE]
  if (typeof existing === 'string' && existing.length >= 20) return existing
  const fresh = token()
  res.cookie(CUSTOMER_COOKIE, fresh, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    maxAge: 30 * 86_400_000,
    path: '/',
  })
  return fresh
}

/** An order in this customer's own conversation, or a 404. */
function ownOrder(conversationId: string, orderId: string): Order {
  const order = orders.forCustomer(conversationId, orderId)
  if (!order) throw notFound('No such order.')
  return order
}

/** The shop's front: what is on the shelf and who is selling it. */
shopRoutes.get(
  '/shop',
  route(async (_req, res) => {
    const catalog = products.listedAcrossBrands()
    const brands = [...new Set(catalog.map((p) => p.brandName))]
    res.json({
      shop: { name: 'Convo', currency: CURRENCY },
      brands,
      brandCount: brands.length,
      catalogSize: catalog.length,
      categories: [...new Set(catalog.map((p) => p.category).filter(Boolean))].slice(0, 8),
      openers: openers(catalog.length, brands.length),
      showcase: showcase(catalog),
    })
  }),
)

/** The transcript so far, so a reload keeps the conversation. */
shopRoutes.get(
  '/shop/history',
  route(async (req, res) => {
    const customerSessionId = customerSession(req, res)
    const conversation = conversations.ensure(customerSessionId)
    const session = ensureSession(customerSessionId, CURRENCY)
    const cart = carts.ensureOpen(conversation.id)

    res.json({
      conversationId: conversation.id,
      messages: messageStore.list(conversation.id).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        components: message.ui ?? [],
        createdAt: message.createdAt,
      })),
      cart: priceCart(session, cart.id),
    })
  }),
)

/** One turn, streamed as server-sent events. */
shopRoutes.post(
  '/shop/message',
  route(async (req, res) => {
    const message = requireString(req.body, 'message', 2000)
    const customerSessionId = customerSession(req, res)

    /*
     * Every request here runs a model turn, so this is the endpoint that costs
     * real money. It is limited per customer session rather than per IP:
     * customers can share an address behind carrier NAT, and throttling them
     * as one would break the product for a whole city.
     */
    const budget = limiters.chat.take(customerSessionId)
    if (!budget.allowed) {
      res.setHeader('Retry-After', String(budget.retryAfter))
      throw new RateLimitError(budget.retryAfter)
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (event: TurnEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    // The client going away, not the request body finishing. `req`'s close
    // fires as soon as the body is fully received, which is immediately.
    const abort = new AbortController()
    res.on('close', () => abort.abort())

    try {
      for await (const event of runTurn({
        customerSessionId,
        message,
        currency: CURRENCY,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break
        send(event)
      }
    } catch (error) {
      log.error('chat stream failed', {
        message: error instanceof Error ? error.message : 'unknown',
      })
      send({ type: 'error', message: 'Something went wrong. Try again in a moment.' })
    } finally {
      res.end()
    }
  }),
)

/** The cart, for the panel the chat page keeps in sync. */
shopRoutes.get(
  '/shop/cart',
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY)
    const cart = carts.ensureOpen(session.conversationId)
    res.json({ cart: priceCart(session, cart.id) })
  }),
)

// ── payment ─────────────────────────────────────────────────────────────────

/**
 * Confirms a payment.
 *
 * The body carries whatever the provider's checkout handed back. Verification
 * is server-side against the order id Convo holds; nothing here trusts a
 * status the client reports.
 */
shopRoutes.post(
  '/shop/orders/:orderId/confirm',
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY)
    const orderId = req.params.orderId!

    const outcome = await gatedConfirmPayment({
      session,
      orderId,
      payload: (req.body ?? {}) as Record<string, unknown>,
      reasoning: 'customer completed the provider checkout',
    })

    const order = orders.forCustomer(session.conversationId, orderId)
    res.json({
      status: order?.status ?? 'failed',
      failureReason: order?.failureReason ?? null,
      components: outcome.components,
      // What is still owed in the same checkout, so a split card can move
      // straight on to the next brand without a round trip.
      checkout: order ? checkoutState(session.conversationId, order.checkoutId) : null,
      cart: priceCart(session, carts.ensureOpen(session.conversationId).id),
    })
  }),
)

/**
 * Where the order is going.
 *
 * A form rather than the conversation: a model parsing a free-text address into
 * structured fields gets it subtly wrong in ways nobody notices until a parcel
 * is lost, and this keeps a customer's home address out of the model's context
 * and out of the stored transcript.
 *
 * One submission covers every brand in the checkout. A shopper has one
 * doorstep however many labels they bought from, and asking twice for the same
 * address would be a worse bug than the one the form exists to prevent.
 */
shopRoutes.post(
  '/shop/orders/:orderId/address',
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY)
    const order = ownOrder(session.conversationId, req.params.orderId!)

    if (order.status === 'paid') {
      throw badRequest('This order is already paid; its address cannot be changed.', 'already_paid')
    }
    if (order.status === 'cancelled') {
      throw badRequest('This order was replaced by a newer one.', 'order_cancelled')
    }

    let address
    try {
      address = readAddress(req.body)
    } catch (error) {
      if (error instanceof AddressError) {
        res.status(400).json({ error: error.message, code: 'invalid_address', field: error.field })
        return
      }
      throw error
    }

    for (const sibling of orders.byCheckout(session.conversationId, order.checkoutId)) {
      if (sibling.status === 'paid' || sibling.status === 'cancelled') continue
      if (!tenants.byId(sibling.tenantId)?.requiresShipping) continue
      orders.setShippingAddress(sibling.tenantId, sibling.id, address)
    }
    res.json({ address, checkout: checkoutState(session.conversationId, order.checkoutId) })
  }),
)

/**
 * The customer cancelled at the payment panel. Nothing was charged.
 *
 * Cancels every unpaid order in the checkout, not just the one whose panel was
 * closed: backing out of a two-brand purchase halfway is not a state anyone
 * asked for.
 */
shopRoutes.post(
  '/shop/orders/:orderId/cancel',
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY)
    const order = ownOrder(session.conversationId, req.params.orderId!)
    const siblings = orders.byCheckout(session.conversationId, order.checkoutId)

    for (const sibling of siblings) {
      if (sibling.status !== 'awaiting_payment' && sibling.status !== 'created') continue
      orders.setStatus(sibling.tenantId, sibling.id, 'cancelled', {
        failureReason: 'The customer closed the payment panel.',
      })
      audit.record({
        tenantId: sibling.tenantId,
        conversationId: session.conversationId,
        cartId: sibling.cartId,
        orderId: sibling.id,
        actionType: 'payment.failed',
        amountMinor: sibling.totalAmountMinor,
        currency: sibling.currency,
        outcome: 'failed',
        reasoning: 'customer cancelled at the payment panel',
        detail: { provider: sibling.providerType, reason: 'cancelled by customer' },
      })
    }

    // Hand the cart back only if nothing in this checkout was paid for.
    if (!siblings.some((sibling) => sibling.status === 'paid')) {
      carts.setStatus(order.cartId, 'open')
    }
    res.json({
      status: 'cancelled',
      checkout: checkoutState(session.conversationId, order.checkoutId),
    })
  }),
)

/**
 * Convo's own test checkout panel.
 *
 * Stands in for the provider's hosted widget when a brand is on the mock
 * Razorpay sandbox or the manual provider. It produces exactly the fields the
 * real widget returns, signed with the same HMAC construction, so the
 * verification the server then runs is the production path.
 */
shopRoutes.post(
  '/shop/orders/:orderId/test-pay',
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY)
    const order = ownOrder(session.conversationId, req.params.orderId!)
    if (!order.providerOrderId) throw badRequest('That order has no payment to complete.')

    const outcome = req.body?.outcome === 'failure' ? 'failure' : 'success'
    const { providerType } = resolveProvider(order.tenantId)

    if (providerType === 'razorpay') {
      const settled = mockRazorpay.settle(order.providerOrderId, outcome)
      if ('failure' in settled) {
        res.json({ ok: false, payload: { razorpay_order_id: order.providerOrderId } })
        return
      }
      res.json({
        ok: true,
        payload: {
          razorpay_order_id: order.providerOrderId,
          razorpay_payment_id: settled.paymentId,
          razorpay_signature: settled.signature,
        },
      })
      return
    }

    if (outcome === 'failure') {
      res.json({ ok: false, payload: { order_id: order.providerOrderId } })
      return
    }
    const paymentId = `cvpay_${token().slice(0, 20)}`
    res.json({
      ok: true,
      payload: {
        order_id: order.providerOrderId,
        payment_id: paymentId,
        signature: signManualPayment(order.providerOrderId, paymentId),
      },
    })
  }),
)

/** One order, for the confirmation card after a reload. */
shopRoutes.get(
  '/shop/orders/:orderId',
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY)
    const order = ownOrder(session.conversationId, req.params.orderId!)
    res.json({
      order: {
        id: order.id,
        status: order.status,
        brand_name: tenants.byId(order.tenantId)?.name ?? null,
        total_display: formatMoney(order.totalAmountMinor, order.currency),
        failureReason: order.failureReason,
        shippingAddress: order.shippingAddress,
        lines: order.lineItems,
      },
    })
  }),
)

/**
 * Every order in one checkout.
 *
 * The split card asks for this before offering a pay button, so a stale card
 * further up the transcript cannot charge for something already settled.
 */
shopRoutes.get(
  '/shop/checkouts/:checkoutId',
  route(async (req, res) => {
    const session = ensureSession(customerSession(req, res), CURRENCY)
    const state = checkoutState(session.conversationId, req.params.checkoutId!)
    if (state.orders.length === 0) throw notFound('No such checkout.')
    res.json(state)
  }),
)

function checkoutState(conversationId: string, checkoutId: string) {
  const group = orders.byCheckout(conversationId, checkoutId)
  return {
    checkout_id: checkoutId,
    orders: group.map((order) => ({
      order_id: order.id,
      brand_name: tenants.byId(order.tenantId)?.name ?? null,
      status: order.status,
      total_display: formatMoney(order.totalAmountMinor, order.currency),
      failure_reason: order.failureReason,
      shipping_address: order.shippingAddress,
    })),
    paid: group.filter((order) => order.status === 'paid').length,
    remaining: group.filter(
      (order) => order.status === 'awaiting_payment' || order.status === 'created',
    ).length,
  }
}

function openers(catalogSize: number, brandCount: number): string[] {
  if (catalogSize === 0) return ['What can I buy here?']
  const base = ['Show me what you have', 'Something under ₹5,000']
  return brandCount > 1 ? [...base, 'Which brands are here?'] : [...base, 'What is popular right now']
}

/**
 * The products the shop drifts across its opening screen.
 *
 * Photographed and in stock only — an empty tile or a sold-out item is a worse
 * first impression than a shorter row. Spread across brands and categories, so
 * the marquee shows who is here rather than twelve variations of one thing
 * from whoever happened to upload last.
 */
function showcase(catalog: (Product & { brandName: string })[]) {
  const eligible = catalog.filter((p) => p.images.length > 0 && p.stock > 0)

  const buckets = new Map<string, typeof eligible>()
  for (const product of eligible) {
    const key = `${product.tenantId} ${product.category ?? ''}`
    buckets.set(key, [...(buckets.get(key) ?? []), product])
  }

  const spread: typeof eligible = []
  const lists = [...buckets.values()]
  for (let round = 0; spread.length < 12; round += 1) {
    let added = false
    for (const bucket of lists) {
      const product = bucket[round]
      if (!product) continue
      spread.push(product)
      added = true
      if (spread.length === 12) break
    }
    if (!added) break
  }

  return spread.map((product) => ({
    id: product.id,
    name: product.name,
    brand_name: product.brandName,
    price_display: formatMoney(product.priceMinor, CURRENCY),
    image_url: product.images[0] ?? null,
    in_stock: product.stock > 0,
  }))
}
