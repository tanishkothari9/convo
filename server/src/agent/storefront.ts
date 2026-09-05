/**
 * The StorefrontBackend interface and Convo's implementation of it.
 *
 * Adapted from `StorefrontBackend` in anthropics/commerce-agents (Apache-2.0):
 * one integration surface the agent talks to, so the agent never reaches into
 * a database or a provider directly. Convo's implementation is backed by its
 * own tables — which is also where a provider-synced catalog lands — plus each
 * brand's payment adapter for the money path.
 *
 * The shelf spans brands. Every read goes through `listedAcrossBrands`, which
 * returns only brands that opted in, and every product the agent handles
 * carries the name of the brand that sells it. Everything a method returns
 * reaches the model fenced.
 */
import {
  carts,
  conversations,
  orders,
  products,
  provenance,
} from "../db/repo.js";
import type {
  Order,
  PricedCart,
  PricedLine,
  Product,
} from "../domain/types.js";
import { transaction } from "../db/index.js";

export interface StorefrontSession {
  conversationId: string;
  customerSessionId: string;
  currency: string;
}

/**
 * Does this brand name match what the shopper called it?
 *
 * Compared with the spaces and punctuation stripped from both sides, because
 * people write "Smartchoice" for "Smart Choice" and a plain `includes` says no
 * to that. The failure was not a wrong result, which would have been obvious:
 * the filter matched nothing, the model searched again without it, and the
 * basket came back full of the brand the shopper had just excluded.
 *
 * Matched in both directions so "Kalaa" finds "Kalaa Studio" and "Kalaa Studio
 * jewellery" finds it too.
 */
export function brandMatches(brandName: string, wanted: string): boolean {
  const flatten = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = flatten(brandName);
  const b = flatten(wanted);
  if (a === "" || b === "") return false;
  return a.includes(b) || b.includes(a);
}

/** A catalogue row with the name of the brand that sells it. */
export type ListedProduct = Product & { brandName: string };

export interface SearchFilters {
  category?: string;
  /** A brand name, when the shopper named one. Matched loosely. */
  brand?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  sort?: "relevance" | "price_asc" | "price_desc";
}

/** Raised for something no listed brand offers, as opposed to a fault. */
export class NotOffered extends Error {}

/** Raised for a product that exists but cannot be bought right now. */
export class Unavailable extends Error {
  constructor(
    message: string,
    readonly productId: string,
    readonly availableStock: number,
  ) {
    super(message);
  }
}

export interface StorefrontBackend {
  searchProducts(
    session: StorefrontSession,
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<ListedProduct[]>;
  getProductDetails(
    session: StorefrontSession,
    productId: string,
  ): Promise<ListedProduct | null>;
  getCart(session: StorefrontSession): Promise<PricedCart>;
  addToCart(
    session: StorefrontSession,
    productId: string,
    quantity: number,
  ): Promise<PricedCart>;
  updateCartItem(
    session: StorefrontSession,
    productId: string,
    quantity: number,
  ): Promise<PricedCart>;
  removeFromCart(
    session: StorefrontSession,
    productId: string,
  ): Promise<PricedCart>;
  getOrders(session: StorefrontSession, limit: number): Promise<Order[]>;
}

export class ConvoStorefront implements StorefrontBackend {
  async searchProducts(
    session: StorefrontSession,
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<ListedProduct[]> {
    const catalog = products.listedAcrossBrands();
    if (catalog.length === 0) {
      throw new NotOffered("No brand has published a catalogue yet.");
    }

    const withinFilters = catalog.filter((product) => {
      if (
        filters.category &&
        (product.category ?? "").toLowerCase() !==
          filters.category.toLowerCase()
      ) {
        return false;
      }
      if (filters.brand && !brandMatches(product.brandName, filters.brand)) {
        return false;
      }
      if (
        filters.minPriceMinor !== undefined &&
        product.priceMinor < filters.minPriceMinor
      )
        return false;
      if (
        filters.maxPriceMinor !== undefined &&
        product.priceMinor > filters.maxPriceMinor
      )
        return false;
      return true;
    });

    const terms = tokenize(query);
    const scored = withinFilters
      .map((product) => ({ product, score: relevance(product, terms) }))
      // An empty query, or one whose words are all filler, lists the catalogue.
      .filter(({ score }) => terms.length === 0 || score > 0);

    if (filters.sort === "price_asc") {
      scored.sort((a, b) => a.product.priceMinor - b.product.priceMinor);
    } else if (filters.sort === "price_desc") {
      scored.sort((a, b) => b.product.priceMinor - a.product.priceMinor);
    } else {
      // In-stock first, then relevance, then price as a stable tiebreak.
      scored.sort(
        (a, b) =>
          Number(b.product.stock > 0) - Number(a.product.stock > 0) ||
          b.score - a.score ||
          a.product.priceMinor - b.product.priceMinor,
      );
    }

    // An open browse — no terms, no sort asked for — should show the range on
    // offer, not the cheapest few. Taking one product per brand-and-category
    // in turn puts three labels and three garments in the first row rather
    // than whatever sits at the bottom of the price list. It starts from the
    // filtered list rather than the ranked one, because with no terms the
    // ranking is only the price tiebreak and the merchants' own catalogue
    // order is the better signal.
    if (terms.length === 0 && !filters.sort) {
      const inStockFirst = [...withinFilters]
        .reverse() // the repository returns newest first; merchants added oldest first
        .sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0));
      return spread(inStockFirst, limit);
    }

