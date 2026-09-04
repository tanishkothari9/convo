/**
 * A deterministic, no-network ModelProvider.
 *
 * It is a real implementation of the interface, not a stub: it reads the same
 * conversation history, is handed the same tool definitions, and answers with
 * the same typed tool calls as Claude or GPT would. Every gate, provenance
 * check, server-side total, signature verification, and audit entry downstream
 * runs identically — so Convo is fully demonstrable with no API key, and
 * setting LLM_PROVIDER=anthropic (or openai) swaps the reasoning without
 * changing anything below it.
 *
 * What it is not: it does not generalise. It handles the shopping intents a
 * storefront actually sees — browse, filter, refer back, cart, checkout — and
 * falls back to a search for anything else.
 */
import type {
  AgentResponse,
  AgentTurnRequest,
  ModelMessage,
  ModelProvider,
  ModelStreamEvent,
  ModelToolCall,
} from './types.js'

let counter = 0
const callId = () => `call_scripted_${(counter += 1)}`

type Intent =
  | { kind: 'greeting' }
  | { kind: 'search'; query: string; maxPriceMinor?: number; minPriceMinor?: number; category?: string }
  | { kind: 'add'; reference: Reference; quantity: number }
  | { kind: 'remove'; reference: Reference }
  | { kind: 'view_cart' }
  | { kind: 'checkout' }
  | { kind: 'help' }

type Reference = { kind: 'ordinal'; index: number } | { kind: 'text'; text: string } | { kind: 'last' }

export class ScriptedModelProvider implements ModelProvider {
  readonly name = 'scripted'
  readonly model = 'convo-scripted-v1'
  readonly available = true

  async runAgentTurn(request: AgentTurnRequest): Promise<AgentResponse> {
    const plan = plan_(request)
    return { text: plan.text, toolCalls: plan.toolCalls, stopReason: plan.stopReason }
  }

  async *streamAgentTurn(
    request: AgentTurnRequest,
  ): AsyncGenerator<ModelStreamEvent, AgentResponse, void> {
    const plan = plan_(request)

    // Text first, in word-sized chunks, so the chat page streams the same way
    // it does against a hosted model.
    for (const chunk of chunkText(plan.text)) {
      await sleep(14)
      yield { type: 'text_delta', text: chunk }
    }

    for (const call of plan.toolCalls) {
      yield { type: 'tool_call_start', id: call.id, name: call.name }
      const status = call.input.status
      if (typeof status === 'string' && status !== '') {
        await sleep(60)
        yield { type: 'tool_call_status', id: call.id, name: call.name, status }
      }
      await sleep(90)
      yield { type: 'tool_call', call }
    }

    return { text: plan.text, toolCalls: plan.toolCalls, stopReason: plan.stopReason }
  }
}

interface Plan {
  text: string
  toolCalls: ModelToolCall[]
  stopReason: AgentResponse['stopReason']
}

