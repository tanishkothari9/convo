/**
 * The Claude backend, on the Anthropic Messages API.
 *
 * Translates Convo's internal tool contracts into Anthropic's `tools` /
 * `tool_use` / `tool_result` shape and back. Nothing Convo-specific lives
 * here: the agent's skills, gates, and presentation logic never see this file.
 */
import { env } from "../env.js";
import { ModelProviderError } from "./types.js";
import type {
  AgentResponse,
  AgentTurnRequest,
  ModelMessage,
  ModelProvider,
  ModelStreamEvent,
  ModelToolCall,
  StopReason,
  ToolDefinition,
} from "./types.js";
import {
  parseToolInput,
  readStreamingStringField,
  sseEvents,
} from "./stream.js";

const API_VERSION = "2023-06-01";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";

  constructor(
    readonly model: string = env.anthropicModel,
    private readonly apiKey: string | undefined = env.anthropicApiKey,
    private readonly baseUrl: string = env.anthropicBaseUrl,
  ) {}

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  private body(request: AgentTurnRequest, stream: boolean) {
    return {
      model: this.model,
      max_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 1,
      system: this.system(request),
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.map(toAnthropicTool),
      ...(request.forceTool
        ? { tool_choice: { type: "tool", name: request.forceTool } }
        : { tool_choice: { type: "auto" } }),
      ...(stream ? { stream: true } : {}),
    };
  }

  /**
   * The system prompt as two blocks with a cache breakpoint between them, so
   * the static half (identity, rules, skill index) is cached across turns and
   * the per-request half is not.
   */
  private system(request: AgentTurnRequest) {
    const split = request.cacheableSystemPrefixLength;
    if (!split || split <= 0 || split >= request.systemPrompt.length) {
      return [{ type: "text", text: request.systemPrompt }];
    }
    return [
      {
        type: "text",
        text: request.systemPrompt.slice(0, split),
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: request.systemPrompt.slice(split) },
    ];
  }

  private async send(
    request: AgentTurnRequest,
    stream: boolean,
  ): Promise<Response> {
    if (!this.apiKey) {
      throw new ModelProviderError("ANTHROPIC_API_KEY is not set.");
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(this.body(request, stream)),
        signal: request.signal ?? AbortSignal.timeout(120_000),
      });
    } catch (cause) {
      throw new ModelProviderError(
        `Could not reach the Anthropic API (${cause instanceof Error ? cause.message : "network error"}).`,
        true,
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ModelProviderError(
        `Anthropic API returned ${response.status}. ${extractMessage(detail)}`.trim(),
        response.status === 429 || response.status >= 500,
      );
    }
    return response;
  }

  async runAgentTurn(request: AgentTurnRequest): Promise<AgentResponse> {
    const response = await this.send(request, false);
    const payload = (await response.json()) as {
      content: AnthropicContentBlock[];
      stop_reason: string | null;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text = payload.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const toolCalls: ModelToolCall[] = payload.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: String(block.id),
        name: String(block.name),
        input: block.input ?? {},
      }));
    return {
      text,
      toolCalls,
      stopReason: mapStopReason(payload.stop_reason),
      ...(payload.usage
        ? {
            usage: {
              inputTokens: payload.usage.input_tokens,
              outputTokens: payload.usage.output_tokens,
            },
          }
        : {}),
    };
  }

  async *streamAgentTurn(
    request: AgentTurnRequest,
  ): AsyncGenerator<ModelStreamEvent, AgentResponse, void> {
    const response = await this.send(request, true);

    let text = "";
    let stopReason: StopReason = "end_turn";
    let usage: AgentResponse["usage"];
    const toolCalls: ModelToolCall[] = [];
    // Blocks arrive interleaved by index; each tool call's JSON streams in parts.
    const open = new Map<
      number,
      { id: string; name: string; json: string; statusSent: boolean }
    >();

    for await (const { data } of sseEvents(response)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (event.type) {
        case "content_block_start": {
          const index = Number(event.index);
          const block = event.content_block as
            AnthropicContentBlock | undefined;
          if (block?.type === "tool_use") {
            open.set(index, {
              id: String(block.id),
              name: String(block.name),
              json: "",
              statusSent: false,
            });
            yield {
              type: "tool_call_start",
              id: String(block.id),
              name: String(block.name),
            };
          }
          break;
        }
        case "content_block_delta": {
          const index = Number(event.index);
          const delta = event.delta as {
            type?: string;
            text?: string;
            partial_json?: string;
          };
          if (delta?.type === "text_delta" && delta.text) {
            text += delta.text;
            yield { type: "text_delta", text: delta.text };
          } else if (delta?.type === "input_json_delta") {
            const pending = open.get(index);
            if (pending) {
              pending.json += delta.partial_json ?? "";
              if (!pending.statusSent) {
                const status = readStreamingStringField(pending.json, "status");
                if (status) {
                  pending.statusSent = true;
                  yield {
                    type: "tool_call_status",
                    id: pending.id,
                    name: pending.name,
                    status,
                  };
                }
              }
            }
          }
          break;
        }
        case "content_block_stop": {
          const index = Number(event.index);
          const pending = open.get(index);
          if (pending) {
            open.delete(index);
            const call = {
              id: pending.id,
              name: pending.name,
              input: parseToolInput(pending.json),
            };
            toolCalls.push(call);
            yield { type: "tool_call", call };
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as
            { stop_reason?: string | null } | undefined;
          if (delta?.stop_reason) stopReason = mapStopReason(delta.stop_reason);
          const u = event.usage as
            { input_tokens?: number; output_tokens?: number } | undefined;
          if (u) {
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
            };
          }
          break;
        }
        case "error": {
          const err = event.error as { message?: string } | undefined;
          throw new ModelProviderError(
            err?.message ?? "The Anthropic API reported an error.",
            true,
          );
        }
        default:
          break;
      }
    }

    return { text, toolCalls, stopReason, ...(usage ? { usage } : {}) };
  }
}

function toAnthropicTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function toAnthropicMessages(messages: ModelMessage[]) {
  const out: Array<{
    role: "user" | "assistant";
    content: AnthropicContentBlock[];
  }> = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: message.content }],
      });
      continue;
    }
    if (message.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      if (message.content.trim() !== "")
        content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      // An assistant turn must not be empty.
      if (content.length === 0)
        content.push({ type: "text", text: "(no reply)" });
      out.push({ role: "assistant", content });
      continue;
    }
    // Tool results are a user turn in Anthropic's shape.
    out.push({
      role: "user",
      content: message.results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.toolCallId,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    });
  }
  return out;
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? "";
  } catch {
    return "";
  }
}
