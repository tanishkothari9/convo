/**
 * The StorefrontBackend interface and Convo's implementation of it.
 *
 * Adapted from `StorefrontBackend` in anthropics/commerce-agents (Apache-2.0):
 * one integration surface the agent talks to, so the agent never reaches into
 * a database or a provider directly. Convo's implementation is backed by its
 * own tenant-scoped tables — which is also where a provider-synced catalog
 * lands — plus the tenant's payment adapter for the money path.
 *
 * Every method takes the session and scopes its reads and writes to that
 * session's tenant. Everything a method returns reaches the model fenced.
 */
import { carts, conversations, orders, products, provenance } from '../db/repo.js'
import type { Order, PricedCart, PricedLine, Product } from '../domain/types.js'
import { transaction } from '../db/index.js'

export interface StorefrontSession {
  tenantId: string
  conversationId: string
  customerSessionId: string
  currency: string
}

export interface SearchFilters {
  category?: string
  minPriceMinor?: number
  maxPriceMinor?: number
  sort?: 'relevance' | 'price_asc' | 'price_desc'
}

/** Raised for something this brand does not offer, as opposed to a fault. */
export class NotOffered extends Error {}

/** Raised for a product that exists but cannot be bought right now. */
export class Unavailable extends Error {
  constructor(
    message: string,
    readonly productId: string,
    readonly availableStock: number,
  ) {
    super(message)
  }
}

export interface StorefrontBackend {
  searchProducts(session: StorefrontSession, query: string, filters: SearchFilters, limit: number): Promise<Product[]>
  getProductDetails(session: StorefrontSession, productId: string): Promise<Product | null>
  getCart(session: StorefrontSession): Promise<PricedCart>
  addToCart(session: StorefrontSession, productId: string, quantity: number): Promise<PricedCart>
  updateCartItem(session: StorefrontSession, productId: string, quantity: number): Promise<PricedCart>
  removeFromCart(session: StorefrontSession, productId: string): Promise<PricedCart>
  getOrders(session: StorefrontSession, limit: number): Promise<Order[]>
}

