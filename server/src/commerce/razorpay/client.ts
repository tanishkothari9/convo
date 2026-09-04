/**
 * A thin Razorpay REST client.
 *
 * Endpoints, parameters, and response shapes follow Razorpay's published API:
 *   POST /v1/orders          https://razorpay.com/docs/api/orders/create/
 *   GET  /v1/items           https://razorpay.com/docs/api/payments/invoices/fetch-all-items/
 *   GET  /v1/payments/:id    https://razorpay.com/docs/api/payments/fetch-payment/
 * Auth is HTTP Basic with key_id:key_secret. All amounts are in the smallest
 * currency sub-unit (paise for INR), which is also how Convo stores money.
 */
import { ProviderApiError } from '../types.js'

export const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1'

/** One item as `GET /v1/items` returns it. */
export interface RazorpayItem {
  id: string
  active: boolean
  name: string
  description: string | null
  amount: number
  unit_amount: number
  currency: string
  type: string
  unit: string | null
  tax_inclusive: boolean
  hsn_code: string | null
  sac_code: string | null
  tax_rate: number | null
  tax_id: string | null
  tax_group_id: string | null
  created_at: number
}

export interface RazorpayItemCollection {
  entity: 'collection'
  count: number
  items: RazorpayItem[]
}

/** One order as `POST /v1/orders` returns it. */
export interface RazorpayOrder {
  id: string
  entity: 'order'
  amount: number
  amount_paid: number
  amount_due: number
  currency: string
  receipt: string | null
  offer_id: string | null
  status: 'created' | 'attempted' | 'paid'
  attempts: number
  notes: Record<string, string>
  created_at: number
}

/** The subset of `GET /v1/payments/:id` Convo reads. */
export interface RazorpayPayment {
  id: string
  entity: 'payment'
  amount: number
  currency: string
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
  order_id: string | null
  method: string | null
  captured: boolean
  error_code: string | null
  error_description: string | null
  created_at: number
}

export interface RazorpayApi {
  /** True when this is the mock rather than the live API. */
  readonly isMock: boolean
  fetchItems(params: { count?: number; skip?: number; active?: 1 | 0 }): Promise<RazorpayItemCollection>
  createOrder(body: {
    amount: number
    currency: string
    receipt: string
    notes?: Record<string, string>
  }): Promise<RazorpayOrder>
  fetchOrder(orderId: string): Promise<RazorpayOrder>
  fetchPayment(paymentId: string): Promise<RazorpayPayment>
}

interface RazorpayErrorBody {
  error?: { code?: string; description?: string; reason?: string }
}

export class LiveRazorpayApi implements RazorpayApi {
  readonly isMock = false
  private readonly authorization: string

  constructor(
    private readonly keyId: string,
    keySecret: string,
    private readonly baseUrl: string = RAZORPAY_API_BASE,
  ) {
    this.authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (cause) {
      // The key never appears in an error message.
      throw new ProviderApiError(
        `Could not reach Razorpay (${cause instanceof Error ? cause.message : 'network error'}).`,
      )
    }

    const text = await response.text()
    if (!response.ok) {
      let description = `Razorpay returned ${response.status}.`
      let code: string | undefined
      try {
        const parsed = JSON.parse(text) as RazorpayErrorBody
        if (parsed.error?.description) description = parsed.error.description
        code = parsed.error?.code
      } catch {
        /* a non-JSON error body; the status line is all we report */
      }
      throw new ProviderApiError(description, response.status, code)
    }

    try {
      return JSON.parse(text) as T
    } catch {
      throw new ProviderApiError('Razorpay returned a response Convo could not read.')
    }
  }

  get publicKeyId(): string {
    return this.keyId
  }

  fetchItems(params: { count?: number; skip?: number; active?: 1 | 0 } = {}) {
    return this.request<RazorpayItemCollection>('GET', '/items', {
      query: { count: params.count ?? 100, skip: params.skip ?? 0, active: params.active },
    })
  }

  createOrder(body: {
    amount: number
    currency: string
    receipt: string
    notes?: Record<string, string>
  }) {
    return this.request<RazorpayOrder>('POST', '/orders', { body })
  }

  fetchOrder(orderId: string) {
    return this.request<RazorpayOrder>('GET', `/orders/${encodeURIComponent(orderId)}`)
  }

  fetchPayment(paymentId: string) {
    return this.request<RazorpayPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`)
  }
}
