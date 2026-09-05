/**
 * The public REST API.
 *
 * This is the door for a brand whose products live in their own system. It is
 * versioned (`/v1`), authenticated with a bearer key, scoped, rate-limited, and
 * addressed by the merchant's own ids so a sync is safe to re-run.
 *
 * Everything here is tenant-scoped by the key that authenticated the request.
 * A key cannot name a tenant, so there is no path by which one brand's key
 * reaches another brand's rows.
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { apiKeys, audit, conversations, orders, products, tenants } from '../db/repo.js'
import { transaction } from '../db/index.js'
import { badRequest, HttpError, notFound, route } from '../lib/http.js'
import { digestsMatch, hashApiKey, readBearer } from '../lib/apikeys.js'
import { limiters } from '../lib/ratelimit.js'
import { RateLimitError } from '../lib/security.js'
import { toMinor } from '../lib/money.js'
import type { Product } from '../domain/types.js'
import { isSafeImageUrl } from './catalog.js'

export const apiRoutes = Router()

interface ApiRequest extends Request {
  api: { tenantId: string; keyId: string; scope: 'read' | 'write' }
}

// ── auth ────────────────────────────────────────────────────────────────────

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const presented = readBearer(req.headers.authorization)
  if (!presented) {
    next(new HttpError(401, 'Provide your API key as `Authorization: Bearer cvo_…`.', 'no_key'))
    return
  }

  const record = apiKeys.byHash(hashApiKey(presented))
  if (!record || !digestsMatch(record.keyHash, hashApiKey(presented))) {
    next(new HttpError(401, 'That API key is not valid, or it has been revoked.', 'bad_key'))
    return
  }

  const limit = limiters.api.take(record.id)
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining))
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter))
    next(new RateLimitError(limit.retryAfter))
    return
  }

  apiKeys.touch(record.id)
  ;(req as ApiRequest).api = { tenantId: record.tenantId, keyId: record.id, scope: record.scope }
  next()
}

function requireWrite(req: Request, _res: Response, next: NextFunction): void {
  if ((req as ApiRequest).api.scope !== 'write') {
    next(new HttpError(403, 'This key is read-only.', 'read_only_key'))
    return
  }
  next()
}

apiRoutes.use(authenticate)

const ctx = (req: Request) => (req as ApiRequest).api

// ── serialisation ───────────────────────────────────────────────────────────

/** The public shape of a product. Internal ids and columns are not exposed. */
function serialize(product: Product) {
  return {
    id: product.id,
    external_id: product.externalId,
    name: product.name,
    description: product.description,
    price: product.priceMinor / 100,
    price_minor: product.priceMinor,
    currency: product.currency,
    images: product.images,
    stock: product.stock,
    category: product.category,
    attributes: product.attributes,
    active: product.isActive,
    source: product.source,
    updated_at: product.updatedAt,
  }
}

// ── input ───────────────────────────────────────────────────────────────────

interface ProductInput {
  name?: string
  description?: string | null
  priceMinor?: number
  images?: string[]
  stock?: number
  category?: string | null
  attributes?: Record<string, string>
  isActive?: boolean
}

/**
 * Reads a product body.
 *
 * Price accepts either `price` in whole currency units or `price_minor` in the
 * smallest unit. Both are offered because inventory systems disagree about
 * which they store, and silently misreading one as the other is a hundredfold
 * pricing error.
 */
