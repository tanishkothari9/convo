import type { CommerceProviderAdapter } from "./adapter.js";
import {
  ProviderApiError,
  ProviderConfigError,
  type CatalogItem,
  type PaymentCallbackPayload,
  type PaymentOrderRequest,
  type ProviderCredentials,
} from "./types.js";
import { safeFetch, UnsafeUrlError } from "../lib/safefetch.js";
import { log } from "../lib/logger.js";

/**
 * Frappe / ERPNext, as a catalogue source.
 *
 * Catalogue only — ERPNext is where a merchant's stock and prices live, not
 * where they take card payments. `capabilities.payment` is false, so the money
 * gate skips it entirely and settles through whatever payment provider the
 * brand has connected.
 *
 * Three doctypes, joined here rather than in ERPNext, because Frappe's REST API
 * has no join and asking it for one row per item would be a request per
 * product:
 *
 *   Item        what it is — code, name, description, image, group
 *   Item Price  what it sells for, from the merchant's named price list
 *   Bin         what is actually in the warehouse they sell from
 *
 * Stock comes from `Bin.actual_qty` for one named warehouse, not the total
 * across all of them: ERPNext counts goods in transit, in a rejected bin, and
 * at another branch as stock, and none of that can be posted to a customer.
 * Selling the sum is how you take money for something nobody can ship.
 */

const PAGE = 200;

interface FrappeRow {
  [key: string]: unknown;
}

function credential(
  credentials: ProviderCredentials,
  key: string,
  label: string,
): string {
  const value = credentials[key]?.trim();
  if (!value) throw new ProviderConfigError(`${label} is required.`);
  return value;
}

/** `https://erp.example.com` — trailing slashes and paths trimmed off. */
function baseUrl(credentials: ProviderCredentials): string {
  const raw = credential(credentials, "siteUrl", "The ERPNext site URL");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    throw new ProviderConfigError("That is not a valid ERPNext site URL.");
  }
}

