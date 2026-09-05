/**
 * The API client. One place that knows the shape of the wire, so a route
 * change is one edit and every caller gets a typed result.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** Set when the failure belongs to one form field. */
    readonly field?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json" } : {},
    ...init,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = payload as {
      error?: string;
      code?: string;
      detail?: string;
      field?: string;
    } | null;
    throw new ApiError(
      response.status,
      body?.error ?? body?.detail ?? "Something went wrong. Try again.",
      body?.code,
      body?.field,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ── Types shared with the server ────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  currency: string;
  /** False for a brand selling something that does not need delivering. */
  requiresShipping: boolean;
  /** Opt-in. Nothing reaches the marketplace until the brand turns this on. */
  isListed: boolean;
}

export interface TenantUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  images: string[];
  stock: number;
  category: string | null;
  attributes: Record<string, string>;
  source: string;
  providerNativeId: string | null;
  isActive: boolean;
  updatedAt: string;
}

export interface ProviderConnection {
  id: string;
  providerType: "manual" | "razorpay" | "shopify" | "frappe";
  capabilities: string;
  isCatalogSource: boolean;
  isPaymentProcessor: boolean;
  credentialsHint: string | null;
  syncStatus: "never" | "syncing" | "ok" | "error";
  syncError: string | null;
  lastSyncedAt: string | null;
  isActive: boolean;
}

export interface AuditEntry {
  id: string;
  conversationId: string | null;
  cartId: string | null;
  orderId: string | null;
  actionType: string;
  amountMinor: number | null;
  currency: string | null;
  outcome: "ok" | "blocked" | "failed";
  reasoning: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface ShippingAddressRecord {
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface Order {
  id: string;
  totalAmountMinor: number;
  currency: string;
  status: string;
  providerType: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  lineItems: Array<{
    productId: string;
    name: string;
    quantity: number;
    lineTotalMinor: number;
  }>;
  shippingAddress: ShippingAddressRecord | null;
  failureReason: string | null;
  createdAt: string;
}

export interface Overview {
  tenant: Tenant;
  shopUrl: string;
  listing: { listed: boolean; blockers: string[] };
  stats: {
    products: number;
    outOfStock: number;
    conversations: number;
    orders: number;
    revenueMinor: number;
  };
  provider: ProviderConnection | null;
  model: {
    active: string;
    platformDefault: string;
    providers: Array<{ name: string; model: string; available: boolean }>;
  };
}