function readProduct(body: unknown, { partial }: { partial: boolean }): ProductInput {
  const b = (body ?? {}) as Record<string, unknown>
  const out: ProductInput = {}
  const fail = (field: string, why: string): never => {
    throw badRequest(`\`${field}\` ${why}`, 'invalid_field')
  }

  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || b.name.trim() === '') fail('name', 'must be a non-empty string.')
    if ((b.name as string).length > 160) fail('name', 'must be 160 characters or fewer.')
    out.name = (b.name as string).trim()
  } else if (!partial) {
    fail('name', 'is required.')
  }

  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== 'string') {
      fail('description', 'must be a string or null.')
    }
    const text = b.description === null ? null : String(b.description).trim()
    if (text && text.length > 4000) fail('description', 'must be 4000 characters or fewer.')
    out.description = text
  }

  if (b.price_minor !== undefined) {
    const value = Number(b.price_minor)
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
      fail('price_minor', 'must be a whole number of the smallest currency unit.')
    }
    out.priceMinor = value
  } else if (b.price !== undefined) {
    const value = Number(b.price)
    if (!Number.isFinite(value) || value < 0 || value > 10_000_000) {
      fail('price', 'must be a number between 0 and 10,000,000.')
    }
    out.priceMinor = toMinor(value)
  } else if (!partial) {
    fail('price', 'is required (or send `price_minor`).')
  }

  if (b.stock !== undefined) {
    const value = Number(b.stock)
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
      fail('stock', 'must be a whole number between 0 and 1,000,000.')
    }
    out.stock = value
  } else if (!partial) {
    out.stock = 0
  }

  if (b.category !== undefined) {
    if (b.category !== null && typeof b.category !== 'string') fail('category', 'must be a string or null.')
    out.category = b.category === null ? null : String(b.category).trim().slice(0, 60)
  }

  if (b.images !== undefined) {
    if (!Array.isArray(b.images)) fail('images', 'must be an array of URLs.')
    const urls = (b.images as unknown[]).filter((u): u is string => typeof u === 'string')
    const rejected = urls.filter((u) => !isSafeImageUrl(u.trim()))
    if (rejected.length > 0) {
      throw badRequest(
        `\`images\` contains a URL Convo will not serve: ${rejected[0]!.slice(0, 80)}. Use https, or a base64 png/jpeg/webp data URL. SVG is not accepted.`,
        'unsafe_image_url',
      )
    }
    out.images = urls.map((u) => u.trim()).slice(0, 6)
  }

  if (b.attributes !== undefined) {
    if (b.attributes === null || typeof b.attributes !== 'object' || Array.isArray(b.attributes)) {
      fail('attributes', 'must be an object of string values.')
    }
    const entries = Object.entries(b.attributes as Record<string, unknown>).slice(0, 16)
    const attributes: Record<string, string> = {}
    for (const [key, value] of entries) {
      if (typeof value !== 'string') fail(`attributes.${key}`, 'must be a string.')
      attributes[key.slice(0, 40)] = String(value).slice(0, 200)
    }
    out.attributes = attributes
  }

  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') fail('active', 'must be true or false.')
    out.isActive = b.active as boolean
  }

  return out
}

// ── products ────────────────────────────────────────────────────────────────

apiRoutes.get(
  '/products',
  route(async (req, res) => {
    const { tenantId } = ctx(req)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50))
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0)
    const all = products.list(tenantId, { includeInactive: true })
    res.json({
      object: 'list',
      total: all.length,
      limit,
      offset,
      has_more: offset + limit < all.length,
      data: all.slice(offset, offset + limit).map(serialize),
    })
  }),
)

apiRoutes.get(
  '/products/:id',
  route(async (req, res) => {
    const { tenantId } = ctx(req)
    const found = resolveProduct(tenantId, req.params.id!)
    if (!found) throw notFound('No product with that id.')
    res.json(serialize(found))
  }),
)

apiRoutes.post(
  '/products',
  requireWrite,
  route(async (req, res) => {
    const { tenantId } = ctx(req)
    const tenant = tenants.byId(tenantId)!
    const input = readProduct(req.body, { partial: false })
    const externalId = readExternalId(req.body)

    if (externalId && products.byExternalId(tenantId, externalId)) {
      throw new HttpError(
        409,
        `A product with external_id "${externalId}" already exists. Use PATCH, or POST /v1/products/bulk to upsert.`,
        'duplicate_external_id',
      )
    }

    const product = products.create({
      tenantId,
      externalId,
      name: input.name!,
      description: input.description ?? null,
      priceMinor: input.priceMinor!,
      currency: tenant.currency,
      images: input.images ?? [],
      stock: input.stock ?? 0,
      category: input.category ?? null,
      attributes: input.attributes ?? {},
      source: 'manual',
    })
    res.status(201).json(serialize(product))
  }),
)

apiRoutes.patch(
  '/products/:id',
  requireWrite,
  route(async (req, res) => {
    const { tenantId } = ctx(req)
    const found = resolveProduct(tenantId, req.params.id!)
    if (!found) throw notFound('No product with that id.')
    const input = readProduct(req.body, { partial: true })
    res.json(serialize(products.update(tenantId, found.id, input)!))
  }),
)

apiRoutes.delete(
  '/products/:id',
  requireWrite,
  route(async (req, res) => {
    const { tenantId } = ctx(req)
    const found = resolveProduct(tenantId, req.params.id!)
    if (!found) throw notFound('No product with that id.')
    products.remove(tenantId, found.id)
    res.json({ id: found.id, deleted: true })
  }),
)

/**
 * Bulk upsert — the endpoint a real integration uses.
 *
 * Addressed by `external_id`, so running last night's sync again changes
 * nothing rather than doubling the catalogue. The whole batch is one
 * transaction: a body that is half-valid leaves the catalogue untouched rather
 * than half-updated, which is the behaviour you want at 3am.
 */
