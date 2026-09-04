import { randomBytes } from 'node:crypto'
import type { CommerceProviderAdapter } from './adapter.js'
import {
  type CatalogItem,
  type PaymentCallbackPayload,
  type PaymentOrderHandle,
  type PaymentOrderRequest,
  type PaymentResult,
  type ProviderCredentials,
} from './types.js'
import { hmacSha256Hex, safeEqualHex } from '../lib/crypto.js'
import { env } from '../env.js'

/**
 * The provider for a brand that types its catalog into the dashboard.
 *
 * Catalog: none to fetch — Convo's own `products` table is the catalog, so
 * `fetchCatalog` returns nothing and the sync path is never invoked.
 *
 * Payment: a self-contained test processor. It issues a real order handle and
 * signs its confirmations with the same HMAC construction a live processor
 * uses, so the server-side verification path a manual tenant exercises is the
 * same code path a Razorpay tenant does. It moves no money and is not a
 * payment method for production; a brand taking real payments connects a
 * payment provider.
 */
export class ManualAdapter implements CommerceProviderAdapter {
  readonly type = 'manual'
  readonly displayName = 'Convo catalogue'
  readonly capabilities = { catalog: true, payment: true }

  async verifyCredentials(): Promise<{ ok: true; detail: string }> {
    return { ok: true, detail: 'Products are managed in the Convo dashboard.' }
  }

  async fetchCatalog(): Promise<CatalogItem[]> {
    return []
  }

  async createPaymentOrder(
    _credentials: ProviderCredentials,
    request: PaymentOrderRequest,
  ): Promise<PaymentOrderHandle> {
    const providerOrderId = `cvorder_${randomBytes(10).toString('hex')}`
    return {
      provider: this.type,
      providerOrderId,
      amountMinor: request.amountMinor,
      currency: request.currency,
      publicKey: null,
      isMock: true,
      checkout: { order_id: providerOrderId, amount: request.amountMinor, currency: request.currency },
    }
  }

  async verifyPayment(
    _credentials: ProviderCredentials,
    payload: PaymentCallbackPayload,
  ): Promise<PaymentResult> {
    const paymentId = typeof payload.payment_id === 'string' ? payload.payment_id : null
    const orderId = typeof payload.expectedOrderId === 'string' ? payload.expectedOrderId : null
    const signature = typeof payload.signature === 'string' ? payload.signature : null

    if (!paymentId || !orderId || !signature) {
      return {
        verified: false,
        providerPaymentId: paymentId,
        providerOrderId: orderId,
        capturedAmountMinor: null,
        failureReason: 'The payment confirmation was incomplete.',
      }
    }

    const expected = signManualPayment(orderId, paymentId)
    if (!safeEqualHex(expected, signature)) {
      return {
        verified: false,
        providerPaymentId: paymentId,
        providerOrderId: orderId,
        capturedAmountMinor: null,
        failureReason: 'The payment signature did not verify.',
      }
    }

    return {
      verified: true,
      providerPaymentId: paymentId,
      providerOrderId: orderId,
      capturedAmountMinor: null,
      failureReason: null,
    }
  }
}

/** Signs a manual-provider confirmation. Used only by Convo's own test checkout route. */
export function signManualPayment(orderId: string, paymentId: string): string {
  return hmacSha256Hex(env.secret, `${orderId}|${paymentId}`)
}
