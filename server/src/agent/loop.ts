/**
 * The turn loop.
 *
 * One agent, one continuous conversation state, modular skills — not a router
 * over subagents. A shopping conversation is one state (cart, history,
 * preferences) and splitting it across agents loses that state and adds
 * latency. Adapted from the Messages-API orchestrator in
 * anthropics/commerce-agents (Apache-2.0).
 *
 * Everything here sits above the ModelProvider interface: swapping
 * LLM_PROVIDER changes which backend answers and nothing in this file.
 */
import { conversations, carts, messages as messageStore, products } from '../db/repo.js'
import type { Tenant, ToolCallRecord, ToolResultRecord, UiComponent } from '../domain/types.js'
import { log } from '../lib/logger.js'
import { modelProvider } from '../models/index.js'
import { ModelProviderError, type ModelMessage, type ModelToolResult } from '../models/types.js'
import { DEFAULT_AGENT_CONFIG, type AgentConfig } from './config.js'
import { execute, type ExecutionContext } from './executor.js'
import { pruneComponents } from './presentation.js'
import { buildDynamicContext, buildStaticSystem } from './prompt.js'
import { ConvoStorefront, ensureSession, priceCart, type StorefrontSession } from './storefront.js'
import { buildTools, isPresentationTool } from './tools.js'

/** What the chat page receives, in order, over SSE. */
export type TurnEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'thinking' }
  | { type: 'text_delta'; text: string }
  /** A tool call's status line — "looking through the catalogue…". */
  | { type: 'status'; text: string }
  | { type: 'tool_started'; name: string }
  | { type: 'component'; component: UiComponent }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string }

export interface TurnRequest {
  tenant: Tenant
  customerSessionId: string
  message: string
  config?: AgentConfig
  signal?: AbortSignal
}

const backend = new ConvoStorefront()