apiRoutes.post(
  '/products/bulk',
  requireWrite,
  route(async (req, res) => {
    const { tenantId, keyId } = ctx(req)

    const limit = limiters.apiBulk.take(keyId)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter))
      throw new RateLimitError(limit.retryAfter)
    }

    const body = (req.body ?? {}) as { products?: unknown; deactivate_missing?: unknown }
    if (!Array.isArray(body.products)) {
      throw badRequest('Send `{ "products": [...] }`.', 'invalid_body')
    }
    if (body.products.length === 0) throw badRequest('`products` is empty.', 'invalid_body')
    if (body.products.length > 500) {
      throw badRequest('Send at most 500 products per call.', 'batch_too_large')
    }

    // Validate everything before writing anything.
    const parsed = body.products.map((entry, index) => {
      const externalId = readExternalId(entry)
      if (!externalId) {
        throw badRequest(
          `products[${index}] is missing \`external_id\`. Bulk upsert is addressed by your own id so it can be re-run safely.`,
          'missing_external_id',
        )
      }
      try {
        return { externalId, input: readProduct(entry, { partial: true }) }
      } catch (error) {
        if (error instanceof HttpError) {
          throw badRequest(`products[${index}]: ${error.message}`, error.code)
        }
        throw error
      }
    })

    const seen = new Set<string>()
    for (const { externalId } of parsed) {
      if (seen.has(externalId)) {
        throw badRequest(`\`external_id\` "${externalId}" appears twice in this batch.`, 'duplicate_in_batch')
      }
      seen.add(externalId)
    }

    const result = transaction(() => {
      let created = 0
      let updated = 0
      for (const { externalId, input } of parsed) {
        const outcome = products.upsertByExternalId(tenantId, externalId, input)
        if (outcome.created) created += 1
        else updated += 1
      }

      let deactivated = 0
      if (body.deactivate_missing === true) {
        for (const product of products.list(tenantId)) {
          if (product.externalId && !seen.has(product.externalId)) {
            products.update(tenantId, product.id, { isActive: false })
            deactivated += 1
          }
        }
      }
      return { created, updated, deactivated }
    })

    audit.record({
      tenantId,
      actionType: 'catalog.synced',
      outcome: 'ok',
      detail: { via: 'api', ...result, received: parsed.length },
    })

    res.json({ object: 'bulk_result', received: parsed.length, ...result })
  }),
)

// ── read-only resources ─────────────────────────────────────────────────────

apiRoutes.get(
  '/orders',
  route(async (req, res) => {
    const { tenantId } = ctx(req)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50) || 50))
    res.json({
      object: 'list',
      data: orders.listForTenant(tenantId, limit).map((order) => ({
        id: order.id,
        status: order.status,
        total: order.totalAmountMinor / 100,
        total_minor: order.totalAmountMinor,
        currency: order.currency,
        provider: order.providerType,
        provider_order_id: order.providerOrderId,
        line_items: order.lineItems.map((line) => ({
          product_id: line.productId,
          name: line.name,
          quantity: line.quantity,
          line_total_minor: line.lineTotalMinor,
        })),
        // Null until the customer completes checkout, and never present on an
        // order that was not paid for.
        shipping_address: order.shippingAddress && {
          name: order.shippingAddress.name,
          phone: order.shippingAddress.phone,
          line1: order.shippingAddress.line1,
          line2: order.shippingAddress.line2,
          city: order.shippingAddress.city,
          state: order.shippingAddress.state,
          postal_code: order.shippingAddress.postalCode,
          country: order.shippingAddress.country,
        },
        failure_reason: order.failureReason,
        created_at: order.createdAt,
      })),
    })
  }),
)

apiRoutes.get(
  '/audit',
  route(async (req, res) => {
    const { tenantId } = ctx(req)
    const limit = Math.min(300, Math.max(1, Number(req.query.limit ?? 100) || 100))
    res.json({
      object: 'list',
      data: audit.list(tenantId, limit).map((entry) => ({
        id: entry.id,
        action: entry.actionType,
        outcome: entry.outcome,
        amount_minor: entry.amountMinor,
        currency: entry.currency,
        order_id: entry.orderId,
        reasoning: entry.reasoning,
        detail: entry.detail,
        created_at: entry.createdAt,
      })),
    })
  }),
)

apiRoutes.get(
  '/me',
  route(async (req, res) => {
    const { tenantId, scope } = ctx(req)
    const tenant = tenants.byId(tenantId)!
    res.json({
      brand: { id: tenant.id, name: tenant.name, slug: tenant.slug, currency: tenant.currency },
      scope,
      counts: {
        products: products.list(tenantId).length,
        conversations: conversations.countForTenant(tenantId),
        orders: orders.listForTenant(tenantId, 500).length,
      },
    })
  }),
)

// ── helpers ─────────────────────────────────────────────────────────────────

/** Accepts either Convo's id or the merchant's own, so callers need not map. */
function resolveProduct(tenantId: string, id: string): Product | undefined {
  return products.byId(tenantId, id) ?? products.byExternalId(tenantId, id)
}

function readExternalId(body: unknown): string | null {
  const value = (body as Record<string, unknown> | null)?.external_id
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw badRequest('`external_id` must be a string.', 'invalid_field')
  const trimmed = value.trim()
  if (trimmed.length > 120) throw badRequest('`external_id` is too long.', 'invalid_field')
  return trimmed
}
