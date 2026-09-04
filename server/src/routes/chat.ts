/**
 * The public chat surface: everything a customer's browser talks to.
 *
 * No authentication — a customer is anonymous. Identity is the unguessable
 * customer session id in an httpOnly cookie, minted here and never accepted
 * from a request body, so one customer's conversation, cart, and orders are
 * not reachable from another's.
 */
import { Router, type Request, type Response } from 'express'
import { carts, conversations, messages as messageStore, orders, products, tenants } from '../db/repo.js'
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
import type { Product, Tenant } from '../domain/types.js'

export const chatRoutes = Router()

const CUSTOMER_COOKIE = 'convo_customer'

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

function tenantBySlug(slug: string): Tenant {
  const tenant = tenants.bySlug(slug)
  if (!tenant) throw notFound('No brand at that link.')
  return tenant
}

/** The brand's public face: name, voice, accent, and whether it has a catalogue. */
chatRoutes.get(
  '/chat/:slug',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const catalog = products.list(tenant.id)
    res.json({
      brand: {
        name: tenant.name,
        slug: tenant.slug,
        description: tenant.description,
        assistantName: tenant.assistantName || `${tenant.name} Assistant`,
        accentColor: tenant.accentColor,
        currency: tenant.currency,
      },
      catalogSize: catalog.length,
      categories: [...new Set(catalog.map((p) => p.category).filter(Boolean))].slice(0, 8),
      openers: openers(catalog.length),
      showcase: showcase(catalog, tenant.currency),
    })
  }),
)

/** The transcript so far, so a reload keeps the conversation. */
chatRoutes.get(
  '/chat/:slug/history',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const customerSessionId = customerSession(req, res)
    const conversation = conversations.ensure(tenant.id, customerSessionId)
    const session = ensureSession(tenant.id, customerSessionId, tenant.currency)
    const cart = carts.ensureOpen(tenant.id, conversation.id)

    res.json({
      conversationId: conversation.id,
      messages: messageStore
        .list(tenant.id, conversation.id)
        .map((message) => ({
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
chatRoutes.post(
  '/chat/:slug/message',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const message = requireString(req.body, 'message', 2000)
    const customerSessionId = customerSession(req, res)

    /*
     * Every request here runs a model turn, so this is the endpoint that costs
     * real money. It is limited per customer session rather than per IP: a
     * shop's customers can share an address behind carrier NAT, and throttling
     * them as one would break the product for a whole city.
     */
    const budget = limiters.chat.take(`${tenant.id}:${customerSessionId}`)
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
        tenant,
        customerSessionId,
        message,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break
        send(event)
      }
    } catch (error) {
      log.error('chat stream failed', {
        tenantId: tenant.id,
        message: error instanceof Error ? error.message : 'unknown',
      })
      send({ type: 'error', message: 'Something went wrong. Try again in a moment.' })
    } finally {
      res.end()
    }
  }),
)

/** The cart, for the panel the chat page keeps in sync. */
chatRoutes.get(
  '/chat/:slug/cart',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const session = ensureSession(tenant.id, customerSession(req, res), tenant.currency)
    const cart = carts.ensureOpen(tenant.id, session.conversationId)
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
chatRoutes.post(
  '/chat/:slug/orders/:orderId/confirm',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const session = ensureSession(tenant.id, customerSession(req, res), tenant.currency)
    const orderId = req.params.orderId!

    const outcome = await gatedConfirmPayment({
      session,
      orderId,
      payload: (req.body ?? {}) as Record<string, unknown>,
      reasoning: 'customer completed the provider checkout',
    })

    const order = orders.byId(tenant.id, orderId)
    res.json({
      status: order?.status ?? 'failed',
      failureReason: order?.failureReason ?? null,
      components: outcome.components,
      cart: priceCart(session, carts.ensureOpen(tenant.id, session.conversationId).id),
    })
  }),
)

/** The customer cancelled at the payment panel. Nothing was charged. */
chatRoutes.post(
  '/chat/:slug/orders/:orderId/cancel',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const session = ensureSession(tenant.id, customerSession(req, res), tenant.currency)
    const order = orders.byId(tenant.id, req.params.orderId!)
    if (!order || order.conversationId !== session.conversationId) throw notFound('No such order.')

    if (order.status === 'awaiting_payment' || order.status === 'created') {
      orders.setStatus(tenant.id, order.id, 'cancelled', {
        failureReason: 'The customer closed the payment panel.',
      })
      carts.setStatus(tenant.id, order.cartId, 'open')
      const { audit } = await import('../db/repo.js')
      audit.record({
        tenantId: tenant.id,
        conversationId: session.conversationId,
        cartId: order.cartId,
        orderId: order.id,
        actionType: 'payment.failed',
        amountMinor: order.totalAmountMinor,
        currency: order.currency,
        outcome: 'failed',
        reasoning: 'customer cancelled at the payment panel',
        detail: { provider: order.providerType, reason: 'cancelled by customer' },
      })
    }
    res.json({ status: 'cancelled' })
  }),
)

/**
 * Convo's own test checkout panel.
 *
 * Stands in for the provider's hosted widget when a tenant is on the mock
 * Razorpay sandbox or the manual provider. It produces exactly the fields the
 * real widget returns, signed with the same HMAC construction, so the
 * verification the server then runs is the production path.
 */
chatRoutes.post(
  '/chat/:slug/orders/:orderId/test-pay',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const session = ensureSession(tenant.id, customerSession(req, res), tenant.currency)
    const order = orders.byId(tenant.id, req.params.orderId!)
    if (!order || order.conversationId !== session.conversationId) throw notFound('No such order.')
    if (!order.providerOrderId) throw badRequest('That order has no payment to complete.')

    const outcome = req.body?.outcome === 'failure' ? 'failure' : 'success'
    const { providerType } = resolveProvider(tenant.id)

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
chatRoutes.get(
  '/chat/:slug/orders/:orderId',
  route(async (req, res) => {
    const tenant = tenantBySlug(req.params.slug!)
    const session = ensureSession(tenant.id, customerSession(req, res), tenant.currency)
    const order = orders.byId(tenant.id, req.params.orderId!)
    if (!order || order.conversationId !== session.conversationId) throw notFound('No such order.')
    res.json({
      order: {
        id: order.id,
        status: order.status,
        total_display: formatMoney(order.totalAmountMinor, order.currency),
        failureReason: order.failureReason,
        lines: order.lineItems,
      },
    })
  }),
)

function openers(catalogSize: number): string[] {
  if (catalogSize === 0) return ['What do you sell?']
  return ['Show me what you have', 'Something under ₹5,000', 'What is popular right now']
}

/**
 * The products the storefront drifts across its opening screen.
 *
 * Photographed and in stock only — an empty tile or a sold-out item is a worse
 * first impression than a shorter row. Spread across categories so the marquee
 * shows the range rather than twelve variations of one thing.
 */
function showcase(catalog: Product[], currency: string) {
  const eligible = catalog.filter((p) => p.images.length > 0 && p.stock > 0)

  const byCategory = new Map<string, Product[]>()
  for (const product of eligible) {
    const key = product.category ?? ''
    byCategory.set(key, [...(byCategory.get(key) ?? []), product])
  }

  const spread: Product[] = []
  const buckets = [...byCategory.values()]
  for (let round = 0; spread.length < 12; round += 1) {
    let added = false
    for (const bucket of buckets) {
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
    price_display: formatMoney(product.priceMinor, currency),
    image_url: product.images[0] ?? null,
    in_stock: product.stock > 0,
  }))
}
