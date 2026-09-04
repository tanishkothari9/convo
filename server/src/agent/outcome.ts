import type { UiComponent } from '../domain/types.js'

/**
 * The result of one tool call.
 *
 * A held call returns a normal result with `heldBy` naming the gate that held
 * it, so the model learns what to do instead rather than seeing a failure. A
 * genuine failure returns `isError`. A tool exception never ends the turn.
 * Adapted from `ToolOutcome` in anthropics/commerce-agents (Apache-2.0).
 */
export interface ToolOutcome {
  /** What the model reads back. */
  text: string
  isError: boolean
  /** The gate's name when the call was held. */
  heldBy?: string
  /** Components for the chat page to render, and side-channel state updates. */
  components: UiComponent[]
}

export const ok = (text: string, components: UiComponent[] = []): ToolOutcome => ({
  text,
  isError: false,
  components,
})

export const failed = (text: string): ToolOutcome => ({ text, isError: true, components: [] })

export const held = (gate: string, text: string): ToolOutcome => ({
  text: `[held: ${gate}] ${text}`,
  isError: false,
  heldBy: gate,
  components: [],
})
