import { useState } from 'react'
import { api, ApiError } from '../../lib/api'
import type { OrderConfirmationPayload, OrderSummaryPayload } from '../types'
import { PaymentPanel } from './PaymentPanel'

/**
 * The order summary and its payment button.
 *
 * The total shown here is the one the server computed from live catalogue
 * prices at the moment of checkout. It is not something the agent said, and
 * nothing on this page can change it.
 */
export function OrderSummaryCard({
  payload,
  slug,
  onSettled,
  disabled,
}: {
  payload: OrderSummaryPayload
  slug: string
  onSettled(result: { paid: boolean; reason?: string }): void
  disabled: boolean
}) {
  const [paying, setPaying] = useState(false)
  const [state, setState] = useState<'open' | 'paid' | 'failed' | 'cancelled'>('open')
  const [reason, setReason] = useState<string | null>(null)

  async function cancel() {
    setPaying(false)
    setState('cancelled')
    try {
      await api.post(`/chat/${slug}/orders/${payload.order_id}/cancel`)
    } catch {
      /* the order stays awaiting payment; the customer can retry */
    }
    onSettled({ paid: false, reason: 'cancelled' })
  }

  async function confirm(result: Record<string, unknown>) {
    try {
      const response = await api.post<{ status: string; failureReason: string | null }>(
        `/chat/${slug}/orders/${payload.order_id}/confirm`,
        result,
      )
      setPaying(false)
      if (response.status === 'paid') {
        setState('paid')
        onSettled({ paid: true })
      } else {
        setState('failed')
        setReason(response.failureReason ?? 'The payment did not go through.')
        onSettled({ paid: false, reason: response.failureReason ?? undefined })
      }
    } catch (error) {
      setPaying(false)
      setState('failed')
      const message =
        error instanceof ApiError ? error.message : 'The payment could not be confirmed.'
      setReason(message)
      onSettled({ paid: false, reason: message })
    }
  }

  return (
    <div className="order-card">
      <div className="order-head">
        <p className="order-label t-sm t-muted">Your order</p>
        <p className="t-id">{payload.order_id}</p>
      </div>

      <ul className="order-lines">
        {payload.lines.map((line) => (
          <li key={line.product_id} className="order-line">
            <span className="order-line-name">
              {line.name}
              {line.quantity > 1 && <span className="t-muted t-num"> × {line.quantity}</span>}
            </span>
            <span className="t-num">{line.line_total_display}</span>
          </li>
        ))}
      </ul>

      <div className="order-total">
        <span>Total</span>
        <span className="t-num order-total-value">{payload.total_display}</span>
      </div>

      {payload.note && <p className="order-note t-sm t-secondary">{payload.note}</p>}

      {state === 'open' && (
        <>
          <button
            className="btn btn-primary btn-lg btn-block"
            onClick={() => setPaying(true)}
            disabled={disabled}
          >
            Pay {payload.total_display}
          </button>
          <p className="order-fineprint t-xs t-muted">
            Payment happens in {payload.payment.provider_label}&rsquo;s panel. Never type a card
            number, UPI PIN, or OTP into this chat.
          </p>
        </>
      )}

      {state === 'paid' && <p className="notice notice-ok">Paid. Your confirmation is below.</p>}

      {state === 'cancelled' && (
        <div className="order-retry">
          <p className="notice">Payment cancelled. Nothing was charged and your cart is intact.</p>
          <button className="btn btn-secondary btn-block" onClick={() => setState('open')}>
            Try again
          </button>
        </div>
      )}

      {state === 'failed' && (
        <div className="order-retry">
          <p className="notice notice-danger">{reason}</p>
          <button className="btn btn-secondary btn-block" onClick={() => setState('open')}>
            Try again
          </button>
        </div>
      )}

      {paying && (
        <PaymentPanel
          payload={payload}
          slug={slug}
          onCancel={cancel}
          onResult={confirm}
        />
      )}
    </div>
  )
}

export function OrderConfirmationCard({ payload }: { payload: OrderConfirmationPayload }) {
  return (
    <div className="confirm-card">
      <span className="confirm-tick" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M3 8.5L6.5 12L13 4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="confirm-body">
        <p className="confirm-title">Paid — {payload.total_display}</p>
        <p className="t-sm t-secondary">
          {payload.lines.map((line) => line.name).join(', ')}
        </p>
        <dl className="confirm-refs">
          <div>
            <dt className="t-xs t-muted">Order</dt>
            <dd className="t-id">{payload.order_id}</dd>
          </div>
          {payload.payment_reference && (
            <div>
              <dt className="t-xs t-muted">Payment</dt>
              <dd className="t-id">{payload.payment_reference}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}

export function PaymentFailedCard({ payload }: { payload: { order_id: string; reason: string; total_display: string } }) {
  return (
    <div className="failed-card">
      <p className="failed-title">Payment did not go through</p>
      <p className="t-sm">{payload.reason}</p>
      <p className="t-sm t-secondary">
        Nothing has been charged and your cart is exactly as you left it.
      </p>
    </div>
  )
}