async function call(
  credentials: ProviderCredentials,
  doctype: string,
  params: Record<string, string>,
): Promise<FrappeRow[]> {
  const key = credential(credentials, "apiKey", "The API key");
  const secret = credential(credentials, "apiSecret", "The API secret");
  const search = new URLSearchParams({
    limit_page_length: String(PAGE),
    ...params,
  });
  const url = `${baseUrl(credentials)}/api/resource/${encodeURIComponent(doctype)}?${search}`;

  let response: Response;
  try {
    response = await safeFetch(url, {
      headers: {
        // Frappe's token scheme. Not a bearer token; the colon is required.
        Authorization: `token ${key}:${secret}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    if (error instanceof UnsafeUrlError)
      throw new ProviderConfigError(error.message);
    throw new ProviderApiError("Could not reach that ERPNext site.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderConfigError(
      `ERPNext refused the API key. Check it can read ${doctype}, and that the key is not disabled.`,
    );
  }
  if (!response.ok) {
    throw new ProviderApiError(
      `ERPNext returned ${response.status} for ${doctype}.`,
      response.status,
    );
  }

  const body = (await response.json().catch(() => null)) as {
    data?: FrappeRow[];
  } | null;
  if (!body || !Array.isArray(body.data)) {
    throw new ProviderApiError(
      `ERPNext sent something unreadable for ${doctype}.`,
    );
  }
  return body.data;
}

/** Every page of a doctype, not just the first two hundred rows of it. */
async function callAll(
  credentials: ProviderCredentials,
  doctype: string,
  params: Record<string, string>,
): Promise<FrappeRow[]> {
  const rows: FrappeRow[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = await call(credentials, doctype, {
      ...params,
      limit_start: String(start),
    });
    rows.push(...page);
    if (page.length < PAGE) return rows;
    // A catalogue this large is a misconfiguration, not a shop.
    if (rows.length >= 20_000) return rows;
  }
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

export class FrappeAdapter implements CommerceProviderAdapter {
  readonly type = "frappe";
  readonly displayName = "Frappe / ERPNext";
  readonly capabilities = { catalog: true, payment: false };

  async verifyCredentials(
    credentials: ProviderCredentials,
  ): Promise<{ ok: true; detail: string }> {
    const warehouse = credential(credentials, "warehouse", "The warehouse");
    const priceList = credential(credentials, "priceList", "The price list");

    // One cheap read per doctype: proves the key works and that the warehouse
    // and price list the merchant typed actually exist, which is the mistake
    // they are most likely to make and the one that silently imports nothing.
    const items = await call(credentials, "Item", {
      fields: '["name"]',
      limit_page_length: "1",
    });
    const bins = await call(credentials, "Bin", {
      fields: '["name"]',
      filters: JSON.stringify([["warehouse", "=", warehouse]]),
      limit_page_length: "1",
    });
    const prices = await call(credentials, "Item Price", {
      fields: '["name"]',
      filters: JSON.stringify([["price_list", "=", priceList]]),
      limit_page_length: "1",
    });

    if (bins.length === 0) {
      throw new ProviderConfigError(
        `No warehouse called "${warehouse}" has any stock in it. Check the name matches ERPNext exactly.`,
      );
    }
    if (prices.length === 0) {
      throw new ProviderConfigError(
        `No prices found in a price list called "${priceList}". Check the name matches ERPNext exactly.`,
      );
    }
    return {
      ok: true,
      detail: items.length
        ? `Connected. Selling from ${warehouse} at ${priceList} prices.`
        : `Connected, but there are no items in ERPNext yet.`,
    };
  }

  async fetchCatalog(credentials: ProviderCredentials): Promise<CatalogItem[]> {
    const warehouse = credential(credentials, "warehouse", "The warehouse");
    const priceList = credential(credentials, "priceList", "The price list");
    const currency = (credentials.currency ?? "INR").toUpperCase();

    const [items, prices, bins] = await Promise.all([
      callAll(credentials, "Item", {
        fields:
          '["item_code","item_name","description","image","item_group","disabled"]',
        filters: JSON.stringify([["disabled", "=", 0]]),
      }),
      callAll(credentials, "Item Price", {
        fields: '["item_code","price_list_rate"]',
        filters: JSON.stringify([["price_list", "=", priceList]]),
      }),
      callAll(credentials, "Bin", {
        fields: '["item_code","actual_qty"]',
        filters: JSON.stringify([["warehouse", "=", warehouse]]),
      }),
    ]);

    const rateFor = new Map<string, number>();
    for (const row of prices) {
      const code = str(row.item_code);
      if (code) rateFor.set(code, num(row.price_list_rate));
    }
    const stockFor = new Map<string, number>();
    for (const row of bins) {
      const code = str(row.item_code);
      if (code) stockFor.set(code, num(row.actual_qty));
    }

    const catalog: CatalogItem[] = [];
    let unpriced = 0;
    for (const row of items) {
      const code = str(row.item_code);
      if (!code) continue;
      const rate = rateFor.get(code);
      // An item with no row in the chosen price list has no selling price, and
      // importing it at zero would put a free product on the shelf.
      if (rate === undefined || rate <= 0) {
        unpriced += 1;
        continue;
      }
      const image = str(row.image);
      catalog.push({
        providerNativeId: code,
        name: str(row.item_name) ?? code,
        description: str(row.description),
        priceMinor: Math.round(rate * 100),
        currency,
        images: image ? [absoluteImage(credentials, image)] : [],
        // Missing Bin row means the warehouse has never held it: zero, not
        // unknown. The stock gate then refuses to sell it, which is right.
        stock: Math.max(0, Math.floor(stockFor.get(code) ?? 0)),
        category: str(row.item_group),
        attributes: {},
      });
    }

    if (unpriced > 0) {
      log.warn("frappe items skipped for having no price", {
        priceList,
        unpriced,
      });
    }
    return catalog;
  }

  async createPaymentOrder(
    _credentials: ProviderCredentials,
    _request: PaymentOrderRequest,
  ): Promise<never> {
    throw new ProviderConfigError(
      "ERPNext is a catalogue source here, not a payment processor.",
    );
  }

  async verifyPayment(
    _credentials: ProviderCredentials,
    _payload: PaymentCallbackPayload,
  ): Promise<never> {
    throw new ProviderConfigError(
      "ERPNext is a catalogue source here, not a payment processor.",
    );
  }
}

/** ERPNext stores uploads as `/files/x.png`; the shelf needs a real URL. */
function absoluteImage(
  credentials: ProviderCredentials,
  image: string,
): string {
  if (/^https?:\/\//i.test(image)) return image;
  return `${baseUrl(credentials)}${image.startsWith("/") ? "" : "/"}${image}`;
}