export async function* runTurn(request: TurnRequest): AsyncGenerator<TurnEvent> {
  const config = request.config ?? DEFAULT_AGENT_CONFIG
  const { tenant } = request
  const session = ensureSession(tenant.id, request.customerSessionId, tenant.currency)

  yield { type: 'conversation', conversationId: session.conversationId }

  // The customer's message is stored before the model sees it, so a turn that
  // fails halfway still leaves a faithful transcript.
  messageStore.append({
    tenantId: tenant.id,
    conversationId: session.conversationId,
    role: 'user',
    content: request.message,
  })

  yield { type: 'thinking' }

  const provider = modelProvider(tenant.llmProvider)
  const tools = buildTools(config)
  const allowedTools = new Set(tools.map((tool) => tool.name))

  const staticSystem = buildStaticSystem(tenant)
  const systemPrompt = staticSystem + dynamicContext(session, tenant)

  const history = toModelMessages(session, config)
  const collected: UiComponent[] = []
  const turnToolCalls: ToolCallRecord[] = []
  const turnToolResults: ToolResultRecord[] = []
  let assistantText = ''
  let forceTool = groundingRule(request.message, tools.map((t) => t.name))

  try {
    for (let round = 0; round < config.maxToolIterations; round += 1) {
      const lastRound = round === config.maxToolIterations - 1

      const stream = provider.streamAgentTurn({
        systemPrompt,
        cacheableSystemPrefixLength: staticSystem.length,
        messages: history,
        // The final round runs without tools so the model must answer in text.
        tools: lastRound ? [] : tools,
        maxTokens: 2048,
        ...(forceTool && !lastRound ? { forceTool } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })

      let roundText = ''
      let next = await stream.next()
      while (!next.done) {
        const event = next.value
        if (event.type === 'text_delta') {
          roundText += event.text
          yield { type: 'text_delta', text: event.text }
        } else if (event.type === 'tool_call_start') {
          yield { type: 'tool_started', name: event.name }
        } else if (event.type === 'tool_call_status') {
          yield { type: 'status', text: event.status }
        }
        next = await stream.next()
      }
      const response = next.value

      forceTool = undefined
      if (roundText.trim() !== '') {
        assistantText += (assistantText === '' ? '' : '\n\n') + roundText.trim()
      }

      if (response.toolCalls.length === 0) break

      // ── run the calls ─────────────────────────────────────────────────────
      const context: ExecutionContext = {
        session,
        tenant,
        config,
        backend,
        allowedTools,
        reasoning: roundText.trim().slice(0, 500),
      }

      const results: ModelToolResult[] = []
      for (const call of response.toolCalls) {
        turnToolCalls.push({ id: call.id, name: call.name, input: call.input })
        const executed = await execute(context, call.name, call.input)

        if (executed.status && !isPresentationTool(call.name)) {
          yield { type: 'status', text: executed.status }
        }
        for (const component of pruneComponents(executed.components)) {
          collected.push(component)
          yield { type: 'component', component }
        }

        results.push({
          toolCallId: call.id,
          content: executed.outcome.text,
          isError: executed.outcome.isError,
        })
        turnToolResults.push({
          toolCallId: call.id,
          content: executed.outcome.text.slice(0, 4000),
          isError: executed.outcome.isError,
        })

        if (executed.outcome.heldBy) {
          log.info('tool call held', {
            tenantId: tenant.id,
            tool: call.name,
            gate: executed.outcome.heldBy,
          })
        }
      }

      history.push({ role: 'assistant', content: roundText, toolCalls: response.toolCalls })
      history.push({ role: 'tool', results })

      // A turn whose last components are a card plus its chips is complete;
      // the model does not need another round to say so.
      if (endsTurn(response.toolCalls.map((call) => call.name))) break
    }
  } catch (error) {
    const message =
      error instanceof ModelProviderError
        ? 'The assistant is having trouble responding right now. Try again in a moment.'
        : 'Something went wrong while answering. Try again in a moment.'
    log.error('agent turn failed', {
      tenantId: tenant.id,
      provider: provider.name,
      message: error instanceof Error ? error.message : 'unknown',
    })
    // The partial reply is still stored, so the transcript stays honest.
    persist(tenant.id, session.conversationId, assistantText, turnToolCalls, turnToolResults, collected)
    yield { type: 'error', message }
    return
  }

  if (assistantText.trim() === '' && collected.length === 0) {
    assistantText = "I didn't catch that. Tell me what you're looking for and I'll pull it up."
  }

  const stored = persist(
    tenant.id,
    session.conversationId,
    assistantText,
    turnToolCalls,
    turnToolResults,
    collected,
  )
  yield { type: 'done', messageId: stored }
}

function persist(
  tenantId: string,
  conversationId: string,
  text: string,
  toolCalls: ToolCallRecord[],
  toolResults: ToolResultRecord[],
  components: UiComponent[],
): string {
  const message = messageStore.append({
    tenantId,
    conversationId,
    role: 'assistant',
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    toolResults: toolResults.length > 0 ? toolResults : null,
    ui: components.length > 0 ? components : null,
  })
  return message.id
}

function dynamicContext(session: StorefrontSession, tenant: Tenant): string {
  const cart = carts.ensureOpen(session.tenantId, session.conversationId)
  const priced = priceCart(session, cart.id)
  const catalog = products.list(session.tenantId)
  const categories = [...new Set(catalog.map((p) => p.category).filter((c): c is string => Boolean(c)))]
  return buildDynamicContext({ tenant, cart: priced, catalogSize: catalog.length, categories })
}

/**
 * The stored transcript as model messages, oldest dropped first past the
 * history cap. Tool results are not replayed across turns: a later turn reads
 * what it needs with a fresh call, which is also what keeps a stale price out
 * of the context.
 */
function toModelMessages(session: StorefrontSession, config: AgentConfig): ModelMessage[] {
  const stored = messageStore.list(session.tenantId, session.conversationId)
  const recent = stored.slice(-config.maxHistoryMessages)
  const out: ModelMessage[] = []
  for (const message of recent) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content })
      continue
    }
    // The assistant's own presented picks are what "the second one" resolves
    // against, so those calls are replayed; reads are not.
    const picks = (message.toolCalls ?? []).filter((call) => call.name === 'present_products')
    if (message.content.trim() === '' && picks.length === 0) continue
    out.push({
      role: 'assistant',
      content: message.content,
      toolCalls: picks.map((call) => ({ id: call.id, name: call.name, input: call.input })),
    })
    if (picks.length > 0) {
      out.push({
        role: 'tool',
        results: picks.map((call) => ({
          toolCallId: call.id,
          content: 'Shown to the customer.',
          isError: false,
        })),
      })
    }
  }
  // The model must start from a user turn.
  while (out.length > 0 && out[0]!.role !== 'user') out.shift()
  return out
}

/**
 * Grounding: certain message shapes start from a read before the model
 * answers, forced with the provider's tool-choice. Adapted from
 * `commerce_common/grounding.py`.
 */
function groundingRule(message: string, available: string[]): string | undefined {
  const text = message.toLowerCase()
  if (
    available.includes('get_orders') &&
    (/\bord_[a-z0-9]+/i.test(message) ||
      /\b(my|the|that|this)\s+order\b/.test(text) ||
      /\b(order status|where is my|track(ing)? my|did (my|the) (order|payment))\b/.test(text))
  ) {
    return 'get_orders'
  }
  return undefined
}

/** A turn is done once the chips have gone out. */
function endsTurn(names: string[]): boolean {
  return names.includes('present_suggestions')
}

export { conversations }
