import { Router } from 'express'
import { apiKeys, audit, connections, conversations, orders, products, tenants } from '../db/repo.js'
import { requireAuth, type AuthedRequest } from '../auth/index.js'
import {
  badRequest,
  conflict,
  notFound,
  optionalString,
  requireInt,
  requireString,
  route,
} from '../lib/http.js'
import { slugify } from '../lib/ids.js'
import { toMinor } from '../lib/money.js'
import { env } from '../env.js'
import { mintApiKey } from '../lib/apikeys.js'
import type { Tenant } from '../domain/types.js'
import { log } from '../lib/logger.js'
import { providerStatus } from '../models/index.js'
import type { Product } from '../domain/types.js'

export const catalogRoutes = Router()
catalogRoutes.use(requireAuth)

const tenantOf = (req: unknown) => (req as AuthedRequest).auth.tenant

/** What still stands between this brand and the marketplace shelf. */
function listingReadiness(tenant: Tenant) {
  const blockers: string[] = []
  if (products.list(tenant.id).length === 0) {
    blockers.push('Add at least one product before listing on the marketplace.')
  }
  if (!connections.activePayment(tenant.id)) {
    blockers.push('Connect a payment provider before listing on the marketplace.')
  }
  return { listed: tenant.isListed, blockers }
}

// ── the brand ───────────────────────────────────────────────────────────────

catalogRoutes.get(
  '/overview',
  route(async (req, res) => {
    const tenant = tenantOf(req)
    const catalog = products.list(tenant.id, { includeInactive: true })
    const paid = orders.listForTenant(tenant.id, 200).filter((o) => o.status === 'paid')
    res.json({
      tenant,
      shopUrl: `${env.publicBaseUrl}/shop`,
      listing: listingReadiness(tenant),
      stats: {
        products: catalog.filter((p) => p.isActive).length,
        outOfStock: catalog.filter((p) => p.isActive && p.stock === 0).length,
        conversations: conversations.countForTenant(tenant.id),
        orders: paid.length,
        revenueMinor: orders.revenueMinor(tenant.id),
      },
      provider: connections.active(tenant.id) ?? null,
      model: {
        active: tenant.llmProvider ?? env.llmProvider,
        platformDefault: env.llmProvider,
        providers: providerStatus(),
      },
    })
  }),
)

catalogRoutes.patch(
  '/tenant',
  route(async (req, res) => {
    const tenant = tenantOf(req)
    const patch: Record<string, unknown> = {}

    const name = optionalString(req.body, 'name', 80)
    if (name) patch.name = name

    const rawSlug = optionalString(req.body, 'slug', 60)
    if (rawSlug !== undefined) {
      const slug = slugify(rawSlug)
      if (slug.length < 2) throw badRequest('A link needs at least two characters.', 'bad_slug')
      if (tenants.slugTaken(slug, tenant.id)) throw conflict('That link is taken.', 'slug_taken')
      patch.slug = slug
    }

    const description = optionalString(req.body, 'description', 500)
    if (description !== undefined) patch.description = description

    if (typeof req.body?.requiresShipping === 'boolean') {
      patch.requiresShipping = req.body.requiresShipping
    }

    /*
     * Listing is the brand's decision and nobody else's, but it is refused
     * while the shop would be a dead end: a shopper who finds goods they
     * cannot buy has been failed by Convo, not by the merchant. Delisting is
     * never refused — a brand can always take itself off the shelf.
     */
    if (typeof req.body?.isListed === 'boolean') {
      if (req.body.isListed) {
        const blockers = listingReadiness(tenant).blockers
        if (blockers.length > 0) throw badRequest(blockers[0]!, 'not_ready_to_list')
      }
      patch.isListed = req.body.isListed
    }

    res.json({ tenant: tenants.update(tenant.id, patch) })
  }),
)

// ── products ────────────────────────────────────────────────────────────────

catalogRoutes.get(
  '/products',
  route(async (req, res) => {
    res.json({ products: products.list(tenantOf(req).id, { includeInactive: true }) })
  }),
)

catalogRoutes.post(
  '/products',
  route(async (req, res) => {
    const tenant = tenantOf(req)
    res.status(201).json({ product: products.create({ tenantId: tenant.id, ...readProduct(req.body, tenant.currency) }) })
  }),
)

