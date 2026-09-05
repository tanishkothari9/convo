/**
 * Resolves a tenant's active provider to an adapter plus its decrypted
 * credentials. This is the only place credentials are decrypted, and the
 * plaintext never leaves the adapter call.
 */
import type { CommerceProviderAdapter } from "./adapter.js";
import { FrappeAdapter } from "./frappe.js";
import { ManualAdapter } from "./manual.js";
import { RazorpayAdapter } from "./razorpay/adapter.js";
import { ShopifyAdapter } from "./shopify.js";
import type { ProviderCredentials } from "./types.js";
import type { ProviderType } from "../domain/types.js";
import { connections } from "../db/repo.js";
import { decryptJson } from "../lib/crypto.js";
import { log } from "../lib/logger.js";

const ADAPTERS: Record<ProviderType, CommerceProviderAdapter> = {
  manual: new ManualAdapter(),
  frappe: new FrappeAdapter(),
  razorpay: new RazorpayAdapter(),
  shopify: new ShopifyAdapter(),
};

export function adapterFor(
  providerType: ProviderType,
): CommerceProviderAdapter {
  const adapter = ADAPTERS[providerType];
  if (!adapter)
    throw new Error(`No adapter registered for provider "${providerType}".`);
  return adapter;
}

export function listAdapters(): CommerceProviderAdapter[] {
  return Object.values(ADAPTERS);
}

export interface ResolvedProvider {
  providerType: ProviderType;
  adapter: CommerceProviderAdapter;
  credentials: ProviderCredentials;
}

/**
 * Who takes the money.
 *
 * This is what the money gate calls, so it must never resolve to a provider
 * that cannot process a payment — a brand on Shopify falls back to the
 * built-in processor rather than to an adapter that would throw at checkout.
 */
export function resolveProvider(tenantId: string): ResolvedProvider {
  const connection = connections.activePayment(tenantId);
  const providerType: ProviderType =
    connection && adapterFor(connection.providerType).capabilities.payment
      ? connection.providerType
      : "manual";
  return {
    providerType,
    adapter: adapterFor(providerType),
    credentials: credentialsFor(tenantId, providerType),
  };
}

/** Where the catalogue is synced from. */
export function resolveCatalogProvider(tenantId: string): ResolvedProvider {
  const connection = connections.activeCatalog(tenantId);
  const providerType: ProviderType = connection?.providerType ?? "manual";
  return {
    providerType,
    adapter: adapterFor(providerType),
    credentials: credentialsFor(tenantId, providerType),
  };
}

export function credentialsFor(
  tenantId: string,
  providerType: ProviderType,
): ProviderCredentials {
  const packed = connections.secretFor(tenantId, providerType);
  if (!packed) return {};
  try {
    return decryptJson<ProviderCredentials>(packed);
  } catch {
    // A credential that will not decrypt is treated as absent, never as an
    // outage: the tenant reconnects. The blob itself is never logged.
    log.warn("provider credentials could not be decrypted", {
      tenantId,
      providerType,
    });
    return {};
  }
}
