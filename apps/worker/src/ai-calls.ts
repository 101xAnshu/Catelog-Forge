import {
  AiAuthError, AiServerError, AiTimeoutError, RateLimitError, baselineCostMicros, costMicros,
  type CompletionResult, type Tier,
} from "@cf/ai";
import { publishProgress, Worker } from "@cf/queue";
import { wdb } from "./db";

type Outcome = "ok" | "invalid_json" | "rate_limited" | "timeout" | "error";

export interface CallLog {
  storeId: string;
  importId: string | null;
  productIds: string[];
  kind: "build" | "translate" | "rerun" | "repair";
  tier: Tier;
  model: string;
  attempt: number;
  promptVersion?: string;
}

/** Every AI call, including failures, is recorded with tokens + cost + the strong-model baseline. */
export async function recordCall(log: CallLog, result: CompletionResult | null, outcome: Outcome, errorCode?: string): Promise<void> {
  const { sql } = wdb();
  const inT = result?.inputTokens ?? 0;
  const outT = result?.outputTokens ?? 0;
  const model = result?.model ?? log.model;
  await sql`
    insert into ai_calls (store_id, import_id, product_ids, kind, model, tier, batch, input_tokens, output_tokens, cached_tokens,
      cost_micros, baseline_cost_micros, latency_ms, attempt, outcome, error_code, prompt_version)
    values (${log.storeId}, ${log.importId}, ${JSON.stringify(log.productIds)}::jsonb, ${log.kind}, ${model}, ${log.tier}, false,
      ${inT}, ${outT}, ${result?.cachedTokens ?? 0}, ${costMicros(model, inT, outT)}, ${baselineCostMicros(inT, outT)},
      ${result?.latencyMs ?? 0}, ${log.attempt}, ${outcome}, ${errorCode ?? null}, ${log.promptVersion ?? null})`;
}

export function outcomeFor(err: unknown): Outcome {
  if (err instanceof RateLimitError) return "rate_limited";
  if (err instanceof AiTimeoutError) return "timeout";
  return "error";
}

let consecutiveServerErrors = 0;
export const CIRCUIT_THRESHOLD = 5;

export function noteSuccess(): void {
  consecutiveServerErrors = 0;
}

/** Marks in-flight imports of the store as paused so the UI can show "Paused — resuming in X min". */
async function pauseImports(storeId: string, untilMs: number, reason: string): Promise<void> {
  const { sql } = wdb();
  // ISO string + cast: postgres.js under Bun cannot serialize Date parameters.
  const until = new Date(Date.now() + untilMs).toISOString();
  const rows = await sql<Array<{ id: string }>>`
    update imports set status = 'paused', paused_until = greatest(coalesce(paused_until, ${until}::timestamptz), ${until}::timestamptz),
      paused_reason = ${reason}, updated_at = now()
    where store_id = ${storeId} and status in ('building', 'translating', 'paused') returning id`;
  for (const r of rows) await publishProgress(storeId, { type: "import", importId: r.id, status: "paused" });
}

/** Clears the paused flag once the pause window is over (jobs already in flight don't end it early). */
export async function resumeImports(storeId: string): Promise<void> {
  const { sql } = wdb();
  const rows = await sql<Array<{ id: string; status: string }>>`
    update imports set status = case when stage = 'translate' then 'translating' else 'building' end,
      paused_until = null, paused_reason = null, updated_at = now()
    where store_id = ${storeId} and status = 'paused' and (paused_until is null or paused_until <= now())
    returning id, status`;
  for (const r of rows) await publishProgress(storeId, { type: "import", importId: r.id, status: r.status });
}

/**
 * Converts provider-wide failures into a queue-wide pause instead of burning job attempts:
 * 429 → pause for retry-after; bad key → pause 5 min; 5 server errors in a row → open circuit for 60 s.
 * Returns normally when the error is an ordinary per-job failure that should be retried with backoff.
 */
export async function handleProviderError(err: unknown, worker: Worker, storeId: string): Promise<void> {
  if (err instanceof RateLimitError) {
    await pauseImports(storeId, err.retryAfterMs, "Rate limited by AI provider");
    await worker.rateLimit(err.retryAfterMs);
    throw Worker.RateLimitError();
  }
  if (err instanceof AiAuthError) {
    await pauseImports(storeId, 5 * 60_000, "AI key rejected — check OPENCODE_API_KEY / GROQ_API_KEY");
    await worker.rateLimit(5 * 60_000);
    throw Worker.RateLimitError();
  }
  if (err instanceof AiServerError || err instanceof AiTimeoutError) {
    consecutiveServerErrors++;
    if (consecutiveServerErrors >= CIRCUIT_THRESHOLD) {
      consecutiveServerErrors = 0;
      await pauseImports(storeId, 60_000, "AI provider unavailable — retrying in 1 minute");
      await worker.rateLimit(60_000);
      throw Worker.RateLimitError();
    }
  }
}