catalogRoutes.patch(
  '/products/:productId',
  route(async (req, res) => {
    const tenant = tenantOf(req)
    const existing = products.byId(tenant.id, req.params.productId!)
    if (!existing) throw notFound('No such product.')

    const patch: Partial<Product> = {}
    const name = optionalString(req.body, 'name', 160)
    if (name) patch.name = name
    const description = optionalString(req.body, 'description', 2000)
    if (description !== undefined) patch.description = description
    if (req.body?.priceMajor !== undefined) {
      patch.priceMinor = toMinor(requireInt(req.body, 'priceMajor', 0, 10_000_000))
    }
    if (req.body?.stock !== undefined) patch.stock = requireInt(req.body, 'stock', 0, 1_000_000)
    const category = optionalString(req.body, 'category', 60)
    if (category !== undefined) patch.category = category
    if (Array.isArray(req.body?.images)) {
      patch.images = readImages(req.body.images)
    }
    if (req.body?.attributes !== undefined) patch.attributes = readAttributes(req.body.attributes)
    if (typeof req.body?.isActive === 'boolean') patch.isActive = req.body.isActive

    res.json({ product: products.update(tenant.id, existing.id, patch) })
  }),
)

catalogRoutes.delete(
  '/products/:productId',
  route(async (req, res) => {
    if (!products.remove(tenantOf(req).id, req.params.productId!)) throw notFound('No such product.')
    res.status(204).end()
  }),
)

// ── API keys ────────────────────────────────────────────────────────────────

catalogRoutes.get(
  '/api-keys',
  route(async (req, res) => {
    res.json({ keys: apiKeys.list(tenantOf(req).id) })
  }),
)

catalogRoutes.post(
  '/api-keys',
  route(async (req, res) => {
    const tenant = tenantOf(req)
    const name = optionalString(req.body, 'name', 60) ?? 'API key'
    const scope = req.body?.scope === 'read' ? 'read' : 'write'

    const live = apiKeys.list(tenant.id).filter((k) => k.revokedAt === null)
    if (live.length >= 10) {
      throw badRequest('You already have 10 active keys. Revoke one first.', 'too_many_keys')
    }

    const minted = mintApiKey()
    const record = apiKeys.create({
      tenantId: tenant.id,
      name,
      keyHash: minted.hash,
      prefix: minted.prefix,
      scope,
    })
    log.info('api key created', { tenantId: tenant.id, keyId: record.id, scope })

    // The only time the secret exists outside the caller's hands.
    res.status(201).json({ key: record, secret: minted.secret })
  }),
)

catalogRoutes.delete(
  '/api-keys/:keyId',
  route(async (req, res) => {
    if (!apiKeys.revoke(tenantOf(req).id, req.params.keyId!)) {
      throw notFound('No such key, or it is already revoked.')
    }
    res.status(204).end()
  }),
)

// ── orders and audit ────────────────────────────────────────────────────────

catalogRoutes.get(
  '/orders',
  route(async (req, res) => {
    res.json({ orders: orders.listForTenant(tenantOf(req).id, 100) })
  }),
)

catalogRoutes.get(
  '/audit',
  route(async (req, res) => {
    res.json({ entries: audit.list(tenantOf(req).id, 300) })
  }),
)

// ── input reading ───────────────────────────────────────────────────────────

function readProduct(body: unknown, currency: string) {
  return {
    name: requireString(body, 'name', 160),
    description: optionalString(body, 'description', 2000) ?? null,
    priceMinor: toMinor(requireInt(body, 'priceMajor', 0, 10_000_000)),
    currency,
    stock: requireInt(body, 'stock', 0, 1_000_000),
    category: optionalString(body, 'category', 60) ?? null,
    images: readImages((body as { images?: unknown })?.images),
    attributes: readAttributes((body as { attributes?: unknown })?.attributes),
  }
}

/**
 * Image URLs, filtered rather than rejected so one bad row does not fail a save.
 *
 * SVG is excluded in both forms. An `<svg>` can carry script, and these URLs
 * are rendered in a customer's browser on a page the merchant controls the
 * content of — which is exactly the shape of a stored XSS. Raster data URLs and
 * https are allowed; plain http only outside production.
 */
export function readImages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((url): url is string => typeof url === 'string' && url.length < 4000)
    .map((url) => url.trim())
    .filter(isSafeImageUrl)
    .slice(0, 6)
}

const RASTER_DATA_URL = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i

export function isSafeImageUrl(url: string): boolean {
  if (/^data:/i.test(url)) return RASTER_DATA_URL.test(url)
  if (/^https:\/\//i.test(url)) return !/\.svgz?($|[?#])/i.test(url)
  // Plain http is for local development only; it would be a mixed-content
  // warning in a customer's browser anyway.
  if (/^http:\/\//i.test(url)) return !env.isProduction && !/\.svgz?($|[?#])/i.test(url)
  return false
}

function readAttributes(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
    if (typeof raw === 'string' && key.length <= 40 && raw.length <= 120) out[key] = raw
  }
  return out
}
