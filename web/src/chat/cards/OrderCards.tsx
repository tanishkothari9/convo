import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { IconCheck } from '../../components/icons'
import type { Component, OrderConfirmationPayload, OrderSummaryPayload } from '../types'
import { PaymentPanel } from './PaymentPanel'
import {
  AddressForm,
  AddressPicker,
  AddressSummary,
  addressKey,
  type ShippingAddress,
} from './AddressForm'

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
  onSettled(result: { paid: boolean; reason?: string; components?: Component[] }): void
  disabled: boolean
}) {
  const [paying, setPaying] = useState(false)
  const [state, setState] = useState<'open' | 'paid' | 'failed' | 'cancelled' | 'superseded' | 'checking'>(
    'checking',
  )
  const [reason, setReason] = useState<string | null>(null)
  // Seeded from the order itself: a returning customer's address is already on
  // it, so the card opens showing where this is going rather than an empty form.
  const [address, setAddress] = useState<ShippingAddress | null>(
    payload.shipping_address ?? null,
  )
  const [editingAddress, setEditingAddress] = useState(false)

  // Grows as the customer sends things to new places, so a newly entered
  // address joins the list without waiting for the next order.
  const [saved, setSaved] = useState<ShippingAddress[]>(payload.saved_addresses ?? [])

  // A brand that ships needs somewhere to ship to before it can be paid. The
  // server enforces the same rule; this only means the customer meets it in
  // the right order rather than after a refusal.
  const needsAddress = payload.requires_address !== false
  const addressReady = !needsAddress || address !== null

  /*
   * Three shapes, in the order a customer meets them:
   *   nothing on file  -> the form
   *   one address      -> it, with a way to change it
   *   several          -> a list to choose from, like any other checkout
   */
  const showForm = needsAddress && (editingAddress || (address === null && saved.length === 0))
  const showPicker = needsAddress && !showForm && saved.length > 1

  const remember = (next: ShippingAddress) => {
    setAddress(next)
    setSaved((current) => [next, ...current.filter((a) => addressKey(a) !== addressKey(next))])
    setEditingAddress(false)
  }

  /*
   * A card stays in the transcript, so scrolling back reaches an order that may
   * have been paid, cancelled, or replaced since. The server is the authority on
   * that, so the card asks it before offering to pay anything.
   */
  useEffect(() => {
    let live = true
    api
      .get<{
        order: {
          status: string
          failureReason: string | null
          shippingAddress: ShippingAddress | null
        }
      }>(
        `/chat/${slug}/orders/${payload.order_id}`,
      )
      .then(({ order }) => {
        if (!live) return
        if (order.status === 'paid') setState('paid')
        else if (order.status === 'cancelled') {
          setState('superseded')
          setReason(order.failureReason)
        } else if (order.status === 'failed') {
          setState('failed')
          setReason(order.failureReason ?? 'The payment did not go through.')
        } else setState('open')
      })
      .catch(() => live && setState('open'))
    return () => {
      live = false
    }
  }, [slug, payload.order_id])

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
      const response = await api.post<{
        status: string
        failureReason: string | null
        components: Component[]
      }>(`/chat/${slug}/orders/${payload.order_id}/confirm`, result)
      setPaying(false)
      if (response.status === 'paid') {
        setState('paid')
        // The server authored the confirmation, down to the payment reference.
        // The page posts it into the transcript rather than composing its own.
        onSettled({ paid: true, components: response.components })
      } else {
        setState('failed')
        setReason(response.failureReason ?? 'The payment did not go through.')
        onSettled({
          paid: false,
          reason: response.failureReason ?? undefined,
          components: response.components,
        })
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

      {state === 'open' && showForm && (
        <AddressForm
          slug={slug}
          orderId={payload.order_id}
          initial={editingAddress ? null : address}
          onSaved={remember}
          {...(address ? { onCancel: () => setEditingAddress(false) } : {})}
        />
      )}

      {state === 'open' && showPicker && (
        <AddressPicker
          slug={slug}
          orderId={payload.order_id}
          addresses={saved}
          selected={address}
          disabled={disabled}
          onSelected={setAddress}
          onAddNew={() => setEditingAddress(true)}
        />
      )}

      {state === 'open' && needsAddress && !showForm && !showPicker && address !== null && (
        <AddressSummary
          address={address}
          onEdit={() => setEditingAddress(true)}
          editable={!disabled}
        />
      )}

      {state === 'open' && (
        <>
          <button
            className="btn btn-primary btn-lg btn-block"
            onClick={() => setPaying(true)}
            disabled={disabled || !addressReady}
          >
            {addressReady ? `Pay ${payload.total_display}` : 'Add a delivery address to pay'}
          </button>
          <p className="order-fineprint t-xs t-muted">
            {payload.payment.provider === 'razorpay'
              ? `Payment happens in ${payload.payment.provider_label}'s own panel.`
              : 'Payment happens in a separate panel.'}{' '}
            Never type a card number, UPI PIN, or OTP into this chat.
          </p>
        </>
      )}

      {state === 'checking' && (
        <p className="order-checking t-sm t-muted">
          <span className="spinner" /> Checking this order
        </p>
      )}

      {state === 'paid' && <p className="notice notice-ok">Paid. Your confirmation is below.</p>}

      {state === 'superseded' && (
        <p className="notice">
          {reason ?? 'This order was replaced by a newer one.'} Nothing was charged for it.
        </p>
      )}

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
  const address = payload.shipping_address
  return (
    <div className="confirm-card">
      <div className="confirm-head">
        <span className="confirm-tick" aria-hidden="true">
          <IconCheck size={15} />
        </span>
        <div className="confirm-body">
          <p className="confirm-title">Paid — {payload.total_display}</p>
          <p className="t-sm t-secondary">{payload.lines.map((line) => line.name).join(', ')}</p>
        </div>
      </div>

      {address && (
        <div className="confirm-delivery">
          <p className="t-xs confirm-delivery-label">Delivering to</p>
          <address className="confirm-address">
            {address.name}
            <br />
            {[address.line1, address.line2].filter(Boolean).join(', ')}
            <br />
            {address.city}, {address.state} <span className="t-num">{address.postalCode}</span>
            <br />
            <span className="t-num">+91 {address.phone}</span>
          </address>
        </div>
      )}

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