function plan_(request: AgentTurnRequest): Plan {
  const available = new Set(request.tools.map((t) => t.name))
  const has = (name: string) => available.has(name)

  // A forced tool means a grounding rule fired; obey it.
  if (request.forceTool) {
    const intent = readIntent(request.messages)
    return {
      text: '',
      toolCalls: [forcedCall(request.forceTool, intent, request.messages)],
      stopReason: 'tool_use',
    }
  }

  const results = trailingToolResults(request.messages)
  const intent = readIntent(request.messages)

  // ── Second round: tool results are in, so present the outcome. ────────────
  if (results.length > 0) {
    return present(intent, results, has, request.messages)
  }

  // ── First round: read the request and act. ────────────────────────────────
  switch (intent.kind) {
    case 'greeting':
    case 'help':
      return {
        text:
          intent.kind === 'greeting'
            ? "Hello. Tell me what you're looking for and I'll pull it up — an occasion, a colour, or a budget all work."
            : "I can search the catalogue, keep a cart for you, and take you through checkout. What are you after?",
        toolCalls: has('present_suggestions')
          ? [
              call('present_suggestions', {
                suggestions: ['Show me what you have', 'Something under ₹5,000', 'What is popular'],
              }),
            ]
          : [],
        stopReason: 'end_turn',
      }

    case 'search':
      return {
        text: '',
        toolCalls: [
          call('search_catalog', {
            status: 'looking through the catalogue',
            query: intent.query,
            ...(intent.maxPriceMinor !== undefined || intent.minPriceMinor !== undefined || intent.category
              ? {
                  filters: {
                    ...(intent.maxPriceMinor !== undefined ? { max_price: intent.maxPriceMinor / 100 } : {}),
                    ...(intent.minPriceMinor !== undefined ? { min_price: intent.minPriceMinor / 100 } : {}),
                    ...(intent.category ? { category: intent.category } : {}),
                  },
                }
              : {}),
            limit: 6,
          }),
        ],
        stopReason: 'tool_use',
      }

    case 'add': {
      const productId = resolve(intent.reference, request.messages)
      if (!productId) {
        return {
          text: '',
          toolCalls: [
            call('search_catalog', {
              status: 'finding that for you',
              query: intent.reference.kind === 'text' ? intent.reference.text : 'featured',
              limit: 4,
            }),
          ],
          stopReason: 'tool_use',
        }
      }
      return {
        text: '',
        toolCalls: [
          call('manage_cart', {
            status: 'putting your cart together',
            action: 'add',
            product_id: productId,
            quantity: intent.quantity,
          }),
        ],
        stopReason: 'tool_use',
      }
    }

    case 'remove': {
      const productId = resolve(intent.reference, request.messages)
      if (!productId) {
        return {
          text: "I'm not sure which one to take out — tell me the name and I'll remove it.",
          toolCalls: [],
          stopReason: 'end_turn',
        }
      }
      return {
        text: '',
        toolCalls: [
          call('manage_cart', {
            status: 'updating your cart',
            action: 'remove',
            product_id: productId,
          }),
        ],
        stopReason: 'tool_use',
      }
    }

    case 'view_cart':
      return {
        text: '',
        toolCalls: [call('manage_cart', { status: 'opening your cart', action: 'view' })],
        stopReason: 'tool_use',
      }

    case 'checkout':
      return {
        text: '',
        toolCalls: [
          call('checkout', {
            status: 'preparing your order',
            note: 'Check the items and the total before you pay.',
          }),
        ],
        stopReason: 'tool_use',
      }
  }
}

