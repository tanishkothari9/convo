/**
 * The OpenAI backend, on the Chat Completions API with function tool calling.
 *
 * Same interface, same internal tool contracts, different wire format: OpenAI
 * nests the schema under `function.parameters`, returns calls as
 * `tool_calls[].function.arguments` (a JSON *string*), and takes results back
 * as separate `role: "tool"` messages keyed by `tool_call_id`. The translation
 * both ways lives here so nothing above the ModelProvider interface changes.
 */
import { env } from '../env.js'
import { ModelProviderError } from './types.js'
import type {
  AgentResponse,
  AgentTurnRequest,
  ModelMessage,
  ModelProvider,
  ModelStreamEvent,
  ModelToolCall,
  StopReason,
  ToolDefinition,
} from './types.js'
import { parseToolInput, readStreamingStringField, sseEvents } from './stream.js'

interface OpenAIToolCall {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export class OpenAIModelProvider implements ModelProvider {
  readonly name = 'openai'

  constructor(
    readonly model: string = env.openaiModel,
    private readonly apiKey: string | undefined = env.openaiApiKey,
    private readonly baseUrl: string = env.openaiBaseUrl,
  ) {}

  get available(): boolean {
    return Boolean(this.apiKey)
  }

  private body(request: AgentTurnRequest, stream: boolean) {
    return {
      model: this.model,
      max_completion_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 1,
      messages: [
        { role: 'system', content: request.systemPrompt },
        ...toOpenAIMessages(request.messages),
      ],
      tools: request.tools.map(toOpenAITool),
      ...(request.forceTool
        ? { tool_choice: { type: 'function', function: { name: request.forceTool } } }
        : { tool_choice: 'auto' }),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }
  }

  private async send(request: AgentTurnRequest, stream: boolean): Promise<Response> {
    if (!this.apiKey) {
      throw new ModelProviderError('OPENAI_API_KEY is not set.')
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.body(request, stream)),
        signal: request.signal ?? AbortSignal.timeout(120_000),
      })
    } catch (cause) {
      throw new ModelProviderError(
        `Could not reach the OpenAI API (${cause instanceof Error ? cause.message : 'network error'}).`,
        true,
      )
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new ModelProviderError(
        `OpenAI API returned ${response.status}. ${extractMessage(detail)}`.trim(),
        response.status === 429 || response.status >= 500,
      )
    }
    return response
  }

  async runAgentTurn(request: AgentTurnRequest): Promise<AgentResponse> {
    const response = await this.send(request, false)
    const payload = (await response.json()) as {
      choices: Array<{
        message: { content: string | null; tool_calls?: OpenAIToolCall[] }
        finish_reason: string | null
      }>
      usage?: { prompt_tokens: number; completion_tokens: number }
    }
    const choice = payload.choices[0]
    const toolCalls: ModelToolCall[] = (choice?.message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? '',
      input: parseToolInput(call.function?.arguments ?? ''),
    }))
    return {
      text: choice?.message.content ?? '',
      toolCalls,
      stopReason: mapFinishReason(choice?.finish_reason),
      ...(payload.usage
        ? {
            usage: {
              inputTokens: payload.usage.prompt_tokens,
              outputTokens: payload.usage.completion_tokens,
            },
          }
        : {}),
    }
  }

  async *streamAgentTurn(
    request: AgentTurnRequest,
  ): AsyncGenerator<ModelStreamEvent, AgentResponse, void> {
    const response = await this.send(request, true)

    let text = ''
    let stopReason: StopReason = 'end_turn'
    let usage: AgentResponse['usage']
    // OpenAI streams tool calls by array index, with the name in the first delta.
    const building = new Map<
      number,
      { id: string; name: string; args: string; started: boolean; statusSent: boolean }
    >()

    for await (const { data } of sseEvents(response)) {
      let event: Record<string, unknown>
      try {
        event = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }

      const usageBlock = event.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined
      if (usageBlock) {
        usage = {
          inputTokens: usageBlock.prompt_tokens ?? 0,
          outputTokens: usageBlock.completion_tokens ?? 0,
        }
      }

      const choices = event.choices as
        | Array<{
            delta?: { content?: string | null; tool_calls?: OpenAIToolCall[] }
            finish_reason?: string | null
          }>
        | undefined
      const choice = choices?.[0]
      if (!choice) continue

      if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason)

      if (choice.delta?.content) {
        text += choice.delta.content
        yield { type: 'text_delta', text: choice.delta.content }
      }

      for (const delta of choice.delta?.tool_calls ?? []) {
        const index = delta.index ?? 0
        let pending = building.get(index)
        if (!pending) {
          pending = { id: '', name: '', args: '', started: false, statusSent: false }
          building.set(index, pending)
        }
        if (delta.id) pending.id = delta.id
        if (delta.function?.name) pending.name += delta.function.name
        if (delta.function?.arguments) pending.args += delta.function.arguments

        if (!pending.started && pending.name && pending.id) {
          pending.started = true
          yield { type: 'tool_call_start', id: pending.id, name: pending.name }
        }
        if (pending.started && !pending.statusSent) {
          const status = readStreamingStringField(pending.args, 'status')
          if (status) {
            pending.statusSent = true
            yield { type: 'tool_call_status', id: pending.id, name: pending.name, status }
          }
        }
      }
    }

    // OpenAI has no per-call stop event; calls complete when the stream ends.
    const toolCalls: ModelToolCall[] = []
    for (const [index, pending] of [...building.entries()].sort((a, b) => a[0] - b[0])) {
      const call = {
        id: pending.id || `call_${index}`,
        name: pending.name,
        input: parseToolInput(pending.args),
      }
      toolCalls.push(call)
      yield { type: 'tool_call', call }
    }

    return { text, toolCalls, stopReason, ...(usage ? { usage } : {}) }
  }
}

function toOpenAITool(tool: ToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function toOpenAIMessages(messages: ModelMessage[]) {
  const out: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.content === '' ? null : message.content,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      })
      continue
    }
    // One `tool` message per result, unlike Anthropic's single grouped turn.
    for (const result of message.results) {
      out.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content })
    }
  }
  return out
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    return parsed.error?.message ?? ''
  } catch {
    return ''
  }
}
