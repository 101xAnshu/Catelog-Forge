import type { Tier } from "./types";

/** USD per 1M tokens (Groq on-demand list prices). */
export const COST_TABLE: Record<string, { input: number; output: number }> = {
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "qwen/qwen3.8-27b": { input: 0.29, output: 0.59 },
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
