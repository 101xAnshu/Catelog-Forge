import { hostname } from "node:os";
import OpenAI, { APIConnectionTimeoutError, APIError } from "openai";
import { parseDuration } from "./groq";
import {
  AiAuthError, AiServerError, AiTimeoutError, RateLimitError,
  type AiProvider, type CompletionRequest, type CompletionResult, type Tier,
} from "./types";

const TIMEOUT_MS = 120_000;
const BASE_URL = "https://opencode.ai/inference/go/openai/v1";

/**
 * OpenCode Go limits are per model, so each tier is a chain: the first model with quota left serves the call.
 * Primary picks have the largest Go allowances (~30k requests per 5h); the free models are the documented
 * fallback once a paid model's limit is reached. Override any chain with OPENCODE_MODELS_<TIER>=a,b,c.
 */
export const OPENCODE_CHAINS: Record<Tier, string[]> = {
  cheap: ["mimo-v2.6-flash", "mimo-v2.5", "minimax-m3.1-flash-free", "longcat-2.5-preview-free"],
  strong: ["mimo-v2.5", "mimo-v2.6-flash", "minimax-m3.1-flash-free", "longcat-2.5-preview-free"],
  vision: ["qwen3.8-flash", "minimax-m3.1-flash-free", "mimo-v2.6-flash"],
};

function chainFor(tier: Tier): string[] {
  const override = process.env[`OPENCODE_MODELS_${tier.toUpperCase()}`];
  const list = override ? override.split(",").map((s) => s.trim()).filter(Boolean) : OPENCODE_CHAINS[tier];
  return list.length ? list : OPENCODE_CHAINS[tier];
}

/** A model is skipped until this time after a quota/rate limit or a model-unavailable error. */
const cooldownUntil = new Map<string, number>();

export class OpenCodeProvider implements AiProvider {
  readonly name = "opencode" as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: BASE_URL,
      timeout: TIMEOUT_MS,
      maxRetries: 0, // retries are owned by the queue so they survive restarts
      // Go requires a stable session id per client for routing.
      defaultHeaders: { "x-opencode-session": `catalogforge-${hostname()}`, "User-Agent": "catalogforge/1.0" },
    });
  }

  modelFor(tier: Tier): string {
    const now = Date.now();
    return chainFor(tier).find((m) => (cooldownUntil.get(m) ?? 0) <= now) ?? chainFor(tier)[0]!;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const chain = chainFor(req.tier);
    let soonest = Infinity;
    let lastError: Error | null = null;
    for (const model of chain) {
      if ((cooldownUntil.get(model) ?? 0) > Date.now()) {
        soonest = Math.min(soonest, cooldownUntil.get(model)! - Date.now());
        continue;
      }
      try {
        return await this.call(model, req);
      } catch (err) {
        const mapped = mapError(err);
        if (mapped instanceof RateLimitError) {
          // Quota or rate limit on this model: cool it down and let the next model in the chain take the call.
          cooldownUntil.set(model, Date.now() + mapped.retryAfterMs);
          soonest = Math.min(soonest, mapped.retryAfterMs);
          lastError = mapped;
          continue;
        }
        if (mapped instanceof ModelUnavailableError) {
          cooldownUntil.set(model, Date.now() + 60 * 60_000);
          lastError = mapped;
          continue;
        }
        throw mapped;
      }
    }
    // Every model in the chain is limited at once: only now does the queue pause.
    if (lastError instanceof ModelUnavailableError && soonest === Infinity) throw new AiServerError(lastError.message, 400);
    throw new RateLimitError(Number.isFinite(soonest) ? Math.max(soonest, 1000) : 60_000, "All OpenCode Go models for this step are at their limit");
  }

  private async call(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const withImages = req.tier === "vision" && req.images?.length;
    const userContent: OpenAI.Chat.ChatCompletionContentPart[] | string = withImages
      ? [{ type: "text", text: req.user }, ...req.images!.slice(0, 4).map((url) => ({ type: "image_url" as const, image_url: { url } }))]
      : req.user;
    const res = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: req.temperature ?? 0.2,
      // These models reason before answering; leave room so the JSON is never cut off.
      max_tokens: Math.max(req.maxTokens ?? 0, 16_000),
    });
    const usage = res.usage as (OpenAI.CompletionUsage & { prompt_tokens_details?: { cached_tokens?: number } }) | undefined;
    return {
      text: res.choices[0]?.message.content ?? "",
      model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}

/** The workspace cannot use this model (e.g. region setting); skip it rather than retrying. */
class ModelUnavailableError extends Error {}

function mapError(err: unknown): Error {
  if (err instanceof APIConnectionTimeoutError) return new AiTimeoutError();
  if (err instanceof APIError) {
    const headers = err.headers ?? {};
    const msg = err.message ?? "";
    if (err.status === 429 || /usage limit|quota|rate limit/i.test(msg)) {
      const retry = parseDuration(headers["retry-after"]) ?? parseDuration(headers["x-ratelimit-reset-requests"]) ?? 5 * 60_000;
      return new RateLimitError(Math.max(retry, 1000), `Rate limited by AI provider (${msg.slice(0, 160)})`);
    }
    if (err.status === 401 || err.status === 403) return new AiAuthError(`AI key rejected (${err.status})`);
    if (/requires Global regions|model not found|not available|unsupported model/i.test(msg)) {
      return new ModelUnavailableError(`OpenCode Go model unavailable: ${msg.slice(0, 200)}`);
    }
    return new AiServerError(`AI provider error ${err.status ?? ""}: ${msg.slice(0, 200)}`, err.status);
  }
  if (err instanceof Error && /timed? ?out|ETIMEDOUT|aborted/i.test(err.message)) return new AiTimeoutError();
  return new AiServerError(err instanceof Error ? err.message : String(err));
}
