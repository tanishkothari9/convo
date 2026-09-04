import { Router } from 'express'
import { audit, connections, conversations, orders, products, tenants } from '../db/repo.js'
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
import { AVAILABLE_PROVIDERS, providerStatus } from '../models/index.js'
import type { Product } from '../domain/types.js'

export const catalogRoutes = Router()
catalogRoutes.use(requireAuth)

const tenantOf = (req: unknown) => (req as AuthedRequest).auth.tenant

// ── the brand ───────────────────────────────────────────────────────────────

catalogRoutes.get(
  '/overview',
  route(async (req, res) => {
    const tenant = tenantOf(req)
    const catalog = products.list(tenant.id, { includeInactive: true })
    const paid = orders.listForTenant(tenant.id, 200).filter((o) => o.status === 'paid')
    res.json({
      tenant,
      chatUrl: `${env.publicBaseUrl}/chat/${tenant.slug}`,
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

    const assistantName = optionalString(req.body, 'assistantName', 60)
    if (assistantName) patch.assistantName = assistantName

    const brandVoice = optionalString(req.body, 'brandVoice', 200)
    if (brandVoice) patch.brandVoice = brandVoice

    const accentColor = optionalString(req.body, 'accentColor', 9)
    if (accentColor) {
      if (!/^#[0-9a-fA-F]{6}$/.test(accentColor)) throw badRequest('Use a hex colour like #6D4AFF.')
      patch.accentColor = accentColor
    }

    if ('llmProvider' in (req.body ?? {})) {
      const requested = req.body.llmProvider
      if (requested === null || requested === '') {
        patch.llmProvider = null
      } else if (typeof requested === 'string' && AVAILABLE_PROVIDERS.includes(requested)) {
        patch.llmProvider = requested
      } else {
        throw badRequest('That is not a model provider Convo knows.', 'bad_provider')
      }
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

/** Only http(s) and data-image URLs; anything else is dropped rather than rejected. */
function readImages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((url): url is string => typeof url === 'string' && url.length < 2000)
    .filter((url) => /^https?:\/\//i.test(url) || /^data:image\//i.test(url))
    .slice(0, 6)
}

function readAttributes(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
    if (typeof raw === 'string' && key.length <= 40 && raw.length <= 120) out[key] = raw
  }
  return out
}
