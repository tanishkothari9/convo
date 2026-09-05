/**
 * The model abstraction.
 *
 * Convo's agent — its skills, gates, tool contracts, presentation enrichment,
 * and audit logging — sits entirely above this interface. Nothing below
 * `agent/` imports a vendor SDK, and switching `LLM_PROVIDER` changes which
 * backend answers without touching a line of agent logic.
 */

/** A JSON Schema object describing one tool's arguments. */
export type JsonSchema = Record<string, unknown>;

/** Convo's internal tool contract. Each backend translates this into its own format. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ModelToolCall[] }
  | { role: "tool"; results: ModelToolResult[] };

export type StopReason =
  "end_turn" | "tool_use" | "max_tokens" | "refusal" | "error";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentResponse {
  /** Text the model produced this round, if any. */
  text: string;
  /** Typed tool calls it requested, in the order it made them. */
  toolCalls: ModelToolCall[];
  stopReason: StopReason;
  usage?: TokenUsage;
}

export interface AgentTurnRequest {
  systemPrompt: string;
  /**
   * The portion of the system prompt that is stable across turns. Backends
   * that support prompt caching mark a breakpoint after it.
   */
  cacheableSystemPrefixLength?: number;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** Forces one of these tools this round; used by the grounding rules. */
  forceTool?: string;
  signal?: AbortSignal;
}

/** What a backend emits while a turn is in flight. */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  /** The `status` line a tool call carries, surfaced as soon as it streams in. */
  | { type: "tool_call_status"; id: string; name: string; status: string }
  | { type: "tool_call"; call: ModelToolCall };

export interface ModelProvider {
  /** Matches the LLM_PROVIDER config value. */
  readonly name: string;
  readonly model: string;
  /** False when the backend has no credentials configured. */
  readonly available: boolean;

  /** One round: the model reads the conversation and answers with text, tool calls, or both. */
  runAgentTurn(request: AgentTurnRequest): Promise<AgentResponse>;

  /** The same round, streamed. The generator's return value is the completed response. */
  streamAgentTurn(
    request: AgentTurnRequest,
  ): AsyncGenerator<ModelStreamEvent, AgentResponse, void>;
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
