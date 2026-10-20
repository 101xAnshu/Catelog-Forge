export type Tier = "cheap" | "strong" | "vision";

export interface CompletionRequest {
  tier: Tier;
  system: string;
  user: string;
  /** data URLs (image/webp;base64,...) — only sent to the vision tier */
  images?: string[];
  maxTokens?: number;
  temperature?: number;
  json: true;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
}

export interface AiProvider {
  readonly name: "opencode" | "groq" | "fake";
  modelFor(tier: Tier): string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class AiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 429 from the provider; the queue pauses instead of burning an attempt. */
export class RateLimitError extends AiError {
  constructor(readonly retryAfterMs: number, message = "Rate limited by AI provider") {
    super(message, "rate_limited");
  }
}

export class AiTimeoutError extends AiError {
  constructor(message = "AI request timed out") {
    super(message, "timeout");
  }
}

export class AiAuthError extends AiError {
  constructor(message = "AI key rejected") {
    super(message, "auth");
  }
}

export class AiServerError extends AiError {
  constructor(message: string, readonly status?: number) {
    super(message, "server_error");
  }
}

/** Output that could not be parsed or validated (after the repair attempt). */
export class AiInvalidOutputError extends AiError {
  constructor(message: string) {
    super(message, "invalid_json");
  }
}
