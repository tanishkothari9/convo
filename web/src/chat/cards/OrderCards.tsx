import { useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { IconCheck } from '../../components/icons'
import type {
  CheckoutOrder,
  CheckoutPayload,
  CheckoutState,
  Component,
  OrderConfirmationPayload,
} from '../types'
import { PaymentPanel } from './PaymentPanel'
import {
  AddressForm,
  AddressPicker,
  AddressSummary,
  addressKey,
  type ShippingAddress,
} from './AddressForm'

type OrderState = 'open' | 'paid' | 'failed' | 'cancelled'

/**
 * The checkout card: one order per brand in the cart, paid one at a time.
 *
 * Every total here is the one the server computed from live catalogue prices
 * at the moment of checkout. None of them is something the agent said, and
 * nothing on this page can change them.
 *
 * A single-brand cart — still the common case — renders as one plain order
 * with none of the split framing. The extra structure only appears when there
 * is genuinely more than one brand to settle with.
 */
export function CheckoutCard({
  payload,
  onSettled,
  disabled,
}: {
  payload: CheckoutPayload
  onSettled(result: { paid: boolean; reason?: string; components?: Component[] }): void
  disabled: boolean
}) {
  const orders = payload.orders
  const split = orders.length > 1

  const [checking, setChecking] = useState(true)
  const [superseded, setSuperseded] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, OrderState>>(() =>
    Object.fromEntries(orders.map((order) => [order.order_id, 'open' as OrderState])),
  )
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [paying, setPaying] = useState<CheckoutOrder | null>(null)

  // Seeded from the orders themselves: a returning customer's address is
  // already attached, so the card opens showing where this is going rather
  // than an empty form.
  const [address, setAddress] = useState<ShippingAddress | null>(payload.shipping_address ?? null)
  const [editingAddress, setEditingAddress] = useState(false)

  // Grows as the customer sends things to new places, so a newly entered
  // address joins the list without waiting for the next order.
  const [saved, setSaved] = useState<ShippingAddress[]>(payload.saved_addresses ?? [])

  // Something in this cart needs delivering. The server enforces the same rule
  // per brand; this only means the customer meets it in the right order rather
  // than after a refusal.
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
   * A card stays in the transcript, so scrolling back reaches a checkout that
   * may have been paid, cancelled, or replaced since. The server is the
   * authority on that, so the card asks it before offering to pay anything.
   */
  useEffect(() => {
    let live = true
    api
      .get<CheckoutState>(`/shop/checkouts/${payload.checkout_id}`)
      .then((state) => {
        if (!live) return
        const next: Record<string, OrderState> = {}
        const why: Record<string, string> = {}
        for (const order of state.orders) {
          if (order.status === 'paid') next[order.order_id] = 'paid'
          else if (order.status === 'cancelled') {
            next[order.order_id] = 'cancelled'
            if (order.failure_reason) why[order.order_id] = order.failure_reason
          } else if (order.status === 'failed') {
            next[order.order_id] = 'failed'
            why[order.order_id] = order.failure_reason ?? 'The payment did not go through.'
          } else next[order.order_id] = 'open'
        }
        // Every order replaced at once means a newer checkout took over.
        const allCancelled = state.orders.length > 0 && state.orders.every((o) => o.status === 'cancelled')
        if (allCancelled) {
          setSuperseded(state.orders[0]?.failure_reason ?? 'This checkout was replaced by a newer one.')
        }
        setStates(next)
        setReasons(why)
      })
      .catch(() => undefined)
      .finally(() => live && setChecking(false))
    return () => {
      live = false
    }
  }, [payload.checkout_id])

  const paid = useMemo(
    () => orders.filter((order) => states[order.order_id] === 'paid').length,
    [orders, states],
  )
  // The next brand still owed. Paying runs down this list in order, so the
  // customer always knows which shop the panel in front of them belongs to.
  const next = orders.find(
    (order) => states[order.order_id] === 'open' || states[order.order_id] === 'failed',
  )
  const settled = paid === orders.length

  async function cancel() {
    const target = paying
    setPaying(null)
    if (!target) return
    setStates((current) => ({ ...current, [target.order_id]: 'cancelled' }))
    try {
      // The server cancels every unpaid order in the checkout, so the card
      // reflects that rather than pretending only one backed out.
      const response = await api.post<{ checkout: CheckoutState }>(
        `/shop/orders/${target.order_id}/cancel`,
      )
      setStates((current) => {
        const updated = { ...current }
        for (const order of response.checkout.orders) {
          if (order.status === 'cancelled') updated[order.order_id] = 'cancelled'
        }
        return updated
      })
    } catch {
      /* the orders stay awaiting payment; the customer can retry */
    }
    onSettled({ paid: false, reason: 'cancelled' })
  }

  async function confirm(result: Record<string, unknown>) {
    const target = paying
    if (!target) return
    try {
      const response = await api.post<{
        status: string
        failureReason: string | null
        components: Component[]
      }>(`/shop/orders/${target.order_id}/confirm`, result)
      setPaying(null)
      if (response.status === 'paid') {
        setStates((current) => ({ ...current, [target.order_id]: 'paid' }))
        // The server authored the confirmation, down to the payment reference.
        // The page posts it into the transcript rather than composing its own.
        onSettled({ paid: true, components: response.components })
      } else {
        setStates((current) => ({ ...current, [target.order_id]: 'failed' }))
        setReasons((current) => ({
          ...current,
          [target.order_id]: response.failureReason ?? 'The payment did not go through.',
        }))
        onSettled({
          paid: false,
          reason: response.failureReason ?? undefined,
          components: response.components,
        })
      }
    } catch (error) {
      setPaying(null)
      const message =
        error instanceof ApiError ? error.message : 'The payment could not be confirmed.'
      setStates((current) => ({ ...current, [target.order_id]: 'failed' }))
      setReasons((current) => ({ ...current, [target.order_id]: message }))
      onSettled({ paid: false, reason: message })
    }
  }

  if (superseded) {
    return (
      <div className="order-card">
        <div className="order-head">
          <p className="order-label t-sm t-muted">{split ? 'Your orders' : 'Your order'}</p>
          <p className="t-id">{payload.checkout_id}</p>
        </div>
        <p className="notice">{superseded} Nothing was charged for it.</p>
      </div>
    )
  }

  return (
    <div className="order-card">
      <div className="order-head">
        <p className="order-label t-sm t-muted">{split ? 'Your orders' : 'Your order'}</p>
        <p className="t-id">{payload.checkout_id}</p>
      </div>

      {/* Said before the total, not after: a shopper about to see two charges
          on their statement should read why here, on the card that causes it. */}
      {split && (
        <p className="order-split-note t-sm">
          {orders.length} brands, so {orders.length} separate orders — each paid to that brand
          directly.
        </p>
      )}

      {orders.map((order) => {
        const state = states[order.order_id] ?? 'open'
        return (
          <section className="order-brand" key={order.order_id} data-state={state}>
            {split && (
              <header className="order-brand-head">
                <span className="order-brand-name">{order.brand_name}</span>
                <span className="order-brand-total t-num">{order.total_display}</span>
              </header>
            )}
            <ul className="order-lines">
              {order.lines.map((line) => (
                <li key={line.product_id} className="order-line">
                  <span className="order-line-name">
                    {line.name}
                    {line.quantity > 1 && <span className="t-muted t-num"> × {line.quantity}</span>}
                  </span>
                  <span className="t-num">{line.line_total_display}</span>
                </li>
              ))}
            </ul>
            {state === 'paid' && (
              <p className="order-brand-flag order-brand-paid t-sm">
                <IconCheck size={12} /> Paid
              </p>
            )}
            {state === 'failed' && (
              <p className="order-brand-flag order-brand-failed t-sm">
                {reasons[order.order_id] ?? 'The payment did not go through.'}
              </p>
            )}
          </section>
        )
      })}

      <div className="order-total">
        <span>{split ? 'Total across all brands' : 'Total'}</span>
        <span className="t-num order-total-value">{payload.total_display}</span>
      </div>

      {payload.note && <p className="order-note t-sm t-secondary">{payload.note}</p>}

      {!settled && showForm && (
        <AddressForm
          orderId={orders[0]!.order_id}
          initial={editingAddress ? null : address}
          onSaved={remember}
          {...(address ? { onCancel: () => setEditingAddress(false) } : {})}
        />
      )}

      {!settled && showPicker && (
        <AddressPicker
          orderId={orders[0]!.order_id}
          addresses={saved}
          selected={address}
          disabled={disabled}
          onSelected={setAddress}
          onAddNew={() => setEditingAddress(true)}
        />
      )}

      {!settled && needsAddress && !showForm && !showPicker && address !== null && (
        <AddressSummary
          address={address}
          onEdit={() => setEditingAddress(true)}
          editable={!disabled}
          {...(split ? { note: 'Everything in this checkout goes here.' } : {})}
        />
      )}

      {checking && (
        <p className="order-checking t-sm t-muted">
          <span className="spinner" /> Checking this order
        </p>
      )}

      {!checking && next && (
        <>
          {split && (
            <p className="order-progress t-xs t-muted t-num">
              {paid} of {orders.length} paid
            </p>
          )}
          <button
            className="btn btn-primary btn-lg btn-block"
            onClick={() => setPaying(next)}
            disabled={disabled || !addressReady}
          >
            {!addressReady
              ? 'Add a delivery address to pay'
              : split
                ? `Pay ${next.brand_name} ${next.total_display}`
                : `Pay ${next.total_display}`}
          </button>
          <p className="order-fineprint t-xs t-muted">
            {next.payment.provider === 'razorpay'
              ? `Payment happens in ${next.payment.provider_label}'s own panel.`
              : 'Payment happens in a separate panel.'}{' '}
            Never type a card number, UPI PIN, or OTP into this chat.
          </p>
        </>
      )}

      {!checking && settled && (
        <p className="notice notice-ok">
          {split ? 'All paid. Your confirmations are below.' : 'Paid. Your confirmation is below.'}
        </p>
      )}

      {!checking && !next && !settled && (
        <div className="order-retry">
          <p className="notice">
            Payment cancelled. Nothing was charged and your cart is intact.
          </p>
          <button
            className="btn btn-secondary btn-block"
            onClick={() =>
              setStates((current) =>
                Object.fromEntries(
                  Object.entries(current).map(([id, state]) => [
                    id,
                    state === 'cancelled' ? 'open' : state,
                  ]),
                ),
              )
            }
          >
            Try again
          </button>
        </div>
      )}

      {paying && (
        <PaymentPanel
          payload={paying}
          /* Already collected on this card, so Razorpay gets it too. */
          customer={address ? { name: address.name, phone: address.phone } : null}
          onCancel={cancel}
          onResult={confirm}
        />
      )}
    </div>
  )
}

export function OrderConfirmationCard({ payload }: { payload: OrderConfirmationPayload }) {
  const address = payload.shipping_address
  const split = (payload.orders_in_checkout ?? 1) > 1
  return (
    <div className="confirm-card">
      <div className="confirm-head">
        <span className="confirm-tick" aria-hidden="true">
          <IconCheck size={15} />
        </span>
        <div className="confirm-body">
          {/* The brand leads, because with a split checkout this is one of
              several receipts and the name is what tells them apart. */}
          <p className="confirm-title">
            {payload.brand_name ? `${payload.brand_name} — ` : ''}Paid {payload.total_display}
          </p>
          <p className="t-sm t-secondary">{payload.lines.map((line) => line.name).join(', ')}</p>
        </div>
      </div>

      {/* Stated as a fact about the checkout rather than as what is still
          owed. A receipt stays in the transcript forever, and "one more brand
          to pay" would be a lie about five minutes from now. */}
      {split && (
        <p className="confirm-remaining t-sm">
          One of {payload.orders_in_checkout} orders in this checkout, each paid to its own brand.
        </p>
      )}

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

export function PaymentFailedCard({
  payload,
}: {
  payload: { order_id: string; reason: string; total_display: string }
}) {
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
