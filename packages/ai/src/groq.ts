import OpenAI, { APIConnectionTimeoutError, APIError } from "openai";
import { GROQ_MODELS } from "./cost";
import {
  AiAuthError, AiServerError, AiTimeoutError, RateLimitError,
  type AiProvider, type CompletionRequest, type CompletionResult, type Tier,
} from "./types";

const TIMEOUT_MS = 60_000;

/** Parses Groq durations like "2m52.8s", "690ms", "7.66s". */
export function parseDuration(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(Number(s) * 1000);
  let ms = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    ms += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return matched ? Math.ceil(ms) : null;
}

export class GroqProvider implements AiProvider {
  readonly name = "groq" as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
      timeout: TIMEOUT_MS,
      maxRetries: 0, // retries are owned by the queue so they survive restarts
    });
  }

  modelFor(tier: Tier): string {
    return GROQ_MODELS[tier];
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = this.modelFor(req.tier);
    const started = Date.now();
    const userContent: OpenAI.Chat.ChatCompletionContentPart[] | string =
      req.tier === "vision" && req.images?.length
        ? [{ type: "text", text: req.user }, ...req.images.slice(0, 4).map((url) => ({ type: "image_url" as const, image_url: { url } }))]
        : req.user;
    const maxTokens = req.tier === "vision" ? Math.min(req.maxTokens ?? 900, 900) : req.maxTokens ?? 4096;
    try {
      const res = await this.client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: req.temperature ?? 0.2,
        max_tokens: maxTokens,
        // gpt-oss spends output tokens on reasoning; "low" keeps JSON from being truncated and cuts cost.
        ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
      const choice = res.choices[0];
      const usage = res.usage as (OpenAI.CompletionUsage & { prompt_tokens_details?: { cached_tokens?: number } }) | undefined;
      return {
        text: choice?.message.content ?? "",
        model,
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      throw mapError(err);
    }
  }
}

function mapError(err: unknown): Error {
  if (err instanceof APIConnectionTimeoutError) return new AiTimeoutError();
  if (err instanceof APIError) {
    const headers = err.headers ?? {};
    if (err.status === 429) {
      const retry =
        parseDuration(headers["retry-after"]) ??
        parseDuration(headers["x-ratelimit-reset-tokens"]) ??
        parseDuration(headers["x-ratelimit-reset-requests"]) ??
        30_000;
      return new RateLimitError(Math.max(retry, 1000), `Rate limited by AI provider (${err.message.slice(0, 160)})`);
    }
    if (err.status === 401 || err.status === 403) return new AiAuthError(`AI key rejected (${err.status})`);
    if (err.status === 400 && /json_validate_failed|Failed to generate JSON/i.test(err.message)) {
      return new AiServerError(`Model failed to produce JSON: ${err.message.slice(0, 200)}`, 400);
    }
    return new AiServerError(`AI provider error ${err.status ?? ""}: ${err.message.slice(0, 200)}`, err.status);
  }
  if (err instanceof Error && /timed? ?out|ETIMEDOUT|aborted/i.test(err.message)) return new AiTimeoutError();
  return new AiServerError(err instanceof Error ? err.message : String(err));
}