/** After tool results come back: render the component and close the turn. */
function present(
  intent: Intent,
  results: Array<{ name: string; content: string; isError: boolean }>,
  has: (name: string) => boolean,
  messages: ModelMessage[],
): Plan {
  const failed = results.find((r) => r.isError)
  if (failed) {
    return {
      text: plainFailure(failed.content),
      toolCalls: has('present_suggestions')
        ? [call('present_suggestions', { suggestions: ['Show me something else', 'Open my cart'] })]
        : [],
      stopReason: 'end_turn',
    }
  }

  const held = results.find((r) => /^\[held:/.test(r.content))
  if (held) {
    return {
      text: "I couldn't complete that just now. Let me show you what's available instead.",
      toolCalls: [
        call('search_catalog', { status: 'looking through the catalogue', query: 'featured', limit: 4 }),
      ],
      stopReason: 'tool_use',
    }
  }

  const search = results.find((r) => r.name === 'search_catalog')
  if (search) {
    const ids = productIdsIn(search.content)
    if (ids.length === 0) {
      return {
        text: "I couldn't find anything matching that in the catalogue. Try a different colour, fabric, or budget and I'll look again.",
        toolCalls: has('present_suggestions')
          ? [
              call('present_suggestions', {
                suggestions: ['Show me everything', 'Something under ₹5,000'],
              }),
            ]
          : [],
        stopReason: 'end_turn',
      }
    }
    // If the customer asked to add something, the search was only to resolve it.
    if (intent.kind === 'add') {
      return {
        text: '',
        toolCalls: [
          call('manage_cart', {
            status: 'putting your cart together',
            action: 'add',
            product_id: ids[0]!,
            quantity: intent.quantity,
          }),
        ],
        stopReason: 'tool_use',
      }
    }
    const picks = ids.slice(0, 6).map((product_id, index) => ({
      product_id,
      ...(index === 0 ? { reason: 'Closest match to what you described' } : {}),
    }))
    return {
      text: ids.length === 1 ? "Here's what fits." : `Here are ${picks.length} that fit.`,
      toolCalls: [
        call('present_products', { title: 'For you', layout: 'carousel', picks }),
        ...(has('present_suggestions')
          ? [
              call('present_suggestions', {
                suggestions: ['Add the first one', 'Show me something cheaper', 'Open my cart'],
              }),
            ]
          : []),
      ],
      stopReason: 'end_turn',
    }
  }

  const cart = results.find((r) => r.name === 'manage_cart')
  if (cart) {
    const empty = /cart is empty|0 items/i.test(cart.content)
    return {
      text: empty ? 'Your cart is empty right now.' : summarise(cart.content),
      toolCalls: [
        ...(empty ? [] : [call('present_cart', {})]),
        ...(has('present_suggestions')
          ? [
              call('present_suggestions', {
                suggestions: empty
                  ? ['Show me what you have', 'Something under ₹5,000']
                  : ['Check out', 'Keep shopping'],
              }),
            ]
          : []),
      ],
      stopReason: 'end_turn',
    }
  }

  const checkout = results.find((r) => r.name === 'checkout')
  if (checkout) {
    return {
      text: 'Your order is ready. Check the total, then pay when you are.',
      toolCalls: has('present_suggestions')
        ? [call('present_suggestions', { suggestions: ['Keep shopping'] })]
        : [],
      stopReason: 'end_turn',
    }
  }

  return {
    text: 'Done.',
    toolCalls: has('present_suggestions')
      ? [call('present_suggestions', { suggestions: ['Show me more', 'Open my cart'] })]
      : [],
    stopReason: 'end_turn',
  }
  void messages
}

// ── intent reading ──────────────────────────────────────────────────────────

const ORDINALS: Record<string, number> = {
  first: 0, '1st': 0, one: 0,
  second: 1, '2nd': 1, two: 1,
  third: 2, '3rd': 2, three: 2,
  fourth: 3, '4th': 3, four: 3,
  fifth: 4, '5th': 4, five: 4,
  last: -1,
}

function readIntent(messages: ModelMessage[]): Intent {
  const text = lastUserText(messages).toLowerCase().trim()
  if (text === '') return { kind: 'greeting' }

  if (/^(hi|hey|hello|namaste|yo|hola|good (morning|afternoon|evening))\b/.test(text)) {
    return { kind: 'greeting' }
  }
  if (/\b(what can you do|help me|how does this work|who are you)\b/.test(text)) {
    return { kind: 'help' }
  }
  if (/\b(check ?out|place (the |my )?order|pay now|proceed to pay|buy it now|complete (my )?order)\b/.test(text)) {
    return { kind: 'checkout' }
  }
  if (/\b(remove|delete|take (it |that )?out|drop)\b/.test(text)) {
    return { kind: 'remove', reference: readReference(text) }
  }
  if (/\b(my cart|the cart|show cart|open cart|what'?s in (my |the )?cart|view cart|basket)\b/.test(text)) {
    return { kind: 'view_cart' }
  }
  if (/\b(add|buy|i'?ll take|take the|get me|i want the|put .* in (my |the )?cart|order the)\b/.test(text)) {
    return { kind: 'add', reference: readReference(text), quantity: readQuantity(text) }
  }

  return { kind: 'search', query: cleanQuery(text), ...readPriceBounds(text) }
}

function readReference(text: string): Reference {
  for (const [word, index] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      return index === -1 ? { kind: 'last' } : { kind: 'ordinal', index }
    }
  }
  if (/\b(it|that one|this one|that)\b/.test(text)) return { kind: 'ordinal', index: 0 }
  const stripped = cleanQuery(text)
  return stripped === '' ? { kind: 'ordinal', index: 0 } : { kind: 'text', text: stripped }
}

function readQuantity(text: string): number {
  const digits = text.match(/\b(\d{1,2})\s*(?:x|pcs?|pieces?|of them|units?)?\b/)
  if (digits?.[1]) {
    const n = Number(digits[1])
    if (n >= 1 && n <= 20) return n
  }
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, a: 1, an: 1 }
  for (const [word, n] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return n
  }
  return 1
}

function readPriceBounds(text: string): { maxPriceMinor?: number; minPriceMinor?: number } {
  const normalise = (raw: string) => {
    const value = Number(raw.replace(/[,₹\s]/g, ''))
    if (!Number.isFinite(value)) return undefined
    // "5k" and "5 thousand" both mean 5000.
    return Math.round(value * 100)
  }
  const under = text.match(/\b(?:under|below|less than|cheaper than|upto|up to|within|max(?:imum)?)\s*₹?\s*([\d,]+)\s*(k|thousand)?/)
  const over = text.match(/\b(?:over|above|more than|at least|min(?:imum)?)\s*₹?\s*([\d,]+)\s*(k|thousand)?/)
  const bounds: { maxPriceMinor?: number; minPriceMinor?: number } = {}
  if (under?.[1]) {
    const base = normalise(under[1])
    if (base !== undefined) bounds.maxPriceMinor = under[2] ? base * 1000 : base
  }
  if (over?.[1]) {
    const base = normalise(over[1])
    if (base !== undefined) bounds.minPriceMinor = over[2] ? base * 1000 : base
  }
  return bounds
}

const FILLER =
  /\b(show|me|please|can|you|i|want|need|looking|for|some|something|a|an|the|do|have|got|any|find|search|get|add|buy|to|my|cart|and|is|are|there|would|like|of|in|with|under|below|over|above|less|than|more|at|least|upto|up|within|max|maximum|min|minimum|thousand|rs|inr|rupees)\b/g

function cleanQuery(text: string): string {
  const stripped = text
    .replace(/[₹]/g, ' ')
    .replace(/\b\d[\d,]*k?\b/g, ' ')
    .replace(FILLER, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped === '' ? 'featured' : stripped
}

// ── history reading ─────────────────────────────────────────────────────────

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role === 'user') return message.content
  }
  return ''
}

