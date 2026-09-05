import type { CommerceProviderAdapter } from "./adapter.js";
import {
  ProviderApiError,
  ProviderConfigError,
  type CatalogItem,
  type PaymentOrderHandle,
  type PaymentResult,
  type ProviderCredentials,
} from "./types.js";

/**
 * Shopify as a catalogue source.
 *
 * Catalogue only, and deliberately so: Shopify's checkout belongs to Shopify,
 * and a customer buying inside a Convo conversation is not in it. So a brand on
 * Shopify pairs it with a payment provider — which is what the split between
 * catalogue source and payment processor in `provider_connections` exists for.
 *
 * Endpoints and field names follow Shopify's Admin REST API:
 *   GET /admin/api/{version}/products.json     (X-Shopify-Access-Token)
 * A product carries `variants[]` with `price` as a decimal *string* and
 * `inventory_quantity` as a number, and `images[].src`.
 */

const API_VERSION = "2024-10";

interface ShopifyImage {
  id: number;
  src: string;
  position: number;
}

interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  sku: string | null;
  inventory_quantity: number;
  position: number;
}

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  status: "active" | "archived" | "draft";
  handle: string;
  tags: string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
}

export interface ShopifyCredentials extends ProviderCredentials {
  shop?: string;
  accessToken?: string;
}

/**
 * Normalises whatever a merchant pasted into a shop subdomain.
 *
 * This is the SSRF boundary. The shop name becomes a hostname Convo's server
 * connects to, so it is restricted to a single label under myshopify.com — no
 * scheme, no path, no port, no other host. Without this, "shop" could be an
 * internal address and the sync would be a request forgery.
 */
export function normaliseShopDomain(raw: string): string {
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const withoutSuffix = trimmed.replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(withoutSuffix)) {
    throw new ProviderConfigError(
      'That does not look like a Shopify store name. Use the subdomain from your admin URL, for example "smart-choice" from smart-choice.myshopify.com.',
    );
  }
  return `${withoutSuffix}.myshopify.com`;
}

export class ShopifyAdapter implements CommerceProviderAdapter {
  readonly type = "shopify";
  readonly displayName = "Shopify";
  readonly capabilities = { catalog: true, payment: false };

  private async request<T>(
    credentials: ShopifyCredentials,
    path: string,
  ): Promise<T> {
    const shop = normaliseShopDomain(credentials.shop ?? "");
    const token = credentials.accessToken?.trim();
    if (!token)
      throw new ProviderConfigError("Shopify needs an Admin API access token.");

    let response: Response;
    try {
      response = await fetch(
        `https://${shop}/admin/api/${API_VERSION}${path}`,
        {
          headers: {
            "X-Shopify-Access-Token": token,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch (cause) {
      throw new ProviderApiError(
        `Could not reach ${shop} (${cause instanceof Error ? cause.message : "network error"}).`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderApiError(
        "Shopify rejected that access token. Check it has read_products scope.",
        response.status,
      );
    }
    if (!response.ok) {
      throw new ProviderApiError(
        `Shopify returned ${response.status}.`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  async verifyCredentials(
    credentials: ShopifyCredentials,
  ): Promise<{ ok: true; detail: string }> {
    const shop = normaliseShopDomain(credentials.shop ?? "");
    const result = await this.request<{ products: ShopifyProduct[] }>(
      credentials,
      "/products.json?limit=1",
    );
    return {
      ok: true,
      detail: `Connected to ${shop}. ${
        result.products.length === 0
          ? "No products published yet."
          : "Products API responding."
      }`,
    };
  }

  async fetchCatalog(credentials: ShopifyCredentials): Promise<CatalogItem[]> {
    const collected: ShopifyProduct[] = [];
    // Cursor pagination would need the Link header; for a first sync, four
    // pages of 250 is 1,000 products, which is past the point where a merchant
    // should be paginating through Convo rather than pushing to /v1/products.
    for (let page = 0; page < 4; page += 1) {
      const result = await this.request<{ products: ShopifyProduct[] }>(
        credentials,
        `/products.json?limit=250&since_id=${collected.at(-1)?.id ?? 0}`,
      );
      collected.push(...result.products);
      if (result.products.length < 250) break;
    }

    return collected
      .filter((product) => product.status === "active")
      .map((product) => {
        // Convo's catalogue is flat, so a product with several variants is
        // represented by its first purchasable one, and the variant count is
        // surfaced as an attribute rather than silently dropped.
        const variant = product.variants[0];
        const price = Number(variant?.price ?? "0");
        const tags = product.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);

        return {
          providerNativeId: String(product.id),
          name: product.title,
          description: stripHtml(product.body_html ?? ""),
          priceMinor: Number.isFinite(price) ? Math.round(price * 100) : 0,
          currency: "INR",
          images: product.images
            .sort((a, b) => a.position - b.position)
            .map((image) => image.src)
            .filter(
              (src) =>
                /^https:\/\//i.test(src) && !/\.svgz?($|[?#])/i.test(src),
            )
            .slice(0, 6),
          stock: Math.max(0, variant?.inventory_quantity ?? 0),
          category: product.product_type || null,
          attributes: {
            ...(product.vendor ? { Brand: product.vendor } : {}),
            ...(variant?.sku ? { SKU: variant.sku } : {}),
            ...(product.variants.length > 1
              ? { Variants: `${product.variants.length} available in store` }
              : {}),
            ...(tags.length > 0 ? { Tags: tags.slice(0, 6).join(", ") } : {}),
          },
        };
      });
  }

  async createPaymentOrder(): Promise<PaymentOrderHandle> {
    throw new ProviderConfigError(
      "Shopify supplies the catalogue only. Connect a payment provider to take payment in the conversation.",
    );
  }

  async verifyPayment(): Promise<PaymentResult> {
    throw new ProviderConfigError(
      "Shopify does not process payments for Convo.",
    );
  }
}

/** Shopify descriptions are HTML; the agent and the cards want plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}
