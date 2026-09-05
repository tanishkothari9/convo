import type { ShippingAddress } from './address.js'

/**
 * Convo's domain models. Adapted from the shopping-agent types in
 * anthropics/commerce-agents (Apache-2.0), with two changes for Convo:
 * every record carries `tenantId`, and money is integer minor units.
 */

export interface Tenant {
  id: string
  name: string
  slug: string
  description: string | null
  assistantName: string
  brandVoice: string
  currency: string
  accentColor: string
  /** False for a brand selling something that does not need delivering. */
  requiresShipping: boolean
  /** Opt-in. Nothing reaches the marketplace until the brand turns this on. */
  isListed: boolean
  llmProvider: string | null
  createdAt: string
  updatedAt: string
}

export interface TenantUser {
  id: string
  tenantId: string
  email: string
  displayName: string | null
  createdAt: string
}

export type ProviderType = 'manual' | 'razorpay' | 'shopify'
export type ProviderRole = 'catalog' | 'payment'
export type SyncStatus = 'never' | 'syncing' | 'ok' | 'error'

export interface ProviderConnection {
  id: string
  tenantId: string
  providerType: ProviderType
  capabilities: string
  /** Where this brand's catalogue is synced from. */
  isCatalogSource: boolean
  /** Who takes the money at checkout. */
  isPaymentProcessor: boolean
  credentialsHint: string | null
  syncStatus: SyncStatus
  syncError: string | null
  lastSyncedAt: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** One catalog record, tenant-scoped. `priceMinor` is paise for INR. */
export interface Product {
  id: string
  tenantId: string
  source: ProviderType
  providerNativeId: string | null
  /** The merchant's own id for this product, set through the public API. */
  externalId: string | null
  name: string
  description: string | null
  priceMinor: number
  currency: string
  images: string[]
  stock: number
  category: string | null
  attributes: Record<string, string>
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** A shopper's thread with Convo. Spans every brand they ask about. */
export interface Conversation {
  id: string
  customerSessionId: string
  startedAt: string
  lastActiveAt: string
}

export type MessageRole = 'user' | 'assistant'

export interface StoredMessage {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  toolCalls: ToolCallRecord[] | null
  toolResults: ToolResultRecord[] | null
  ui: UiComponent[] | null
  createdAt: string
  seq: number
}

export interface ToolCallRecord {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultRecord {
  toolCallId: string
  content: string
  isError: boolean
}

/** A structured component the chat UI renders. Never free-form markdown. */
export interface UiComponent {
  component: string
  payload: Record<string, unknown>
}

export type CartStatus = 'open' | 'locked' | 'converted' | 'abandoned'

export interface CartItem {
  id: string
  cartId: string
  tenantId: string
  productId: string
  quantity: number
  unitPriceMinor: number
  addedAt: string
}

/** One cart per conversation, holding goods from any number of brands. */
export interface Cart {
  id: string
  conversationId: string
  status: CartStatus
  items: CartItem[]
  createdAt: string
  updatedAt: string
}

/** A cart line joined to its live catalog record, priced server-side. */
export interface PricedLine {
  productId: string
  /** Which brand sells this. Shown on every card — a marketplace that hides
   *  who you are buying from is hiding the thing that matters most. */
  tenantId: string
  brandName: string
  name: string
  imageUrl: string | null
  quantity: number
  unitPriceMinor: number
  lineTotalMinor: number
  inStock: boolean
  availableStock: number
  priceChangedSinceAdd: boolean
}

export interface PricedCart {
  cartId: string
  currency: string
  lines: PricedLine[]
  itemCount: number
  subtotalMinor: number
}

export type OrderStatus =
  | 'created'
  | 'awaiting_payment'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'refunded'

export interface OrderLineItem {
  productId: string
  name: string
  quantity: number
  unitPriceMinor: number
  lineTotalMinor: number
}

export interface Order {
  id: string
  tenantId: string
  cartId: string
  conversationId: string
  /** Groups the orders staged together by one checkout across brands. */
  checkoutId: string
  totalAmountMinor: number
  currency: string
  status: OrderStatus
  providerType: ProviderType
  providerOrderId: string | null
  providerPaymentId: string | null
  lineItems: OrderLineItem[]
  /** Frozen at checkout, so a later edit cannot change where this was sent. */
  shippingAddress: ShippingAddress | null
  failureReason: string | null
  createdAt: string
  updatedAt: string
}

export type AuditAction =
  | 'cart.locked'
  | 'order.created'
  | 'payment.attempted'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'payment.signature_rejected'
  | 'order.refunded'
  | 'checkout.blocked'
  | 'catalog.synced'
  | 'agent.tool_held'

export type AuditOutcome = 'ok' | 'blocked' | 'failed'

export interface AuditLogEntry {
  id: string
  tenantId: string
  conversationId: string | null
  cartId: string | null
  orderId: string | null
  actionType: AuditAction
  amountMinor: number | null
  currency: string | null
  outcome: AuditOutcome
  reasoning: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}
