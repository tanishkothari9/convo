import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { OrderSummaryPayload } from '../types'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void; close(): void }
  }
}

interface Props {
  payload: OrderSummaryPayload
  slug: string
  onCancel(): void
  onResult(result: Record<string, unknown>): void
}

/**
 * Where the customer pays.
 *
 * With live Razorpay credentials this hands off to Razorpay's own hosted
 * checkout: Convo never sees a card number, and the three fields the widget
 * returns go straight back to the server to be verified.
 *
 * Without them it renders Convo's test panel, which produces the same three
 * fields, signed with the same HMAC construction — so the verification the
 * server runs afterwards is the production path either way.
 */
export function PaymentPanel({ payload, slug, onCancel, onResult }: Props) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const live = !payload.payment.is_mock && Boolean(payload.payment.public_key)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  // Live Razorpay: open the hosted widget rather than Convo's panel.
  useEffect(() => {
    if (!live) return
    let cancelled = false

    async function open() {
      await loadRazorpayScript()
      if (cancelled || !window.Razorpay) {
        setFailed('The payment window could not be opened. Try again in a moment.')
        return
      }
      const checkout = new window.Razorpay({
        key: payload.payment.public_key,
        order_id: payload.payment.provider_order_id,
        amount: payload.payment.amount_minor,
        currency: payload.payment.currency,
        name: payload.payment.provider_label,
        description: `Order ${payload.order_id}`,
        handler: (response: Record<string, unknown>) => onResult(response),
        modal: { ondismiss: onCancel },
      })
      checkout.open()
    }

    void open()
    return () => {
      cancelled = true
    }
  }, [live, payload, onResult, onCancel])

  async function settle(outcome: 'success' | 'failure') {
    setBusy(true)
    setFailed(null)
    try {
      const result = await api.post<{ ok: boolean; payload: Record<string, unknown> }>(
        `/chat/${slug}/orders/${payload.order_id}/test-pay`,
        { outcome },
      )
      if (!result.ok) {
        // The provider declined. The server still has to say so, not this page.
        onResult({ ...result.payload, declined: true })
        return
      }
      onResult(result.payload)
    } catch {
      setBusy(false)
      setFailed('Could not reach the payment provider. Try again.')
    }
  }

  if (live) {
    return failed ? (
      <div className="pay-layer">
        <div className="pay-panel">
          <p className="notice notice-danger">{failed}</p>
          <button className="btn btn-secondary btn-block" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    ) : null
  }

  return (
    <div className="pay-layer" role="dialog" aria-modal="true" aria-label="Payment">
      <button className="pay-scrim" onClick={busy ? undefined : onCancel} aria-label="Cancel payment" tabIndex={-1} />
      <div className="pay-panel">
        <header className="pay-head">
          <p className="t-sm t-muted">{payload.payment.provider_label} · test mode</p>
          <p className="pay-amount t-num">{payload.total_display}</p>
          <p className="t-sm t-secondary">
            Order <span className="t-id">{payload.order_id}</span>
          </p>
        </header>

        <p className="notice">
          No money moves here. Convo signs the result the way a live provider does, and the server
          verifies that signature before the order is marked paid.
        </p>

        {failed && <p className="notice notice-danger">{failed}</p>}

        <div className="pay-actions">
          <button className="btn btn-primary btn-lg btn-block" onClick={() => settle('success')} disabled={busy}>
            {busy && <span className="spinner" />}
            Pay {payload.total_display}
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => settle('failure')} disabled={busy}>
            Simulate a declined payment
          </button>
          <button className="btn btn-ghost btn-block" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

let scriptPromise: Promise<void> | null = null

function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload = () => resolve()
    script.onerror = () => resolve()
    document.head.appendChild(script)
  })
  return scriptPromise
}
