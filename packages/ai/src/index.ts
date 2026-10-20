import { FakeProvider } from "./fake";
import { GroqProvider } from "./groq";
import { OpenCodeProvider } from "./opencode";
import type { AiProvider } from "./types";

export * from "./types";
export * from "./cost";
export { FakeProvider, parseFailureSpec, extractJson } from "./fake";
export { GroqProvider, parseDuration } from "./groq";
export { OpenCodeProvider, OPENCODE_CHAINS } from "./opencode";

let cached: AiProvider | undefined;

export type ProviderName = "opencode" | "groq" | "fake";

/**
 * AI_PROVIDER picks explicitly; otherwise OpenCode Go when its key is set, then Groq, then the
 * deterministic fake (demo mode).
 */
export function providerName(): ProviderName {
  const forced = process.env.AI_PROVIDER;
  if (forced === "fake") return "fake";
  if (forced === "groq" && process.env.GROQ_API_KEY) return "groq";
  if (forced === "opencode" && process.env.OPENCODE_API_KEY) return "opencode";
  if (process.env.OPENCODE_API_KEY) return "opencode";
  if (process.env.GROQ_API_KEY) return "groq";
  return "fake";
}

export function getProvider(): AiProvider {
  if (cached) return cached;
  const name = providerName();
  cached =
    name === "opencode"
      ? new OpenCodeProvider(process.env.OPENCODE_API_KEY!)
      : name === "groq"
        ? new GroqProvider(process.env.GROQ_API_KEY!)
        : new FakeProvider();
  return cached;
}

export function isDemoMode(): boolean {
  return providerName() === "fake";
}

/** Tests swap providers between runs. */
export function resetProvider(provider?: AiProvider): void {
  cached = provider;
}