    /*
     * A keyword search is ranked on relevance and nothing else.
     *
     * It is tempting to interleave brands here too, for fairness. It is the
     * wrong instinct: it promotes a weak match from one shop over a strong
     * match from another, and a shopper who asked for jhumkas would rather see
     * six good jhumkas from one brand than three good ones padded with sarees.
     * Fairness between brands belongs to the open browse, where there is no
     * question being answered to get in the way of it.
     *
     * What the marketplace does need is a floor. With one brand's catalogue a
     * weak match was at worst a near miss; across many it is noise from a shop
     * the customer never asked about. Anything scoring well below the best
     * match is dropped rather than used to fill the row.
     */
    const best = scored[0]?.score ?? 0;
    return scored
      .filter(({ score }) => terms.length === 0 || score * 2.5 >= best)
      .slice(0, limit)
      .map(({ product }) => product);
  }

  async getProductDetails(
    session: StorefrontSession,
    productId: string,
  ): Promise<ListedProduct | null> {
    return products.listedById(productId) ?? null;
  }

  async getCart(session: StorefrontSession): Promise<PricedCart> {
    const cart = carts.ensureOpen(session.customerSessionId);
    return priceCart(session, cart.id);
  }

  async addToCart(
    session: StorefrontSession,
    productId: string,
    quantity: number,
  ): Promise<PricedCart> {
    const product = products.listedById(productId);
    if (!product || !product.isActive) {
      throw new Unavailable(
        "That item is no longer in the catalogue.",
        productId,
        0,
      );
    }
    const cart = carts.ensureOpen(session.customerSessionId);
    const existing = cart.items.find((item) => item.productId === productId);
    const wanted = (existing?.quantity ?? 0) + quantity;
    if (product.stock < wanted) {
      throw new Unavailable(
        product.stock === 0
          ? `${product.id} is out of stock.`
          : `${product.id} has only ${product.stock} left.`,
        productId,
        product.stock,
      );
    }
    carts.addItem(
      cart.id,
      product.tenantId,
      productId,
      quantity,
      product.priceMinor,
    );
    return priceCart(session, cart.id);
  }

  async updateCartItem(
    session: StorefrontSession,
    productId: string,
    quantity: number,
  ): Promise<PricedCart> {
    const cart = carts.ensureOpen(session.customerSessionId);
    if (quantity > 0) {
      const product = products.listedById(productId);
      if (!product || !product.isActive) {
        throw new Unavailable(
          "That item is no longer in the catalogue.",
          productId,
          0,
        );
      }
      if (product.stock < quantity) {
        throw new Unavailable(
          product.stock === 0
            ? `${product.id} is out of stock.`
            : `${product.id} has only ${product.stock} left.`,
          productId,
          product.stock,
        );
      }
    }
    carts.setQuantity(cart.id, productId, quantity);
    return priceCart(session, cart.id);
  }

  async removeFromCart(
    session: StorefrontSession,
    productId: string,
  ): Promise<PricedCart> {
    const cart = carts.ensureOpen(session.customerSessionId);
    carts.removeItem(cart.id, productId);
    return priceCart(session, cart.id);
  }

  async getOrders(session: StorefrontSession, limit: number): Promise<Order[]> {
    return orders.listForCustomer(session.customerSessionId, limit);
  }
}

/**
 * Joins a cart to live catalogue records and prices it.
 *
 * This is the only function that produces a total, and it reads the price off
 * the catalogue every time — never off the cart row, and never off anything
 * the model said. `checkout` charges what this returns.
 */
export function priceCart(
  session: StorefrontSession,
  cartId: string,
): PricedCart {
  const cart = carts.byId(cartId);
  if (!cart) {
    return {
      cartId,
      currency: session.currency,
      lines: [],
      itemCount: 0,
      subtotalMinor: 0,
    };
  }

  const lines: PricedLine[] = [];
  for (const item of cart.items) {
    // Read one at a time rather than in a batch: each line may belong to a
    // different brand, and a product whose brand has since delisted must drop
    // out of the total exactly as a deleted one does.
    const product = products.listedById(item.productId);
    if (!product) continue; // gone from the shelf; it cannot be charged for
    lines.push({
      productId: product.id,
      tenantId: product.tenantId,
      brandName: product.brandName,
      name: product.name,
      imageUrl: product.images[0] ?? null,
      quantity: item.quantity,
      unitPriceMinor: product.priceMinor,
      lineTotalMinor: product.priceMinor * item.quantity,
      inStock: product.stock >= item.quantity,
      availableStock: product.stock,
      priceChangedSinceAdd: product.priceMinor !== item.unitPriceMinor,
    });
  }

  return {
    cartId,
    currency: session.currency,
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalMinor: lines.reduce((sum, line) => sum + line.lineTotalMinor, 0),
  };
}

