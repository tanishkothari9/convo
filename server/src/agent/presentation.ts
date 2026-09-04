/**
 * Presentation enrichment.
 *
 * The model selects and annotates; every fact on a component is joined from
 * server records here. Ids without provenance are dropped and reported back to
 * the model; a component with nothing left is refused. Adapted from
 * `commerce_common/presentation.py` and `shopping_agent/enrichment.py` in
 * anthropics/commerce-agents (Apache-2.0).
 *
 * This is why the chat page can render trustworthy cards: no price, stock
 * level, or product name on screen ever came from the model's text.
 */
import { products, provenance } from '../db/repo.js'
import type { UiComponent } from '../domain/types.js'
import { formatMoney } from '../lib/money.js'
import { sanitizeLabel, sanitizeSuggestionChips } from './fencing.js'
import { failed, ok, type ToolOutcome } from './outcome.js'
import { priceCart, type StorefrontSession } from './storefront.js'
import { cartComponent } from './gates.js'

export function presentProducts(
  session: StorefrontSession,
  input: Record<string, unknown>,
): ToolOutcome {
  const picks = Array.isArray(input.picks) ? input.picks : []
  if (picks.length === 0) {
    return failed('present_products needs at least one pick.')
  }

  const seen = provenance.seenIds(session.tenantId, session.conversationId)
  const wanted: Array<{ productId: string; reason: string | null }> = []
  const dropped: string[] = []

  for (const raw of picks.slice(0, 12)) {
    const pick = raw as { product_id?: unknown; reason?: unknown }
    const productId = typeof pick.product_id === 'string' ? pick.product_id : ''
    if (productId === '') continue
    if (!seen.has(productId)) {
      dropped.push(productId)
      continue
    }
    if (wanted.some((entry) => entry.productId === productId)) continue
    wanted.push({
      productId,
      reason: typeof pick.reason === 'string' ? sanitizeLabel(pick.reason, 140) : null,
    })
  }

  const records = new Map(
    products.byIds(session.tenantId, wanted.map((entry) => entry.productId)).map((p) => [p.id, p]),
  )

  const cards = wanted
    .filter((entry) => {
      if (records.has(entry.productId)) return true
      dropped.push(entry.productId)
      return false
    })
    .map((entry) => {
      const product = records.get(entry.productId)!
      return {
        product_id: product.id,
        name: product.name,
        description: product.description,
        image_url: product.images[0] ?? null,
        price_minor: product.priceMinor,
        price_display: formatMoney(product.priceMinor, product.currency),
        currency: product.currency,
        category: product.category,
        attributes: product.attributes,
        in_stock: product.stock > 0,
        stock: product.stock,
        reason: entry.reason,
      }
    })

  if (cards.length === 0) {
    return failed(
      dropped.length > 0
        ? `None of those product ids can be shown: ${dropped.join(', ')} were not returned by a tool this conversation. Search first, then present ids from the results.`
        : 'present_products had nothing to show.',
    )
  }

  const note =
    dropped.length > 0
      ? ` Dropped ${dropped.join(', ')}: not returned by a tool this conversation.`
      : ''

  return ok(`Showed ${cards.length} product card${cards.length === 1 ? '' : 's'}.${note}`, [
    {
      component: 'products',
      payload: {
        title: typeof input.title === 'string' ? sanitizeLabel(input.title, 80) : null,
        layout: ['carousel', 'grid', 'list'].includes(String(input.layout))
          ? String(input.layout)
          : 'carousel',
        items: cards,
      },
    },
  ])
}

export function presentCart(session: StorefrontSession, cartId: string): ToolOutcome {
  const priced = priceCart(session, cartId)
  return ok(
    priced.lines.length === 0 ? 'Showed the cart; it is empty.' : `Showed the cart (${priced.itemCount} items).`,
    [cartComponent(priced)],
  )
}

export function presentSuggestions(input: Record<string, unknown>): ToolOutcome {
  const raw = Array.isArray(input.suggestions) ? input.suggestions : []
  const chips = sanitizeSuggestionChips(raw.filter((c): c is string => typeof c === 'string'))
  if (chips.length === 0) {
    return failed(
      'Every suggestion was empty after sanitizing — send 1-4 short, plain-text suggestions.',
    )
  }
  return ok(`Showed ${chips.length} suggestion chip${chips.length === 1 ? '' : 's'}.`, [
    { component: 'suggestions', payload: { suggestions: chips } },
  ])
}

/** Strips components that carry nothing renderable. */
export function pruneComponents(components: UiComponent[]): UiComponent[] {
  return components.filter((component) => {
    if (component.component === 'products') {
      return Array.isArray(component.payload.items) && component.payload.items.length > 0
    }
    if (component.component === 'suggestions') {
      return Array.isArray(component.payload.suggestions) && component.payload.suggestions.length > 0
    }
    return true
  })
}
