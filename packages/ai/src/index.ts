import { FakeProvider } from "./fake";
import { GroqProvider } from "./groq";
import type { AiProvider } from "./types";

export * from "./types";
export * from "./cost";
export { FakeProvider, parseFailureSpec, extractJson } from "./fake";
export { GroqProvider, parseDuration } from "./groq";

let cached: AiProvider | undefined;

/** Groq when a key is configured, otherwise the deterministic fake (demo mode). */
export function getProvider(): AiProvider {
  if (cached) return cached;
  const key = process.env.GROQ_API_KEY;
  cached = key && process.env.AI_PROVIDER !== "fake" ? new GroqProvider(key) : new FakeProvider();
  return cached;
}

export function isDemoMode(): boolean {
  return !process.env.GROQ_API_KEY || process.env.AI_PROVIDER === "fake";
}

/** Tests swap providers between runs. */
export function resetProvider(provider?: AiProvider): void {
  cached = provider;
}
