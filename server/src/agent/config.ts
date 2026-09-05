/**
 * Deployment limits. These are the caps the gates enforce; they are values,
 * not suggestions, and the model cannot argue past any of them.
 */
export interface AgentConfig {
  maxSearchResults: number;
  maxCartLines: number;
  maxQuantityPerItem: number;
  /** Rounds of tool calls before the loop forces a round without tools. */
  maxToolIterations: number;
  maxFencedChars: number;
  /** Messages kept in the model's context; older ones are dropped oldest-first. */
  maxHistoryMessages: number;
  /** Hard ceiling on any single order, as a backstop on the money path. */
  maxOrderTotalMinor: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSearchResults: 8,
  maxCartLines: 20,
  maxQuantityPerItem: 10,
  maxToolIterations: 6,
  maxFencedChars: 12_000,
  maxHistoryMessages: 40,
  maxOrderTotalMinor: 50_000_000, // ₹5,00,000
};
