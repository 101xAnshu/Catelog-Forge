import { AiTranslationResponseSchema, buildTranslationPrompt, maskForTranslation, unmask, type ProductGroup } from "@cf/core";
import { AiServerError, getProvider, type CompletionResult } from "@cf/ai";
import { publishProduct } from "@cf/db";
import type { TranslateJob } from "@cf/queue";
import type { Job, Worker } from "@cf/queue";
import { handleProviderError, noteSuccess, outcomeFor, recordCall, resumeImports } from "../ai-calls";
import { wdb } from "../db";
import { checkFinalize } from "./finalize";

interface Pending {
  productId: string;
  storeId: string;
  field: string;
  locale: "de" | "fr";
  english: string;
  sourceHash: string;
  masked: string;
  tokens: unknown;
}

const MAX_CHARS_PER_CALL = 2500;
const MAX_ITEMS_PER_CALL = 15;

export async function runTranslate(job: Job<TranslateJob>, worker: Worker): Promise<void> {
  try {
    await translateProducts(job, worker);
  } catch (err) {
    const rateLimited = (err as Error).message === "bullmq:rateLimitExceeded" || (err as Error).name === "RateLimitError";
    if (rateLimited || job.attemptsMade + 1 < (job.opts.attempts ?? 1)) throw err;
    // Out of attempts: storefront falls back to English for these fields; the import can still complete.
    const { sql, db } = wdb();
    await sql`update translations set state = 'missing', error = ${`Translation failed: ${(err as Error).message}`.slice(0, 500)}, updated_at = now()
      where product_id in ${sql(job.data.productIds)} and state = 'pending'`;
    for (const id of job.data.productIds) await publishProduct(db, id);
    if (job.data.importId) await checkFinalize(job.data.importId);
  }
}

async function translateProducts(job: Job<TranslateJob>, worker: Worker): Promise<void> {
  const { sql, db } = wdb();
  const { storeId, productIds } = job.data;
  const [store] = await sql<Array<{ settings: { brandGlossary?: string[] } }>>`select settings from stores where id = ${storeId}`;

  // Only fields whose English changed since they were translated, AI-origin only (manual fixes are never overwritten).
  const rows = await sql<Array<{ product_id: string; field_path: string; locale: "de" | "fr"; value: string; source_hash: string; group: ProductGroup | null }>>`
    select t.product_id, t.field_path, t.locale, f.value, f.source_hash, p."group"
    from translations t
    join product_fields f on f.product_id = t.product_id and f.field_path = t.field_path
    join products p on p.id = t.product_id
    where t.product_id in ${sql(productIds)} and t.store_id = ${storeId}
      and t.origin = 'ai' and t.state in ('pending', 'missing')
      and t.source_hash is distinct from f.source_hash`;
  // Rows that are pending but already match the English (e.g. replayed job) are simply fresh again.
  await sql`update translations t set state = 'fresh' from product_fields f
    where f.product_id = t.product_id and f.field_path = t.field_path and t.product_id in ${sql(productIds)}
      and t.origin = 'ai' and t.state = 'pending' and t.source_hash = f.source_hash`;
  // The English field disappeared (e.g. attribute dropped on rebuild): nothing left to translate.
  await sql`delete from translations t where t.product_id in ${sql(productIds)} and t.origin = 'ai'
    and not exists (select 1 from product_fields f where f.product_id = t.product_id and f.field_path = t.field_path)`;

  const brandsFor = new Map<string, string[]>();
  const pending: Pending[] = rows.map((r) => {
    let brands = brandsFor.get(r.product_id);
    if (!brands) {
      brands = Array.from(new Set([
        ...(r.group?.rows.map((x) => x.brand).filter((b): b is string => !!b) ?? []),
        ...(store?.settings.brandGlossary ?? []),
      ]));
      brandsFor.set(r.product_id, brands);
    }
    const { masked, tokens } = maskForTranslation(r.value, { brands });
    return { productId: r.product_id, storeId, field: r.field_path, locale: r.locale, english: r.value, sourceHash: r.source_hash, masked, tokens };
  });

  for (const locale of ["de", "fr"] as const) {
    const items = pending.filter((p) => p.locale === locale);
    for (const batch of chunkByChars(items)) {
      const failed = await translateBatch(batch, locale, job, worker);
      if (failed.length) {
        // A13: one more try for items whose tokens did not survive, then fall back to English.
        const stillFailed = await translateBatch(failed, locale, job, worker);
        for (const f of stillFailed) {
          await sql`update translations set state = 'missing', error = 'Placeholders, HTML or brand names were not preserved',
            updated_at = now() where product_id = ${f.productId} and field_path = ${f.field} and locale = ${locale} and origin = 'ai'`;
        }
      }
    }
  }
  await resumeImports(storeId);
  for (const id of productIds) await publishProduct(db, id);
  if (job.data.importId) await checkFinalize(job.data.importId);
}

function chunkByChars(items: Pending[]): Pending[][] {
  const out: Pending[][] = [];
  let cur: Pending[] = [];
  let size = 0;
  for (const it of items) {
    if (cur.length && (size + it.masked.length > MAX_CHARS_PER_CALL || cur.length >= MAX_ITEMS_PER_CALL)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += it.masked.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Returns the items that came back broken (missing key or altered tokens). */
async function translateBatch(batch: Pending[], locale: "de" | "fr", job: Job<TranslateJob>, worker: Worker): Promise<Pending[]> {
  const { sql } = wdb();
  const key = (p: Pending) => `${p.productId}|${p.field}`;
  const { system, user } = buildTranslationPrompt(batch.map((p) => ({ key: key(p), text: p.masked })), locale);
  const log = {
    storeId: job.data.storeId, importId: job.data.importId, productIds: Array.from(new Set(batch.map((p) => p.productId))),
    kind: "translate" as const, tier: "cheap" as const, model: getProvider().modelFor("cheap"), attempt: job.attemptsMade + 1,
  };
  let result: CompletionResult;
  try {
    result = await getProvider().complete({ tier: "cheap", system, user, json: true, temperature: 0 });
  } catch (err) {
    await recordCall(log, null, outcomeFor(err), (err as { code?: string }).code);
    await handleProviderError(err, worker, job.data.storeId);
    // Groq rejects answers that fail its own JSON validation (usually a too-long batch): split and retry the halves.
    if (err instanceof AiServerError && err.status === 400 && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      return [
        ...(await translateBatch(batch.slice(0, mid), locale, job, worker)),
        ...(await translateBatch(batch.slice(mid), locale, job, worker)),
      ];
    }
    if (err instanceof AiServerError && err.status === 400) return batch;
    throw err;
  }
  let parsed: ReturnType<typeof AiTranslationResponseSchema.safeParse> | null = null;
  try {
    parsed = AiTranslationResponseSchema.safeParse(JSON.parse(result.text));
  } catch {
    parsed = null;
  }
  await recordCall(log, result, parsed?.success ? "ok" : "invalid_json");
  if (!parsed?.success) return batch;
  noteSuccess();
  const byKey = new Map(parsed.data.items.map((i) => [i.key, i.text]));
  const failed: Pending[] = [];
  for (const p of batch) {
    const text = byKey.get(key(p));
    const restored = text === undefined ? null : unmask(text, p.tokens as never);
    if (!restored?.ok) {
      failed.push(p);
      continue;
    }
    await sql`update translations set value = ${restored.text}, source_hash = ${p.sourceHash}, state = 'fresh', error = null, updated_at = now()
      where product_id = ${p.productId} and field_path = ${p.field} and locale = ${locale} and origin = 'ai'`;
  }
  return failed;
}
