/**
 * Tenant-scoped data access. Every read and write here takes a tenantId and
 * puts it in the WHERE clause — there is no unscoped accessor for catalog,
 * conversation, cart, order, or audit data anywhere in the codebase.
 */
import { all, get, run, transaction } from './index.js'
import { id, nowIso } from '../lib/ids.js'
import { STOCK_UNTRACKED } from '../commerce/razorpay/adapter.js'
import { addressKey } from '../domain/address.js'
import type { ShippingAddress } from '../domain/address.js'
import type {
  AuditAction,
  AuditLogEntry,
  AuditOutcome,
  Cart,
  CartItem,
  CartStatus,
  Conversation,
  Order,
  OrderLineItem,
  OrderStatus,
  Product,
  ProviderConnection,
  ProviderType,
  StoredMessage,
  ProviderRole,
  SyncStatus,
  Tenant,
  TenantUser,
  UiComponent,
} from '../domain/types.js'

// ── mappers ─────────────────────────────────────────────────────────────────

const bool = (v: unknown) => Number(v) === 1
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || v === '') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

function toTenant(r: Record<string, unknown>): Tenant {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    description: (r.description as string) ?? null,
    assistantName: String(r.assistant_name),
    brandVoice: String(r.brand_voice),
    currency: String(r.currency),
    accentColor: String(r.accent_color),
    requiresShipping: r.requires_shipping === undefined ? true : bool(r.requires_shipping),
    llmProvider: (r.llm_provider as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

function toProduct(r: Record<string, unknown>): Product {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    source: String(r.source) as ProviderType,
    providerNativeId: (r.provider_native_id as string) ?? null,
    externalId: (r.external_id as string) ?? null,
    name: String(r.name),
    description: (r.description as string) ?? null,
    priceMinor: Number(r.price_minor),
    currency: String(r.currency),
    images: json<string[]>(r.images, []),
    stock: Number(r.stock),
    category: (r.category as string) ?? null,
    attributes: json<Record<string, string>>(r.attributes, {}),
    isActive: bool(r.is_active),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

function toOrder(r: Record<string, unknown>): Order {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    cartId: String(r.cart_id),
    conversationId: String(r.conversation_id),
    totalAmountMinor: Number(r.total_amount_minor),
    currency: String(r.currency),
    status: String(r.status) as OrderStatus,
    providerType: String(r.provider_type) as ProviderType,
    providerOrderId: (r.provider_order_id as string) ?? null,
    providerPaymentId: (r.provider_payment_id as string) ?? null,
    lineItems: json<OrderLineItem[]>(r.line_items, []),
    shippingAddress: json<ShippingAddress | null>(r.shipping_address, null),
    failureReason: (r.failure_reason as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

// ── tenants ─────────────────────────────────────────────────────────────────

export const tenants = {
  create(input: {
    name: string
    slug: string
    description?: string
    assistantName?: string
    brandVoice?: string
    currency?: string
    accentColor?: string
  }): Tenant {
    const now = nowIso()
    const tenantId = id('ten')
    run(
      `INSERT INTO tenants (id, name, slug, description, assistant_name, brand_voice, currency, accent_color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        input.name,
        input.slug,
        input.description ?? null,
        input.assistantName ?? `${input.name} Assistant`,
        input.brandVoice ?? 'warm, precise, and unhurried',
        input.currency ?? 'INR',
        input.accentColor ?? '#1A1C22',
        now,
        now,
      ],
    )
    return tenants.byId(tenantId)!
  },

  byId(tenantId: string): Tenant | undefined {
    const row = get('SELECT * FROM tenants WHERE id = ?', [tenantId])
    return row ? toTenant(row) : undefined
  },

  bySlug(slug: string): Tenant | undefined {
    const row = get('SELECT * FROM tenants WHERE slug = ?', [slug])
    return row ? toTenant(row) : undefined
  },

  update(
    tenantId: string,
    patch: Partial<
      Pick<
        Tenant,
        | 'name'
        | 'description'
        | 'assistantName'
        | 'brandVoice'
        | 'accentColor'
        | 'llmProvider'
        | 'slug'
        | 'requiresShipping'
      >
    >,
  ): Tenant | undefined {
    const columns: Record<string, string> = {
      name: 'name',
      slug: 'slug',
      description: 'description',
      assistantName: 'assistant_name',
      brandVoice: 'brand_voice',
      accentColor: 'accent_color',
      llmProvider: 'llm_provider',
      requiresShipping: 'requires_shipping',
    }
    const sets: string[] = []
    const params: unknown[] = []
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key]
      if (value !== undefined) {
        sets.push(`${column} = ?`)
        params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
      }
    }
    if (sets.length === 0) return tenants.byId(tenantId)
    sets.push('updated_at = ?')
    params.push(nowIso(), tenantId)
    run(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, params)
    return tenants.byId(tenantId)
  },

  slugTaken(slug: string, exceptTenantId?: string): boolean {
    const row = get<{ id: string }>('SELECT id FROM tenants WHERE slug = ?', [slug])
    return row !== undefined && row.id !== exceptTenantId
  },
}

// ── users and dashboard sessions ────────────────────────────────────────────

export const users = {
  create(input: {
    tenantId: string
    email: string
    passwordHash: string
    passwordSalt: string
    displayName?: string
  }): TenantUser {
    const userId = id('usr')
    run(
      `INSERT INTO tenant_users (id, tenant_id, email, password_hash, password_salt, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        input.tenantId,
        input.email.toLowerCase(),
        input.passwordHash,
        input.passwordSalt,
        input.displayName ?? null,
        nowIso(),
      ],
    )
    return users.byId(userId)!
  },

  byId(userId: string): TenantUser | undefined {
    const r = get('SELECT * FROM tenant_users WHERE id = ?', [userId])
    if (!r) return undefined
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      email: String(r.email),
      displayName: (r.display_name as string) ?? null,
      createdAt: String(r.created_at),
    }
  },

  credentialsByEmail(
    email: string,
  ): { id: string; tenantId: string; hash: string; salt: string } | undefined {
    const r = get('SELECT * FROM tenant_users WHERE email = ?', [email.toLowerCase()])
    if (!r) return undefined
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      hash: String(r.password_hash),
      salt: String(r.password_salt),
    }
  },

  emailTaken(email: string): boolean {
    return get('SELECT id FROM tenant_users WHERE email = ?', [email.toLowerCase()]) !== undefined
  },
}

export const sessions = {
  create(sessionId: string, userId: string, tenantId: string, ttlDays = 30): void {
    const now = new Date()
    const expires = new Date(now.getTime() + ttlDays * 86_400_000)
    run(
      `INSERT INTO dashboard_sessions (id, tenant_user_id, tenant_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, userId, tenantId, now.toISOString(), expires.toISOString()],
    )
  },

  resolve(sessionId: string): { userId: string; tenantId: string } | undefined {
    const r = get('SELECT * FROM dashboard_sessions WHERE id = ?', [sessionId])
    if (!r) return undefined
    if (new Date(String(r.expires_at)).getTime() < Date.now()) {
      sessions.destroy(sessionId)
      return undefined
    }
    return { userId: String(r.tenant_user_id), tenantId: String(r.tenant_id) }
  },

  destroy(sessionId: string): void {
    run('DELETE FROM dashboard_sessions WHERE id = ?', [sessionId])
  },
}

// ── provider connections ────────────────────────────────────────────────────

function toConnection(r: Record<string, unknown>): ProviderConnection {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    providerType: String(r.provider_type) as ProviderType,
    capabilities: String(r.capabilities),
    isCatalogSource: bool(r.is_catalog_source),
    isPaymentProcessor: bool(r.is_payment_processor),
    credentialsHint: (r.credentials_hint as string) ?? null,
    syncStatus: String(r.sync_status) as SyncStatus,
    syncError: (r.sync_error as string) ?? null,
    lastSyncedAt: (r.last_synced_at as string) ?? null,
    isActive: bool(r.is_active),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

export const connections = {
  listForTenant(tenantId: string): ProviderConnection[] {
    return all('SELECT * FROM provider_connections WHERE tenant_id = ? ORDER BY created_at', [
      tenantId,
    ]).map(toConnection)
  },

  /** Kept for the overview, which shows "who are we selling through". */
  active(tenantId: string): ProviderConnection | undefined {
    return connections.activePayment(tenantId) ?? connections.activeCatalog(tenantId)
  },

  /** Where the catalogue is synced from. Null means Convo's own products. */
  activeCatalog(tenantId: string): ProviderConnection | undefined {
    const r = get(
      `SELECT * FROM provider_connections WHERE tenant_id = ? AND is_catalog_source = 1
       ORDER BY CASE provider_type WHEN 'manual' THEN 1 ELSE 0 END LIMIT 1`,
      [tenantId],
    )
    return r ? toConnection(r) : undefined
  },

  /** Who takes the money. Falls back to the built-in test processor. */
  activePayment(tenantId: string): ProviderConnection | undefined {
    const r = get(
      `SELECT * FROM provider_connections WHERE tenant_id = ? AND is_payment_processor = 1
       ORDER BY CASE provider_type WHEN 'manual' THEN 1 ELSE 0 END LIMIT 1`,
      [tenantId],
    )
    return r ? toConnection(r) : undefined
  },

  byType(tenantId: string, providerType: ProviderType): ProviderConnection | undefined {
    const r = get('SELECT * FROM provider_connections WHERE tenant_id = ? AND provider_type = ?', [
      tenantId,
      providerType,
    ])
    return r ? toConnection(r) : undefined
  },

  /** The encrypted credential blob. Read only inside a provider adapter call. */
  secretFor(tenantId: string, providerType: ProviderType): string | null {
    const r = get<{ credentials_enc: string | null }>(
      'SELECT credentials_enc FROM provider_connections WHERE tenant_id = ? AND provider_type = ?',
      [tenantId, providerType],
    )
    return r?.credentials_enc ?? null
  },

  upsert(input: {
    tenantId: string
    providerType: ProviderType
    capabilities: string
    credentialsEnc: string | null
    credentialsHint: string | null
  }): ProviderConnection {
    const now = nowIso()
    const existing = connections.byType(input.tenantId, input.providerType)
    if (existing) {
      run(
        `UPDATE provider_connections
         SET capabilities = ?, credentials_enc = ?, credentials_hint = ?, is_active = 1,
             sync_status = 'never', sync_error = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [
          input.capabilities,
          input.credentialsEnc,
          input.credentialsHint,
          now,
          existing.id,
          input.tenantId,
        ],
      )
    } else {
      run(
        `INSERT INTO provider_connections
           (id, tenant_id, provider_type, capabilities, credentials_enc, credentials_hint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id('pcn'),
          input.tenantId,
          input.providerType,
          input.capabilities,
          input.credentialsEnc,
          input.credentialsHint,
          now,
          now,
        ],
      )
    }
    return connections.byType(input.tenantId, input.providerType)!
  },

  setSyncState(
    tenantId: string,
    providerType: ProviderType,
    status: SyncStatus,
    error?: string | null,
  ): void {
    run(
      `UPDATE provider_connections
       SET sync_status = ?, sync_error = ?, last_synced_at = CASE WHEN ? = 'ok' THEN ? ELSE last_synced_at END, updated_at = ?
       WHERE tenant_id = ? AND provider_type = ?`,
      [status, error ?? null, status, nowIso(), nowIso(), tenantId, providerType],
    )
  },

  /**
   * Makes one connection the tenant's source for a role.
   *
   * Roles are exclusive within themselves but independent of each other, so
   * Shopify can be the catalogue while Razorpay takes the money. A provider is
   * only offered a role its adapter actually supports.
   */
  activate(tenantId: string, providerType: ProviderType, roles: ProviderRole[]): void {
    transaction(() => {
      const now = nowIso()
      for (const role of roles) {
        const column = role === 'catalog' ? 'is_catalog_source' : 'is_payment_processor'
        run(`UPDATE provider_connections SET ${column} = 0, updated_at = ? WHERE tenant_id = ?`, [
          now,
          tenantId,
        ])
        run(
          `UPDATE provider_connections SET ${column} = 1, is_active = 1, updated_at = ?
           WHERE tenant_id = ? AND provider_type = ?`,
          [now, tenantId, providerType],
        )
      }
    })
  },

  remove(tenantId: string, providerType: ProviderType): void {
    run('DELETE FROM provider_connections WHERE tenant_id = ? AND provider_type = ?', [
      tenantId,
      providerType,
    ])
  },
}

// ── catalog ─────────────────────────────────────────────────────────────────

export const products = {
  list(tenantId: string, opts: { includeInactive?: boolean } = {}): Product[] {
    const clause = opts.includeInactive ? '' : ' AND is_active = 1'
    // rowid breaks the tie: several products added in the same millisecond
    // would otherwise come back in an arbitrary order, and reversing this list
    // is how the agent recovers the merchant's own catalogue order.
    return all(
      `SELECT * FROM products WHERE tenant_id = ?${clause} ORDER BY created_at DESC, rowid DESC`,
      [tenantId],
    ).map(toProduct)
  },

  byId(tenantId: string, productId: string): Product | undefined {
    const r = get('SELECT * FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId])
    return r ? toProduct(r) : undefined
  },

  byIds(tenantId: string, productIds: string[]): Product[] {
    if (productIds.length === 0) return []
    const holes = productIds.map(() => '?').join(', ')
    return all(`SELECT * FROM products WHERE tenant_id = ? AND id IN (${holes})`, [
      tenantId,
      ...productIds,
    ]).map(toProduct)
  },

  byExternalId(tenantId: string, externalId: string): Product | undefined {
    const r = get('SELECT * FROM products WHERE tenant_id = ? AND external_id = ?', [
      tenantId,
      externalId,
    ])
    return r ? toProduct(r) : undefined
  },

  /**
   * Upserts by the merchant's own id.
   *
   * This is what makes a nightly sync safe to re-run: the same `external_id`
   * updates the same row rather than growing a duplicate catalogue. A field the
   * caller omits is left alone, so a partial payload is a partial update.
   */
  upsertByExternalId(
    tenantId: string,
    externalId: string,
    input: {
      name?: string
      description?: string | null
      priceMinor?: number
      currency?: string
      images?: string[]
      stock?: number
      category?: string | null
      attributes?: Record<string, string>
      isActive?: boolean
    },
  ): { product: Product; created: boolean } {
    const existing = products.byExternalId(tenantId, externalId)
    if (existing) {
      const updated = products.update(tenantId, existing.id, input)!
      return { product: updated, created: false }
    }
    const product = products.create({
      tenantId,
      externalId,
      name: input.name ?? 'Untitled product',
      description: input.description ?? null,
      priceMinor: input.priceMinor ?? 0,
      currency: input.currency ?? 'INR',
      images: input.images ?? [],
      stock: input.stock ?? 0,
      category: input.category ?? null,
      attributes: input.attributes ?? {},
      source: 'manual',
    })
    return { product, created: true }
  },

  create(input: {
    tenantId: string
    name: string
    description?: string | null
    priceMinor: number
    currency?: string
    images?: string[]
    stock?: number
    category?: string | null
    attributes?: Record<string, string>
    source?: ProviderType
    providerNativeId?: string | null
    externalId?: string | null
  }): Product {
    const now = nowIso()
    const productId = id('prd')
    run(
      `INSERT INTO products
         (id, tenant_id, source, provider_native_id, external_id, name, description, price_minor, currency,
          images, stock, category, attributes, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        productId,
        input.tenantId,
        input.source ?? 'manual',
        input.providerNativeId ?? null,
        input.externalId ?? null,
        input.name,
        input.description ?? null,
        input.priceMinor,
        input.currency ?? 'INR',
        JSON.stringify(input.images ?? []),
        input.stock ?? 0,
        input.category ?? null,
        JSON.stringify(input.attributes ?? {}),
        now,
        now,
      ],
    )
    return products.byId(input.tenantId, productId)!
  },

  update(
    tenantId: string,
    productId: string,
    patch: Partial<
      Pick<
        Product,
        | 'name'
        | 'description'
        | 'priceMinor'
        | 'images'
        | 'stock'
        | 'category'
        | 'attributes'
        | 'isActive'
      >
    >,
  ): Product | undefined {
    const sets: string[] = []
    const params: unknown[] = []
    const push = (column: string, value: unknown) => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.name !== undefined) push('name', patch.name)
    if (patch.description !== undefined) push('description', patch.description)
    if (patch.priceMinor !== undefined) push('price_minor', patch.priceMinor)
    if (patch.images !== undefined) push('images', JSON.stringify(patch.images))
    if (patch.stock !== undefined) push('stock', patch.stock)
    if (patch.category !== undefined) push('category', patch.category)
    if (patch.attributes !== undefined) push('attributes', JSON.stringify(patch.attributes))
    if (patch.isActive !== undefined) push('is_active', patch.isActive ? 1 : 0)
    if (sets.length === 0) return products.byId(tenantId, productId)
    push('updated_at', nowIso())
    params.push(tenantId, productId)
    run(`UPDATE products SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, params)
    return products.byId(tenantId, productId)
  },

  remove(tenantId: string, productId: string): boolean {
    return run('DELETE FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId])
      .changes > 0
  },

  /** Decrement stock atomically; returns false when there is not enough left. */
  reserveStock(tenantId: string, productId: string, quantity: number): boolean {
    return (
      run(
        'UPDATE products SET stock = stock - ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND stock >= ?',
        [quantity, nowIso(), tenantId, productId, quantity],
      ).changes > 0
    )
  },

  releaseStock(tenantId: string, productId: string, quantity: number): void {
    run('UPDATE products SET stock = stock + ?, updated_at = ? WHERE tenant_id = ? AND id = ?', [
      quantity,
      nowIso(),
      tenantId,
      productId,
    ])
  },

  /**
   * Replaces the tenant's synced catalog with what the provider returned.
   * Products the provider no longer lists are deactivated rather than deleted,
   * so historical orders and carts keep resolving.
   */
  replaceSynced(
    tenantId: string,
    source: ProviderType,
    incoming: Array<{
      providerNativeId: string
      name: string
      description: string | null
      priceMinor: number
      currency: string
      images: string[]
      stock: number
      category: string | null
      attributes: Record<string, string>
    }>,
  ): { created: number; updated: number; deactivated: number } {
    return transaction(() => {
      const now = nowIso()
      let created = 0
      let updated = 0
      const seen = new Set<string>()
      for (const item of incoming) {
        seen.add(item.providerNativeId)
        const existing = get<{ id: string }>(
          'SELECT id FROM products WHERE tenant_id = ? AND provider_native_id = ?',
          [tenantId, item.providerNativeId],
        )
        if (existing) {
          // A provider that carries no imagery or no inventory must not wipe
          // what the merchant filled in here. Razorpay's Items API has neither,
          // so a sync that overwrote both would erase their work every time.
          const current = products.byId(tenantId, String(existing.id))
          const images = item.images.length > 0 ? item.images : (current?.images ?? [])
          const stock =
            item.stock === STOCK_UNTRACKED && current ? current.stock : item.stock
          run(
            `UPDATE products SET name = ?, description = ?, price_minor = ?, currency = ?, images = ?,
               stock = ?, category = ?, attributes = ?, is_active = 1, source = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ?`,
            [
              item.name,
              item.description,
              item.priceMinor,
              item.currency,
              JSON.stringify(images),
              stock,
              item.category ?? current?.category ?? null,
              JSON.stringify(item.attributes),
              source,
              now,
              tenantId,
              existing.id,
            ],
          )
          updated += 1
        } else {
          products.create({ tenantId, source, ...item })
          created += 1
        }
      }
      const stale = all<{ id: string; provider_native_id: string }>(
        'SELECT id, provider_native_id FROM products WHERE tenant_id = ? AND source = ? AND is_active = 1',
        [tenantId, source],
      ).filter((r) => !seen.has(String(r.provider_native_id)))
      for (const row of stale) {
        run('UPDATE products SET is_active = 0, updated_at = ? WHERE tenant_id = ? AND id = ?', [
          now,
          tenantId,
          row.id,
        ])
      }
      return { created, updated, deactivated: stale.length }
    })
  },
}

// ── conversations, messages, provenance ─────────────────────────────────────

export const conversations = {
  ensure(tenantId: string, customerSessionId: string): Conversation {
    const existing = get('SELECT * FROM conversations WHERE tenant_id = ? AND customer_session_id = ?', [
      tenantId,
      customerSessionId,
    ])
    if (existing) {
      run('UPDATE conversations SET last_active_at = ? WHERE id = ?', [nowIso(), existing.id])
      return {
        id: String(existing.id),
        tenantId,
        customerSessionId,
        startedAt: String(existing.started_at),
        lastActiveAt: nowIso(),
      }
    }
    const now = nowIso()
    const conversationId = id('cnv')
    run(
      `INSERT INTO conversations (id, tenant_id, customer_session_id, started_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)`,
      [conversationId, tenantId, customerSessionId, now, now],
    )
    return { id: conversationId, tenantId, customerSessionId, startedAt: now, lastActiveAt: now }
  },

  byId(tenantId: string, conversationId: string): Conversation | undefined {
    const r = get('SELECT * FROM conversations WHERE tenant_id = ? AND id = ?', [
      tenantId,
      conversationId,
    ])
    if (!r) return undefined
    return {
      id: String(r.id),
      tenantId,
      customerSessionId: String(r.customer_session_id),
      startedAt: String(r.started_at),
      lastActiveAt: String(r.last_active_at),
    }
  },

  countForTenant(tenantId: string): number {
    const r = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ?', [
      tenantId,
    ])
    return Number(r?.n ?? 0)
  },
}

export const messages = {
  list(tenantId: string, conversationId: string): StoredMessage[] {
    return all(
      'SELECT * FROM messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY seq',
      [tenantId, conversationId],
    ).map((r) => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      tenantId: String(r.tenant_id),
      role: String(r.role) as StoredMessage['role'],
      content: String(r.content),
      toolCalls: json<StoredMessage['toolCalls']>(r.tool_calls, null),
      toolResults: json<StoredMessage['toolResults']>(r.tool_results, null),
      ui: json<UiComponent[] | null>(r.ui, null),
      createdAt: String(r.created_at),
      seq: Number(r.seq),
    }))
  },

  append(input: {
    tenantId: string
    conversationId: string
    role: StoredMessage['role']
    content: string
    toolCalls?: StoredMessage['toolCalls']
    toolResults?: StoredMessage['toolResults']
    ui?: UiComponent[] | null
  }): StoredMessage {
    const next = get<{ n: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?',
      [input.conversationId],
    )
    const seq = Number(next?.n ?? 1)
    const messageId = id('msg')
    run(
      `INSERT INTO messages (id, conversation_id, tenant_id, role, content, tool_calls, tool_results, ui, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        input.conversationId,
        input.tenantId,
        input.role,
        input.content,
        input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        input.toolResults ? JSON.stringify(input.toolResults) : null,
        input.ui ? JSON.stringify(input.ui) : null,
        nowIso(),
        seq,
      ],
    )
    return messages.list(input.tenantId, input.conversationId).find((m) => m.id === messageId)!
  },
}

/**
 * Provenance. Cart writes and presentation payloads accept only product ids
 * recorded here for this conversation — adapted from the `seen_products`
 * session state and cart gates in anthropics/commerce-agents.
 */
export const provenance = {
  remember(tenantId: string, conversationId: string, productIds: string[]): void {
    if (productIds.length === 0) return
    const now = nowIso()
    for (const productId of productIds) {
      run(
        `INSERT INTO seen_products (conversation_id, tenant_id, product_id, seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, product_id) DO UPDATE SET seen_at = excluded.seen_at`,
        [conversationId, tenantId, productId, now],
      )
    }
  },

  has(tenantId: string, conversationId: string, productId: string): boolean {
    return (
      get('SELECT 1 FROM seen_products WHERE tenant_id = ? AND conversation_id = ? AND product_id = ?', [
        tenantId,
        conversationId,
        productId,
      ]) !== undefined
    )
  },

  seenIds(tenantId: string, conversationId: string): Set<string> {
    const rows = all<{ product_id: string }>(
      'SELECT product_id FROM seen_products WHERE tenant_id = ? AND conversation_id = ?',
      [tenantId, conversationId],
    )
    return new Set(rows.map((r) => String(r.product_id)))
  },
}

// ── carts ───────────────────────────────────────────────────────────────────

function toCartItem(r: Record<string, unknown>): CartItem {
  return {
    id: String(r.id),
    cartId: String(r.cart_id),
    tenantId: String(r.tenant_id),
    productId: String(r.product_id),
    quantity: Number(r.quantity),
    unitPriceMinor: Number(r.unit_price_minor),
    addedAt: String(r.added_at),
  }
}

export const carts = {
  /** The conversation's open cart, created on first use. */
  ensureOpen(tenantId: string, conversationId: string): Cart {
    const existing = get(
      `SELECT * FROM carts WHERE tenant_id = ? AND conversation_id = ? AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, conversationId],
    )
    if (existing) return carts.byId(tenantId, String(existing.id))!
    const now = nowIso()
    const cartId = id('crt')
    run(
      `INSERT INTO carts (id, tenant_id, conversation_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?)`,
      [cartId, tenantId, conversationId, now, now],
    )
    return carts.byId(tenantId, cartId)!
  },

  byId(tenantId: string, cartId: string): Cart | undefined {
    const r = get('SELECT * FROM carts WHERE tenant_id = ? AND id = ?', [tenantId, cartId])
    if (!r) return undefined
    const items = all('SELECT * FROM cart_items WHERE tenant_id = ? AND cart_id = ? ORDER BY added_at', [
      tenantId,
      cartId,
    ]).map(toCartItem)
    return {
      id: String(r.id),
      tenantId,
      conversationId: String(r.conversation_id),
      status: String(r.status) as CartStatus,
      items,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }
  },

  addItem(
    tenantId: string,
    cartId: string,
    productId: string,
    quantity: number,
    unitPriceMinor: number,
  ): Cart {
    const now = nowIso()
    run(
      `INSERT INTO cart_items (id, cart_id, tenant_id, product_id, quantity, unit_price_minor, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cart_id, product_id) DO UPDATE SET quantity = cart_items.quantity + excluded.quantity`,
      [id('cit'), cartId, tenantId, productId, quantity, unitPriceMinor, now],
    )
    run('UPDATE carts SET updated_at = ? WHERE tenant_id = ? AND id = ?', [now, tenantId, cartId])
    return carts.byId(tenantId, cartId)!
  },

  setQuantity(tenantId: string, cartId: string, productId: string, quantity: number): Cart {
    if (quantity <= 0) return carts.removeItem(tenantId, cartId, productId)
    run(
      'UPDATE cart_items SET quantity = ? WHERE tenant_id = ? AND cart_id = ? AND product_id = ?',
      [quantity, tenantId, cartId, productId],
    )
    run('UPDATE carts SET updated_at = ? WHERE tenant_id = ? AND id = ?', [nowIso(), tenantId, cartId])
    return carts.byId(tenantId, cartId)!
  },

  removeItem(tenantId: string, cartId: string, productId: string): Cart {
    run('DELETE FROM cart_items WHERE tenant_id = ? AND cart_id = ? AND product_id = ?', [
      tenantId,
      cartId,
      productId,
    ])
    run('UPDATE carts SET updated_at = ? WHERE tenant_id = ? AND id = ?', [nowIso(), tenantId, cartId])
    return carts.byId(tenantId, cartId)!
  },

  clear(tenantId: string, cartId: string): Cart {
    run('DELETE FROM cart_items WHERE tenant_id = ? AND cart_id = ?', [tenantId, cartId])
    run('UPDATE carts SET updated_at = ? WHERE tenant_id = ? AND id = ?', [nowIso(), tenantId, cartId])
    return carts.byId(tenantId, cartId)!
  },

  /** The most recent cart locked by a checkout that was never paid. */
  latestLocked(tenantId: string, conversationId: string): Cart | undefined {
    const row = get<{ id: string }>(
      `SELECT id FROM carts WHERE tenant_id = ? AND conversation_id = ? AND status = 'locked'
       ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, conversationId],
    )
    return row ? carts.byId(tenantId, String(row.id)) : undefined
  },

  setStatus(tenantId: string, cartId: string, status: CartStatus): void {
    run('UPDATE carts SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', [
      status,
      nowIso(),
      tenantId,
      cartId,
    ])
  },
}

// ── orders ──────────────────────────────────────────────────────────────────

export const orders = {
  create(input: {
    tenantId: string
    cartId: string
    conversationId: string
    totalAmountMinor: number
    currency: string
    providerType: ProviderType
    providerOrderId: string | null
    lineItems: OrderLineItem[]
    status?: OrderStatus
  }): Order {
    const now = nowIso()
    const orderId = id('ord')
    run(
      `INSERT INTO orders
         (id, tenant_id, cart_id, conversation_id, total_amount_minor, currency, status,
          provider_type, provider_order_id, line_items, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        input.tenantId,
        input.cartId,
        input.conversationId,
        input.totalAmountMinor,
        input.currency,
        input.status ?? 'awaiting_payment',
        input.providerType,
        input.providerOrderId,
        JSON.stringify(input.lineItems),
        now,
        now,
      ],
    )
    return orders.byId(input.tenantId, orderId)!
  },

  byId(tenantId: string, orderId: string): Order | undefined {
    const r = get('SELECT * FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, orderId])
    return r ? toOrder(r) : undefined
  },

  byProviderOrderId(tenantId: string, providerOrderId: string): Order | undefined {
    const r = get('SELECT * FROM orders WHERE tenant_id = ? AND provider_order_id = ?', [
      tenantId,
      providerOrderId,
    ])
    return r ? toOrder(r) : undefined
  },

  listForTenant(tenantId: string, limit = 50): Order[] {
    return all('SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [
      tenantId,
      limit,
    ]).map(toOrder)
  },

  listForConversation(tenantId: string, conversationId: string, limit = 10): Order[] {
    return all(
      'SELECT * FROM orders WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?',
      [tenantId, conversationId, limit],
    ).map(toOrder)
  },

  setStatus(
    tenantId: string,
    orderId: string,
    status: OrderStatus,
    patch: { providerPaymentId?: string | null; failureReason?: string | null } = {},
  ): Order | undefined {
    const sets = ['status = ?', 'updated_at = ?']
    const params: unknown[] = [status, nowIso()]
    if (patch.providerPaymentId !== undefined) {
      sets.push('provider_payment_id = ?')
      params.push(patch.providerPaymentId)
    }
    if (patch.failureReason !== undefined) {
      sets.push('failure_reason = ?')
      params.push(patch.failureReason)
    }
    params.push(tenantId, orderId)
    run(`UPDATE orders SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, params)
    return orders.byId(tenantId, orderId)
  },

  /** Orders for this conversation that could still be paid. */
  pendingForConversation(tenantId: string, conversationId: string): Order[] {
    return all(
      `SELECT * FROM orders
       WHERE tenant_id = ? AND conversation_id = ? AND status IN ('created', 'awaiting_payment')
       ORDER BY created_at`,
      [tenantId, conversationId],
    ).map(toOrder)
  },

  /** Freezes the delivery address onto the order. */
  setShippingAddress(tenantId: string, orderId: string, address: ShippingAddress): void {
    run('UPDATE orders SET shipping_address = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', [
      JSON.stringify(address),
      nowIso(),
      tenantId,
      orderId,
    ])
  },

  /**
   * The last address this conversation used, for pre-filling the form.
   *
   * Scoped to the conversation rather than to a customer account, because
   * there are no customer accounts — the session cookie is the identity, so
   * this remembers within one person's thread and nowhere wider.
   */
  lastShippingAddress(tenantId: string, conversationId: string): ShippingAddress | null {
    const r = get<{ shipping_address: string | null }>(
      `SELECT shipping_address FROM orders
       WHERE tenant_id = ? AND conversation_id = ? AND shipping_address IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, conversationId],
    )
    return r?.shipping_address ? json<ShippingAddress | null>(r.shipping_address, null) : null
  },

  /**
   * Every distinct address this customer has used, most recent first.
   *
   * Derived from their own orders rather than kept in an address book, because
   * there is no customer account to hang one off — the session cookie is the
   * identity. Capped, because this renders inside a chat card and a list of
   * fifteen addresses is a scrolling problem, not a convenience.
   */
  savedShippingAddresses(
    tenantId: string,
    conversationId: string,
    limit = 5,
  ): ShippingAddress[] {
    const rows = all<{ shipping_address: string }>(
      `SELECT shipping_address FROM orders
       WHERE tenant_id = ? AND conversation_id = ? AND shipping_address IS NOT NULL
       ORDER BY created_at DESC`,
      [tenantId, conversationId],
    )

    const seen = new Set<string>()
    const out: ShippingAddress[] = []
    for (const row of rows) {
      const address = json<ShippingAddress | null>(row.shipping_address, null)
      if (!address) continue
      const key = addressKey(address)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(address)
      if (out.length === limit) break
    }
    return out
  },

  setProviderOrderId(tenantId: string, orderId: string, providerOrderId: string): void {
    run('UPDATE orders SET provider_order_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', [
      providerOrderId,
      nowIso(),
      tenantId,
      orderId,
    ])
  },

  revenueMinor(tenantId: string): number {
    const r = get<{ total: number | null }>(
      "SELECT SUM(total_amount_minor) AS total FROM orders WHERE tenant_id = ? AND status = 'paid'",
      [tenantId],
    )
    return Number(r?.total ?? 0)
  },
}

// ── API keys ────────────────────────────────────────────────────────────────

export interface ApiKeyRecord {
  id: string
  tenantId: string
  name: string
  prefix: string
  scope: 'read' | 'write'
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

function toApiKey(r: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    prefix: String(r.prefix),
    scope: String(r.scope) as 'read' | 'write',
    createdAt: String(r.created_at),
    lastUsedAt: (r.last_used_at as string) ?? null,
    revokedAt: (r.revoked_at as string) ?? null,
  }
}

export const apiKeys = {
  list(tenantId: string): ApiKeyRecord[] {
    return all('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC', [
      tenantId,
    ]).map(toApiKey)
  },

  create(input: {
    tenantId: string
    name: string
    keyHash: string
    prefix: string
    scope: 'read' | 'write'
  }): ApiKeyRecord {
    const keyId = id('key')
    run(
      `INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [keyId, input.tenantId, input.name, input.keyHash, input.prefix, input.scope, nowIso()],
    )
    return apiKeys.list(input.tenantId).find((k) => k.id === keyId)!
  },

  /** Resolves a presented key. Revoked keys resolve to nothing. */
  byHash(keyHash: string): (ApiKeyRecord & { keyHash: string }) | undefined {
    const r = get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [keyHash])
    return r ? { ...toApiKey(r), keyHash: String(r.key_hash) } : undefined
  },

  touch(keyId: string): void {
    run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [nowIso(), keyId])
  },

  revoke(tenantId: string, keyId: string): boolean {
    return (
      run('UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL', [
        nowIso(),
        tenantId,
        keyId,
      ]).changes > 0
    )
  },
}