/** Tool results that arrived after the last user message — this turn's results. */
function trailingToolResults(
  messages: ModelMessage[],
): Array<{ name: string; content: string; isError: boolean }> {
  const out: Array<{ name: string; content: string; isError: boolean }> = []
  const names = new Map<string, string>()
  let seenUser = false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role === 'user') {
      seenUser = true
      break
    }
    if (message.role === 'assistant') {
      for (const c of message.toolCalls) names.set(c.id, c.name)
    }
  }
  if (!seenUser) return out
  let afterUser = false
  for (const message of messages) {
    if (message.role === 'user') {
      afterUser = true
      out.length = 0
      continue
    }
    if (!afterUser) continue
    if (message.role === 'assistant') {
      for (const c of message.toolCalls) names.set(c.id, c.name)
    }
    if (message.role === 'tool') {
      for (const result of message.results) {
        out.push({
          name: names.get(result.toolCallId) ?? '',
          content: result.content,
          isError: result.isError,
        })
      }
    }
  }
  // Presentation calls resolve without a meaningful result; ignore them.
  return out.filter((r) => !r.name.startsWith('present_'))
}

/** Product ids in a fenced tool result, in the order they appear. */
function productIdsIn(content: string): string[] {
  const ids = content.match(/\bprd_[a-z0-9]+/g) ?? []
  return [...new Set(ids)]
}

/**
 * Resolves "the second one" against the last set of products the agent
 * presented — the same mechanism the blueprint uses: references resolve from
 * the last structured tool call, never by matching against chat text.
 */
function resolve(reference: Reference, messages: ModelMessage[]): string | null {
  const presented = lastPresentedIds(messages)
  if (reference.kind === 'ordinal') return presented[reference.index] ?? null
  if (reference.kind === 'last') return presented.at(-1) ?? null
  // A text reference still needs a search to resolve.
  return null
}

function lastPresentedIds(messages: ModelMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    for (const call of [...message.toolCalls].reverse()) {
      if (call.name !== 'present_products') continue
      const picks = call.input.picks
      if (Array.isArray(picks)) {
        const ids = picks
          .map((pick) => (pick as { product_id?: unknown }).product_id)
          .filter((id): id is string => typeof id === 'string')
        if (ids.length > 0) return ids
      }
    }
  }
  return []
}

// ── helpers ─────────────────────────────────────────────────────────────────

function call(name: string, input: Record<string, unknown>): ModelToolCall {
  return { id: callId(), name, input }
}

function forcedCall(name: string, intent: Intent, messages: ModelMessage[]): ModelToolCall {
  if (name === 'search_catalog') {
    return call('search_catalog', {
      status: 'looking through the catalogue',
      query: intent.kind === 'search' ? intent.query : cleanQuery(lastUserText(messages)),
      limit: 6,
    })
  }
  if (name === 'manage_cart') return call('manage_cart', { status: 'opening your cart', action: 'view' })
  return call(name, {})
}

/** Turns a tool result line into a sentence, without inventing a figure. */
function summarise(content: string): string {
  const first = content.split('\n').find((line) => line.trim() !== '') ?? ''
  const cleaned = first.replace(/<[^>]*>/g, '').trim()
  return cleaned === '' ? 'Your cart is updated.' : cleaned
}

function plainFailure(content: string): string {
  const cleaned = content.replace(/<[^>]*>/g, '').trim()
  return cleaned === '' ? "That didn't go through. Try again in a moment." : cleaned
}

function chunkText(text: string): string[] {
  if (text === '') return []
  return text.match(/\S+\s*/g) ?? [text]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