export class ConvoStorefront implements StorefrontBackend {
  async searchProducts(
    session: StorefrontSession,
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<Product[]> {
    const catalog = products.list(session.tenantId)
    if (catalog.length === 0) {
      throw new NotOffered('This brand has not published a catalogue yet.')
    }

    const withinFilters = catalog.filter((product) => {
      if (filters.category && (product.category ?? '').toLowerCase() !== filters.category.toLowerCase()) {
        return false
      }
      if (filters.minPriceMinor !== undefined && product.priceMinor < filters.minPriceMinor) return false
      if (filters.maxPriceMinor !== undefined && product.priceMinor > filters.maxPriceMinor) return false
      return true
    })

    const terms = tokenize(query)
    const scored = withinFilters
      .map((product) => ({ product, score: relevance(product, terms) }))
      // An empty query, or one whose words are all filler, lists the catalogue.
      .filter(({ score }) => terms.length === 0 || score > 0)

    if (filters.sort === 'price_asc') {
      scored.sort((a, b) => a.product.priceMinor - b.product.priceMinor)
    } else if (filters.sort === 'price_desc') {
      scored.sort((a, b) => b.product.priceMinor - a.product.priceMinor)
    } else {
      // In-stock first, then relevance, then price as a stable tiebreak.
      scored.sort(
        (a, b) =>
          Number(b.product.stock > 0) - Number(a.product.stock > 0) ||
          b.score - a.score ||
          a.product.priceMinor - b.product.priceMinor,
      )
    }

    return scored.slice(0, limit).map(({ product }) => product)
  }

  async getProductDetails(session: StorefrontSession, productId: string): Promise<Product | null> {
    return products.byId(session.tenantId, productId) ?? null
  }

  async getCart(session: StorefrontSession): Promise<PricedCart> {
    const cart = carts.ensureOpen(session.tenantId, session.conversationId)
    return priceCart(session, cart.id)
  }

  async addToCart(session: StorefrontSession, productId: string, quantity: number): Promise<PricedCart> {
    const product = products.byId(session.tenantId, productId)
    if (!product || !product.isActive) {
      throw new Unavailable('That item is no longer in the catalogue.', productId, 0)
    }
    const cart = carts.ensureOpen(session.tenantId, session.conversationId)
    const existing = cart.items.find((item) => item.productId === productId)
    const wanted = (existing?.quantity ?? 0) + quantity
    if (product.stock < wanted) {
      throw new Unavailable(
        product.stock === 0
          ? `${product.id} is out of stock.`
          : `${product.id} has only ${product.stock} left.`,
        productId,
        product.stock,
      )
    }
    carts.addItem(session.tenantId, cart.id, productId, quantity, product.priceMinor)
    return priceCart(session, cart.id)
  }

  async updateCartItem(
    session: StorefrontSession,
    productId: string,
    quantity: number,
  ): Promise<PricedCart> {
    const cart = carts.ensureOpen(session.tenantId, session.conversationId)
    if (quantity > 0) {
      const product = products.byId(session.tenantId, productId)
      if (!product || !product.isActive) {
        throw new Unavailable('That item is no longer in the catalogue.', productId, 0)
      }
      if (product.stock < quantity) {
        throw new Unavailable(
          product.stock === 0
            ? `${product.id} is out of stock.`
            : `${product.id} has only ${product.stock} left.`,
          productId,
          product.stock,
        )
      }
    }
    carts.setQuantity(session.tenantId, cart.id, productId, quantity)
    return priceCart(session, cart.id)
  }

  async removeFromCart(session: StorefrontSession, productId: string): Promise<PricedCart> {
    const cart = carts.ensureOpen(session.tenantId, session.conversationId)
    carts.removeItem(session.tenantId, cart.id, productId)
    return priceCart(session, cart.id)
  }

  async getOrders(session: StorefrontSession, limit: number): Promise<Order[]> {
    return orders.listForConversation(session.tenantId, session.conversationId, limit)
  }
}

/**
 * Joins a cart to live catalogue records and prices it.
 *
 * This is the only function that produces a total, and it reads the price off
 * the catalogue every time — never off the cart row, and never off anything
 * the model said. `checkout` charges what this returns.
 */
export function priceCart(session: StorefrontSession, cartId: string): PricedCart {
  const cart = carts.byId(session.tenantId, cartId)
  if (!cart) {
    return { cartId, currency: session.currency, lines: [], itemCount: 0, subtotalMinor: 0 }
  }
  const catalog = products.byIds(
    session.tenantId,
    cart.items.map((item) => item.productId),
  )
  const byId = new Map(catalog.map((product) => [product.id, product]))

  const lines: PricedLine[] = []
  for (const item of cart.items) {
    const product = byId.get(item.productId)
    if (!product) continue // deleted from the catalogue; it cannot be charged for
    lines.push({
      productId: product.id,
      name: product.name,
      imageUrl: product.images[0] ?? null,
      quantity: item.quantity,
      unitPriceMinor: product.priceMinor,
      lineTotalMinor: product.priceMinor * item.quantity,
      inStock: product.stock >= item.quantity,
      availableStock: product.stock,
      priceChangedSinceAdd: product.priceMinor !== item.unitPriceMinor,
    })
  }

  return {
    cartId,
    currency: session.currency,
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalMinor: lines.reduce((sum, line) => sum + line.lineTotalMinor, 0),
  }
}

/** Records the ids a tool returned, so cart writes and cards can reference them. */
export function rememberSeen(session: StorefrontSession, seen: Product[]): void {
  transaction(() => {
    provenance.remember(
      session.tenantId,
      session.conversationId,
      seen.map((product) => product.id),
    )
  })
}

export function ensureSession(
  tenantId: string,
  customerSessionId: string,
  currency: string,
): StorefrontSession {
  const conversation = conversations.ensure(tenantId, customerSessionId)
  return { tenantId, conversationId: conversation.id, customerSessionId, currency }
}

// ── relevance ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'for', 'from', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or',
  'show', 'some', 'something', 'that', 'the', 'to', 'want', 'with', 'you', 'your', 'featured',
])

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
}

function relevance(product: Product, terms: string[]): number {
  if (terms.length === 0) return 1
  const name = product.name.toLowerCase()
  const category = (product.category ?? '').toLowerCase()
  const description = (product.description ?? '').toLowerCase()
  const attributes = Object.entries(product.attributes)
    .map(([key, value]) => `${key} ${value}`)
    .join(' ')
    .toLowerCase()

  let score = 0
  for (const term of terms) {
    if (name.includes(term)) score += 6
    if (category.includes(term)) score += 4
    if (attributes.includes(term)) score += 3
    if (description.includes(term)) score += 2
    // A near miss on the stem, so "saree" finds "sarees" and vice versa.
    if (score === 0 && term.length > 4 && name.includes(term.slice(0, -1))) score += 3
  }
  return score
}
