import type { Tier } from "./types";

/** USD per 1M tokens (Groq on-demand list prices). */
export const COST_TABLE: Record<string, { input: number; output: number }> = {
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "qwen/qwen3.8-27b": { input: 0.29, output: 0.59 },
  // OpenCode Go bills against a monthly allowance and does not publish per-token prices for these models;
  // these are estimates so cost per product stays comparable. Free models cost nothing.
  "mimo-v2.6-flash": { input: 0.1, output: 0.4 },
  "mimo-v2.5": { input: 0.2, output: 0.8 },
  "qwen3.8-flash": { input: 0.1, output: 0.4 },
  "deepseek-v4.1-flash": { input: 0.1, output: 0.4 },
  "minimax-m3.1-flash-free": { input: 0, output: 0 },
  "longcat-2.5-preview-free": { input: 0, output: 0 },
};

export const GROQ_MODELS: Record<Tier, string> = {
  cheap: "openai/gpt-oss-20b",
  strong: "openai/gpt-oss-120b",
  vision: "qwen/qwen3.8-27b",
};

/** The model every call is compared against for "money saved": strong model, synchronous. */
export const BASELINE_MODEL = GROQ_MODELS.strong;

function priceFor(model: string): { input: number; output: number } {
  // Fake models are priced as their Groq counterpart so demo-mode numbers stay meaningful.
  const real = model.startsWith("fake/") ? model.slice(5) : model;
  return COST_TABLE[real] ?? COST_TABLE[BASELINE_MODEL]!;
}

/** Cost in micro-dollars (integer) — never floats in storage. */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return Math.round(inputTokens * p.input + outputTokens * p.output);
}

export function baselineCostMicros(inputTokens: number, outputTokens: number): number {
  return costMicros(BASELINE_MODEL, inputTokens, outputTokens);
}
