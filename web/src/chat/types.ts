import type { ShippingAddress } from './cards/AddressForm'

/** The shop's front, as the opening screen needs it. */
export interface ShopInfo {
  shop: { name: string; currency: string }
  brands: string[]
  brandCount: number
  catalogSize: number
  categories: string[]
  openers: string[]
  showcase: ShowcaseItem[]
}

export interface ShowcaseItem {
  id: string
  name: string
  brand_name: string
  price_display: string
  image_url: string | null
  in_stock: boolean
}

export interface Component {
  component: string
  payload: Record<string, unknown>
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  components: Component[]
  /** True while this message is still streaming in. */
  streaming?: boolean
  /** Set when the turn failed; rendered in place of the reply. */
  error?: string
}

export interface CartLine {
  product_id: string
  tenant_id: string
  brand_name: string
  name: string
  image_url: string | null
  quantity: number
  unit_price_display: string
  line_total_display: string
  in_stock: boolean
  available_stock: number
  price_changed: boolean
}

export interface CartPayload {
  cart_id: string
  currency: string
  item_count: number
  subtotal_minor: number
  subtotal_display: string
  /** The distinct brands in the cart, so the sheet can group and warn. */
  brands: string[]
  lines: CartLine[]
}

export interface ProductCard {
  product_id: string
  tenant_id: string
  brand_name: string
  name: string
  description: string | null
  image_url: string | null
  price_display: string
  category: string | null
  attributes: Record<string, string>
  in_stock: boolean
  stock: number
  reason: string | null
}

/**
 * One checkout, which is one order per brand in the cart.
 *
 * A single-brand cart is the ordinary case and still produces exactly one
 * entry in `orders`; the card renders that without any of the split framing.
 */
export interface CheckoutPayload {
  checkout_id: string
  currency: string
  total_display: string
  item_count: number
  note: string | null
  /** False when nothing in the cart needs delivering. */
  requires_address: boolean
  /**
   * Already attached to the orders, carried from the last one this customer
   * placed. Present means they are payable as they stand; null means the form
   * has to be filled first. One address covers every brand in the checkout.
   */
  shipping_address: ShippingAddress | null
  /** Everywhere this customer has had something sent, most recent first. */
  saved_addresses: ShippingAddress[]
  orders: CheckoutOrder[]
}

export interface CheckoutOrder {
  order_id: string
  brand_name: string
  status: string
  requires_address: boolean
  total_display: string
  lines: Array<{
    product_id: string
    name: string
    quantity: number
    unit_price_display: string
    line_total_display: string
  }>
  payment: {
    provider: string
    provider_label: string
    provider_order_id: string
    public_key: string | null
    is_mock: boolean
    amount_minor: number
    currency: string
  }
}

/** What the server says about a checkout when the card re-syncs. */
export interface CheckoutState {
  checkout_id: string
  orders: Array<{
    order_id: string
    brand_name: string | null
    status: string
    total_display: string
    failure_reason: string | null
  }>
  paid: number
  remaining: number
}

export interface OrderConfirmationPayload {
  order_id: string
  /** Whose receipt this is. With a split checkout there is one per brand. */
  brand_name: string | null
  orders_in_checkout: number
  orders_remaining: number
  total_display: string
  payment_reference: string | null
  /** Null only for a brand that sells something needing no delivery. */
  shipping_address: ShippingAddress | null
  lines: Array<{ product_id: string; name: string; quantity: number; line_total_display: string }>
}
