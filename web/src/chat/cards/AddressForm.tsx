import { useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { IconCheck, IconPlus } from '../../components/icons'

export interface ShippingAddress {
  name: string
  phone: string
  line1: string
  line2: string | null
  city: string
  state: string
  postalCode: string
  country: string
}

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
]

/**
 * Where the order goes.
 *
 * A form, inside the order card, before payment — not a conversation. The
 * fields are the ones an Indian courier actually needs, in the order a person
 * would say them, and the phone is required because couriers call before
 * delivering rather than because we wanted another field.
 *
 * The server validates the same rules again; this only makes the failure
 * arrive next to the input rather than after a round trip.
 */
export function AddressForm({
  orderId,
  initial,
  onSaved,
  onCancel,
}: {
  orderId: string
  initial: ShippingAddress | null
  onSaved(address: ShippingAddress): void
  /** Only offered when there is a saved address to go back to. */
  onCancel?: () => void
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    phone: initial?.phone ?? '',
    line1: initial?.line1 ?? '',
    line2: initial?.line2 ?? '',
    city: initial?.city ?? '',
    state: initial?.state ?? '',
    postalCode: initial?.postalCode ?? '',
  })
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (field: keyof typeof form) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
    setError((current) => (current?.field === field ? null : current))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.post<{ address: ShippingAddress }>(
        `/shop/orders/${orderId}/address`,
        form,
      )
      onSaved(result.address)
    } catch (caught) {
      if (caught instanceof ApiError) {
        const field = (caught as ApiError & { field?: string }).field
        setError({ message: caught.message, field })
      } else {
        setError({ message: 'Could not save that address. Try again.' })
      }
      setBusy(false)
    }
  }

  const invalid = (field: string) => (error?.field === field ? 'true' : undefined)

  return (
    <form className="address-form" onSubmit={submit}>
      <p className="address-form-title">Where should this go?</p>

      <div className="field">
        <label className="field-label" htmlFor="addr-name">
          Full name
        </label>
        <input
          id="addr-name"
          className="input"
          value={form.name}
          onChange={(e) => set('name')(e.target.value)}
          autoComplete="name"
          maxLength={80}
          aria-invalid={invalid('name')}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="addr-phone">
          Mobile number
        </label>
        <div className="input-prefixed">
          <span className="input-prefix">+91</span>
          <input
            id="addr-phone"
            className="input address-phone t-num"
            value={form.phone}
            onChange={(e) => set('phone')(e.target.value.replace(/[^\d+\s-]/g, ''))}
            autoComplete="tel-national"
            inputMode="numeric"
            maxLength={14}
            aria-invalid={invalid('phone')}
          />
        </div>
        <p className="field-hint">The courier will call this number before delivering.</p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="addr-line1">
          Flat, house, building, street
        </label>
        <input
          id="addr-line1"
          className="input"
          value={form.line1}
          onChange={(e) => set('line1')(e.target.value)}
          autoComplete="address-line1"
          maxLength={120}
          aria-invalid={invalid('line1')}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="addr-line2">
          Area, landmark <span className="field-optional">optional</span>
        </label>
        <input
          id="addr-line2"
          className="input"
          value={form.line2}
          onChange={(e) => set('line2')(e.target.value)}
          autoComplete="address-line2"
          maxLength={120}
        />
      </div>

      <div className="address-grid">
        <div className="field">
          <label className="field-label" htmlFor="addr-pin">
            PIN code
          </label>
          <input
            id="addr-pin"
            className="input t-num"
            value={form.postalCode}
            onChange={(e) => set('postalCode')(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoComplete="postal-code"
            inputMode="numeric"
            maxLength={6}
            aria-invalid={invalid('postalCode')}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="addr-city">
            City
          </label>
          <input
            id="addr-city"
            className="input"
            value={form.city}
            onChange={(e) => set('city')(e.target.value)}
            autoComplete="address-level2"
            maxLength={60}
            aria-invalid={invalid('city')}
          />
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="addr-state">
          State
        </label>
        <select
          id="addr-state"
          className="select"
          value={form.state}
          onChange={(e) => set('state')(e.target.value)}
          aria-invalid={invalid('state')}
        >
          <option value="">Choose a state</option>
          {STATES.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="notice notice-danger" role="alert">
          {error.message}
        </p>
      )}

      <div className="address-actions">
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy && <span className="spinner" />}
          {busy ? 'Saving' : 'Save address'}
        </button>
        {onCancel && (
          <button className="btn btn-ghost btn-block" type="button" onClick={onCancel} disabled={busy}>
            Keep the one I had
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * A stable identity for an address, matching the server's.
 *
 * Used to mark which entry in the list is the one attached to this order — the
 * name is included because the same flat with a different recipient is a
 * different delivery.
 */
export function addressKey(address: ShippingAddress): string {
  return [
    address.name,
    address.phone,
    address.line1,
    address.line2 ?? '',
    address.city,
    address.state,
    address.postalCode,
  ]
    .map((part) => part.toLowerCase())
    .join('|')
}

/**
 * Pick where this one goes.
 *
 * Shown once a customer has sent something to more than one place. Choosing a
 * row attaches it to the order immediately — there is no separate confirm,
 * because the selection *is* the decision and the pay button below it is the
 * confirm. The server re-validates whatever arrives, so nothing here is
 * trusted for being on the list already.
 */
export function AddressPicker({
  orderId,
  addresses,
  selected,
  disabled,
  onSelected,
  onAddNew,
}: {
  orderId: string
  addresses: ShippingAddress[]
  selected: ShippingAddress | null
  disabled: boolean
  onSelected(address: ShippingAddress): void
  onAddNew(): void
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectedKey = selected ? addressKey(selected) : null

  async function choose(address: ShippingAddress) {
    const key = addressKey(address)
    if (key === selectedKey || disabled) return
    setPending(key)
    setError(null)
    try {
      const result = await api.post<{ address: ShippingAddress }>(
        `/shop/orders/${orderId}/address`,
        address,
      )
      onSelected(result.address)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not use that address.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="address-picker">
      <p className="address-form-title">Where should this go?</p>

      <ul className="address-options" role="radiogroup" aria-label="Delivery address">
        {addresses.map((address) => {
          const key = addressKey(address)
          const isSelected = key === selectedKey
          return (
            <li key={key}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                className="address-option"
                data-selected={isSelected}
                disabled={disabled || pending !== null}
                onClick={() => choose(address)}
              >
                <span className="address-option-mark" aria-hidden="true">
                  {pending === key ? <span className="spinner" /> : isSelected ? <IconCheck size={12} /> : null}
                </span>
                <span className="address-option-body">
                  <span className="address-option-name">
                    {address.name} · <span className="t-num">+91 {address.phone}</span>
                  </span>
                  <span className="address-option-lines t-sm t-secondary">
                    {[address.line1, address.line2, address.city, address.state]
                      .filter(Boolean)
                      .join(', ')}{' '}
                    <span className="t-num">{address.postalCode}</span>
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {error && (
        <p className="notice notice-danger" role="alert">
          {error}
        </p>
      )}

      <button className="btn btn-secondary btn-block" type="button" onClick={onAddNew} disabled={disabled}>
        <IconPlus size={15} />
        Send somewhere else
      </button>
    </div>
  )
}

/** The saved address, with a way back to editing it. */
export function AddressSummary({
  address,
  onEdit,
  editable,
  note,
}: {
  address: ShippingAddress
  onEdit(): void
  editable: boolean
  /** Said once when a checkout spans brands: one address covers all of them. */
  note?: string
}) {
  return (
    <div className="address-saved">
      <span className="address-saved-tick" aria-hidden="true">
        <IconCheck size={13} />
      </span>
      <div className="address-saved-body">
        <p className="address-saved-name">
          {address.name} · <span className="t-num">+91 {address.phone}</span>
        </p>
        <p className="t-sm t-secondary">
          {[address.line1, address.line2, address.city, address.state].filter(Boolean).join(', ')}{' '}
          <span className="t-num">{address.postalCode}</span>
        </p>
        {note && <p className="t-xs t-muted">{note}</p>}
      </div>
      {editable && (
        <button className="address-saved-edit t-sm" onClick={onEdit} type="button">
          Change
        </button>
      )}
    </div>
  )
}