/** Records the ids a tool returned, so cart writes and cards can reference them. */
export function rememberSeen(
  session: StorefrontSession,
  seen: Product[],
): void {
  transaction(() => {
    provenance.remember(
      session.conversationId,
      seen.map((product) => ({
        productId: product.id,
        tenantId: product.tenantId,
      })),
    );
  });
}

/**
 * The session for one turn, in one of the shopper's chats.
 *
 * `conversationId` must already have been proven to belong to this shopper —
 * routes do that with `conversations.owned` before they get here. It is checked
 * again anyway, because a session built on an unverified thread id is the one
 * mistake in this file that would leak a stranger's transcript, and the check
 * costs a single indexed read.
 */
export function ensureSession(
  customerSessionId: string,
  currency: string,
  conversationId?: string,
): StorefrontSession {
  const conversation =
    (conversationId
      ? conversations.owned(customerSessionId, conversationId)
      : undefined) ?? conversations.ensure(customerSessionId);
  return { conversationId: conversation.id, customerSessionId, currency };
}

/**
 * One from each brand-and-category in turn, until `limit` is reached.
 *
 * `products` arrives in the merchants' own order, which is kept within each
 * bucket: they decided what comes first, and an open "what do you have" is
 * exactly the moment to respect that rather than lead with whatever happens
 * to be cheapest. Bucketing by brand as well as category is what stops one
 * large catalogue from crowding a smaller one off the first row.
 */
function spread(products: ListedProduct[], limit: number): ListedProduct[] {
  const byCategory = new Map<string, ListedProduct[]>();
  for (const product of products) {
    const key = `${product.tenantId}\u0000${product.category ?? ""}`;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(product);
    else byCategory.set(key, [product]);
  }
  const buckets = alternateBrands([...byCategory.entries()]);
  const out: ListedProduct[] = [];
  for (let round = 0; out.length < limit; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      const product = bucket[round];
      if (!product) continue;
      out.push(product);
      added = true;
      if (out.length === limit) return out;
    }
    if (!added) break;
  }
  return out;
}

/**
 * Orders buckets so consecutive ones come from different brands.
 *
 * Without this, a brand carrying five categories fills the whole first row
 * before a brand carrying two gets a look in — the round-robin was over
 * buckets, and buckets clump by brand. Dealing them out one brand at a time
 * makes the first row a fair sample of the shelf, which is the only reason
 * the marketplace is worth opening.
 */
function alternateBrands(
  entries: [string, ListedProduct[]][],
): ListedProduct[][] {
  const byBrand = new Map<string, ListedProduct[][]>();
  for (const [key, bucket] of entries) {
    const brand = key.split("\u0000")[0]!;
    const existing = byBrand.get(brand);
    if (existing) existing.push(bucket);
    else byBrand.set(brand, [bucket]);
  }
  const lanes = [...byBrand.values()];
  const out: ListedProduct[][] = [];
  for (let round = 0; ; round += 1) {
    let added = false;
    for (const lane of lanes) {
      const bucket = lane[round];
      if (!bucket) continue;
      out.push(bucket);
      added = true;
    }
    if (!added) return out;
  }
}

// ── relevance ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "show",
  "some",
  "something",
  "that",
  "the",
  "to",
  "want",
  "with",
  "you",
  "your",
  "featured",
]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

function relevance(product: ListedProduct, terms: string[]): number {
  if (terms.length === 0) return 1;
  const brand = product.brandName.toLowerCase();
  const name = product.name.toLowerCase();
  const category = (product.category ?? "").toLowerCase();
  const description = (product.description ?? "").toLowerCase();
  const attributes = Object.entries(product.attributes)
    .map(([key, value]) => `${key} ${value}`)
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 6;
    // Naming a brand is a strong signal, but weaker than naming the garment:
    // "Smart Choice saree" should lead with sarees, not with everything they
    // sell.
    if (brand.includes(term)) score += 5;
    if (category.includes(term)) score += 4;
    if (attributes.includes(term)) score += 3;
    if (description.includes(term)) score += 2;
    // A near miss on the stem, so "saree" finds "sarees" and vice versa.
    if (score === 0 && term.length > 4 && name.includes(term.slice(0, -1)))
      score += 3;
  }
  return score;
}
