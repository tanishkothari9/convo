import type {
  CatalogItem,
  PaymentCallbackPayload,
  PaymentOrderHandle,
  PaymentOrderRequest,
  PaymentResult,
  ProviderCredentials,
} from './types.js'

/**
 * The one integration surface a commerce provider implements.
 *
 * Adding a provider (Shopify, WooCommerce, a generic REST catalog) is these
 * methods and nothing else: no agent code, no route, and no UI changes. The
 * capability flags let a provider do catalog only, payments only, or both.
 *
 * Shaped after the `StorefrontBackend` interface in anthropics/commerce-agents
 * (Apache-2.0), narrowed to the three operations Convo needs from a provider
 * and widened to cover payment, which that blueprint leaves to the host.
 */
export interface CommerceProviderAdapter {
  /** Stable identifier, matching `products.source` and `provider_connections.provider_type`. */
  readonly type: string
  /** Name shown in the dashboard. */
  readonly displayName: string
  readonly capabilities: { catalog: boolean; payment: boolean }

  /**
   * Validates credentials without writing anything — used by the dashboard's
   * "Connect" flow before the connection is saved. Throws ProviderConfigError
   * or ProviderApiError with a message the merchant can act on.
   */
  verifyCredentials(credentials: ProviderCredentials): Promise<{ ok: true; detail: string }>

  /** The provider's catalog, already mapped to Convo's shapes. */
  fetchCatalog(credentials: ProviderCredentials): Promise<CatalogItem[]>

  /**
   * Creates an order with the provider for `request.amountMinor` exactly.
   * The amount arrives already recomputed from catalog prices; an adapter must
   * not accept an amount from anywhere else.
   */
  createPaymentOrder(
    credentials: ProviderCredentials,
    request: PaymentOrderRequest,
  ): Promise<PaymentOrderHandle>

  /**
   * Verifies a completed payment server-side. An adapter returns
   * `verified: true` only after checking the provider's own signature or
   * re-reading the payment from the provider's API — never on the strength of
   * what the client reported.
   */
  verifyPayment(
    credentials: ProviderCredentials,
    payload: PaymentCallbackPayload,
  ): Promise<PaymentResult>
}
