/**
 * Delivery addresses.
 *
 * Collected in a form, never in the conversation. Two reasons: parsing a
 * free-text address into structured fields is the kind of thing a model gets
 * subtly wrong in ways nobody notices until a parcel is lost, and it keeps a
 * customer's home address out of the model's context and the stored transcript.
 *
 * Shaped for India because that is who Convo serves first — a six-digit PIN and
 * a ten-digit mobile — but the country field exists so widening it later is a
 * validation change rather than a migration.
 */

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

export class AddressError extends Error {
  constructor(
    readonly field: keyof ShippingAddress,
    message: string,
  ) {
    super(message)
  }
}

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland',
  'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
] as const

export const STATES = INDIAN_STATES

/**
 * Validates and normalises a submitted address.
 *
 * Throws on the first problem with the field named, so the form can point at
 * the input rather than showing a wall of text. Everything is trimmed and
 * length-capped: this is rendered in a merchant's dashboard and printed on a
 * label, so unbounded input is both a layout and a storage problem.
 */
export function readAddress(input: unknown, country = 'India'): ShippingAddress {
  const body = (input ?? {}) as Record<string, unknown>

  const text = (field: keyof ShippingAddress, label: string, max: number, min = 1): string => {
    const value = body[field]
    if (typeof value !== 'string' || value.trim().length < min) {
      throw new AddressError(field, `${label} is required.`)
    }
    const trimmed = value.trim().replace(/\s+/g, ' ')
    if (trimmed.length > max) throw new AddressError(field, `${label} is too long.`)
    return trimmed
  }

  const name = text('name', 'A name', 80, 2)

  // Accept the ways people actually type a mobile number, then store one form.
  const rawPhone = typeof body.phone === 'string' ? body.phone : ''
  const digits = rawPhone.replace(/[\s\-()]/g, '').replace(/^\+?91/, '')
  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new AddressError(
      'phone',
      'Enter a 10-digit mobile number. Couriers call before delivering.',
    )
  }

  const line1 = text('line1', 'A street address', 120, 4)
  const rawLine2 = typeof body.line2 === 'string' ? body.line2.trim().replace(/\s+/g, ' ') : ''
  if (rawLine2.length > 120) throw new AddressError('line2', 'That line is too long.')
  const city = text('city', 'A city', 60, 2)

  const state = text('state', 'A state', 60, 2)
  if (country === 'India' && !INDIAN_STATES.includes(state as (typeof INDIAN_STATES)[number])) {
    throw new AddressError('state', 'Choose a state from the list.')
  }

  const postalCode = String(body.postalCode ?? '').replace(/\s/g, '')
  if (country === 'India' && !/^[1-9]\d{5}$/.test(postalCode)) {
    throw new AddressError('postalCode', 'Enter a 6-digit PIN code.')
  }

  return {
    name,
    phone: digits,
    line1,
    line2: rawLine2 === '' ? null : rawLine2,
    city,
    state,
    postalCode,
    country,
  }
}

/**
 * A stable identity for an address, for de-duplicating a customer's list.
 *
 * The name is part of it on purpose: the same flat with a different recipient
 * is a different delivery — someone sending a gift to their mother's house
 * should see both entries, not have one silently absorb the other. Everything
 * is already normalised by `readAddress` on the way in, so this only has to
 * fold case and drop the optional line's null.
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

/** One line, for a dashboard row or an order card. */
export function formatAddress(address: ShippingAddress): string {
  return [address.line1, address.line2, address.city, address.state, address.postalCode]
    .filter(Boolean)
    .join(', ')
}