// ── audit ───────────────────────────────────────────────────────────────────

/**
 * Append-only. Every cart lock, order creation, payment attempt, confirmation,
 * refund, and held checkout lands here with its tenant, amount, outcome, and
 * the agent's stated reasoning when the entry came from a tool call.
 */
export const audit = {
  record(input: {
    tenantId: string
    conversationId?: string | null
    cartId?: string | null
    orderId?: string | null
    actionType: AuditAction
    amountMinor?: number | null
    currency?: string | null
    outcome: AuditOutcome
    reasoning?: string | null
    detail?: Record<string, unknown> | null
  }): AuditLogEntry {
    const entryId = id('aud')
    const now = nowIso()
    run(
      `INSERT INTO audit_log
         (id, tenant_id, conversation_id, cart_id, order_id, action_type, amount_minor, currency,
          outcome, reasoning, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        input.tenantId,
        input.conversationId ?? null,
        input.cartId ?? null,
        input.orderId ?? null,
        input.actionType,
        input.amountMinor ?? null,
        input.currency ?? null,
        input.outcome,
        input.reasoning ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
        now,
      ],
    )
    return audit.list(input.tenantId, 1)[0]!
  },

  list(tenantId: string, limit = 200): AuditLogEntry[] {
    return all('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [
      tenantId,
      limit,
    ]).map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      conversationId: (r.conversation_id as string) ?? null,
      cartId: (r.cart_id as string) ?? null,
      orderId: (r.order_id as string) ?? null,
      actionType: String(r.action_type) as AuditAction,
      amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
      currency: (r.currency as string) ?? null,
      outcome: String(r.outcome) as AuditOutcome,
      reasoning: (r.reasoning as string) ?? null,
      detail: json<Record<string, unknown> | null>(r.detail, null),
      createdAt: String(r.created_at),
    }))
  },
}
