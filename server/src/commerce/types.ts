/**
 * The provider-facing types. These are deliberately provider-neutral: nothing
 * here mentions Razorpay, and an adapter's job is to translate between its own
 * API's shapes and these.
 */

export interface CatalogItem {
  /** The provider's own id for this item. Stored as `provider_native_id`. */
  providerNativeId: string;
  name: string;
  description: string | null;
  /** Integer minor units, matching `currency`. */
  priceMinor: number;
  currency: string;
  images: string[];
  /** Providers without an inventory concept report a sentinel; see the adapter. */
  stock: number;
  category: string | null;
  attributes: Record<string, string>;
}

/** One line the provider is asked to charge for. Amounts are computed by Convo. */
export interface PaymentLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface PaymentOrderRequest {
  /**
   * The authoritative amount, recomputed server-side from catalog prices in
   * agent/gates.ts. An adapter must charge exactly this and never re-derive it.
   */
  amountMinor: number;
  currency: string;
  /** Convo's own order id, sent as the provider's idempotency/receipt key. */
  receipt: string;
  lines: PaymentLine[];
  notes?: Record<string, string>;
}

/**
 * What the frontend needs to open the provider's checkout. Contains no secret:
 * a publishable key at most.
 */
export interface PaymentOrderHandle {
  provider: string;
  /** The provider's order id. */
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  /** Publishable key id, safe to send to the browser. */
  publicKey: string | null;
  /** True when this handle came from the mock provider rather than a live API. */
  isMock: boolean;
  /** Provider-specific extras the checkout widget needs. Never secrets. */
  checkout: Record<string, string | number | null>;
}

/** The client-reported payload handed back after the provider's checkout closes. */
export type PaymentCallbackPayload = Record<string, unknown>;

export interface PaymentResult {
  /** True only when the server verified the provider's signature itself. */
  verified: boolean;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  /** Amount the provider says it captured, when it reports one. */
  capturedAmountMinor: number | null;
  /** Set when verification failed; safe to show a customer. */
  failureReason: string | null;
}

export interface ProviderCredentials {
  [key: string]: string | undefined;
}

/** Raised for a provider misconfiguration the merchant can fix. */
export class ProviderConfigError extends Error {}

/** Raised when the provider API is reachable but refused the call. */
export class ProviderApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly providerCode?: string,
  ) {
    super(message);
  }
}
