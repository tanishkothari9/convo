import type { ShippingAddress } from './cards/AddressForm'

export interface BrandInfo {
  name: string
  slug: string
  description: string | null
  assistantName: string
  accentColor: string
  currency: string
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
  lines: CartLine[]
}

export interface ProductCard {
  product_id: string
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

export interface OrderSummaryPayload {
  order_id: string
  status: string
  currency: string
  total_display: string
  item_count: number
  note: string | null
  /** False for a brand selling something that needs no delivering. */
  requires_address: boolean
  /**
   * Already attached to the order, carried from the last one this customer
   * placed. Present means the order is payable as it stands; null means the
   * form has to be filled first.
   */
  shipping_address: ShippingAddress | null
  /** Everywhere this customer has had something sent, most recent first. */
  saved_addresses: ShippingAddress[]
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

export interface OrderConfirmationPayload {
  order_id: string
  total_display: string
  payment_reference: string | null
  /** Null only for a brand that sells something needing no delivery. */
  shipping_address: ShippingAddress | null
  lines: Array<{ product_id: string; name: string; quantity: number; line_total_display: string }>
}
