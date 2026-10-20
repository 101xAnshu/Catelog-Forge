import {
  AiBatchResponseSchema, applyGuards, buildProductPrompt, DEFAULT_PROMPT_VERSION, routeModel, sha256Hex,
  type AiProduct, type ProductGroup, type ProductOutput,
} from "@cf/core";
import { AiInvalidOutputError, getProvider, type CompletionResult, type Tier } from "@cf/ai";
import { publishProduct } from "@cf/db";
import { enqueueBuild, enqueueTranslate, type BuildJob } from "@cf/queue";
import type { Job, Worker } from "@cf/queue";
import { handleProviderError, noteSuccess, outcomeFor, recordCall, resumeImports, type CallLog } from "../ai-calls";
import { wdb } from "../db";
import { refreshCounts } from "../progress";
import { readObject } from "../storage";
import { checkFinalize } from "./finalize";

interface ProductRow {
  id: string;
  store_id: string;
  handle: string;
  status: string;
  group: ProductGroup;
  source_input_hash: string | null;
  built_input_hash: string | null;
  deleted_at: Date | null;
}

/** English fields written per product; `attributes.*` are added dynamically. */
function fieldsFromOutput(output: ProductOutput): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ["title", output.title],
    ["description_html", output.description_html],
    ["seo_title", output.seo?.title ?? ""],
    ["seo_description", output.seo?.description ?? ""],
  ];
  for (const [k, v] of Object.entries(output.attributes ?? {})) fields.push([`attributes.${k}`, v]);
  return fields.filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "");
}

async function thumbsFor(productId: string, limit: number): Promise<string[]> {
  const { sql } = wdb();
  const rows = await sql<Array<{ thumb_key: string }>>`
    select thumb_key from assets where product_id = ${productId} and status = 'ok' and thumb_key is not null order by filename limit ${limit}`;
  const out: string[] = [];
  for (const r of rows) {
    const buf = await readObject(r.thumb_key).catch(() => null);
    if (buf) out.push(`data:image/webp;base64,${buf.toString("base64")}`);
  }
  return out;
}

async function callModel(
  log: CallLog,
  worker: Worker,
  req: { tier: Tier; system: string; user: string; images?: string[]; temperature?: number },
): Promise<Map<string, AiProduct>> {
  const provider = getProvider();
  let result: CompletionResult;
  try {
    result = await provider.complete({ ...req, json: true });
  } catch (err) {
    await recordCall(log, null, outcomeFor(err), (err as { code?: string }).code);
    await handleProviderError(err, worker, log.storeId);
    throw err;
  }
  const parsed = parse(result.text);
  if (parsed.ok) {
    await recordCall(log, result, "ok");
    noteSuccess();
    return parsed.products;
  }
  // One repair re-ask with the validation error before this counts as a failed attempt.
  await recordCall(log, result, "invalid_json", "invalid_json");
  let repaired: CompletionResult;
  try {
    repaired = await provider.complete({
      ...req,
      user: `${req.user}\n\nYour previous reply was invalid (${parsed.error}). Reply again with ONLY the JSON object that matches the schema.`,
      json: true,
    });
  } catch (err) {
    await recordCall({ ...log, kind: "repair" }, null, outcomeFor(err), (err as { code?: string }).code);
    await handleProviderError(err, worker, log.storeId);
    throw err;
  }
  const second = parse(repaired.text);
  await recordCall({ ...log, kind: "repair" }, repaired, second.ok ? "ok" : "invalid_json", second.ok ? undefined : "invalid_json");
  if (!second.ok) throw new AiInvalidOutputError(`AI output invalid after repair: ${second.error}`);
  noteSuccess();
  return second.products;
}

function parse(text: string): { ok: true; products: Map<string, AiProduct> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message.slice(0, 120)}` };
  }
  const res = AiBatchResponseSchema.safeParse(json);
  if (!res.success) return { ok: false, error: res.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, products: new Map(res.data.products.map((p) => [p.id, p])) };
}

export async function runBuild(job: Job<BuildJob>, worker: Worker): Promise<void> {
  const { sql } = wdb();
  const { storeId, importId, kind, overrides } = job.data;
  const [store] = await sql<Array<{ settings: { routingThreshold?: number; reviewThreshold?: number; promptVersion?: string } }>>`
    select settings from stores where id = ${storeId}`;
  const [imp] = importId
    ? await sql<Array<{ settings: { routing?: "auto" | "cheap" | "strong"; promptVersion?: string } }>>`select settings from imports where id = ${importId}`
    : [];
  const promptVersion = overrides?.promptVersion ?? imp?.settings.promptVersion ?? store?.settings.promptVersion ?? DEFAULT_PROMPT_VERSION;

  const all = await sql<ProductRow[]>`
    select id, store_id, handle, status, "group", source_input_hash, built_input_hash, deleted_at
    from products where id in ${sql(job.data.productIds)} and store_id = ${storeId}`;
  // Idempotent replay: products already built from this exact input are skipped (unless re-run on purpose).
  const products = all.filter(
    (p) => !p.deleted_at && p.group && (kind === "rerun" || p.status === "processing" || p.built_input_hash !== p.source_input_hash),
  );
  if (products.length === 0) {
    if (importId) await checkFinalize(importId);
    return;
  }

  const byTier = new Map<Tier, Array<ProductRow & { images: string[] }>>();
  for (const p of products) {
    const photoCount = p.group.photoKeys?.length ?? 0;
    const forced = overrides?.tier ?? (imp?.settings.routing && imp.settings.routing !== "auto" ? imp.settings.routing : undefined);
    const tier = routeModel(p.group, { threshold: store?.settings.routingThreshold, forceTier: forced, hasPhotos: photoCount > 0 });
    const images = tier === "vision" ? await thumbsFor(p.id, 2) : [];
    const list = byTier.get(tier) ?? [];
    list.push({ ...p, images });
    byTier.set(tier, list);
  }

  const missing: string[] = [];
  const built: string[] = [];
  for (const [tier, list] of byTier) {
    // Vision calls carry images and have tight output limits on Groq, so they go one product at a time.
    const batches = tier === "vision" ? list.map((p) => [p]) : [list];
    for (const batch of batches) {
      const { system, user } = buildProductPrompt(batch.map((p) => ({ id: p.id, group: p.group })), promptVersion);
      const log: CallLog = {
        storeId, importId, productIds: batch.map((p) => p.id), kind, tier, model: getProvider().modelFor(tier),
        attempt: job.attemptsMade + 1, promptVersion,
      };
      try {
        const out = await callModel(log, worker, { tier, system, user, images: batch.flatMap((p) => p.images), temperature: overrides?.temperature });
        // Persist per batch so a later failure never throws away work that already succeeded.
        for (const p of batch) {
          const ai = out.get(p.id);
          if (!ai) {
            missing.push(p.id);
            continue;
          }
          await persist(p, ai, log.model, promptVersion, store?.settings.reviewThreshold, overrides?.overwriteManual ?? false);
          built.push(p.id);
        }
      } catch (err) {
        if ((err as Error).name === "RateLimitError" || (err as Error).message === "bullmq:rateLimitExceeded") throw err;
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (!final) throw err;
        await markFailed(batch.map((p) => p.id), `AI build failed after ${job.attemptsMade + 1} attempts: ${(err as Error).message}`);
      }
    }
  }

  // A0/A7: products the model skipped in a batch are retried on their own.
  if (missing.length > 0) {
    if (job.data.productIds.length === 1) throw new AiInvalidOutputError("AI response did not include the product");
    for (const id of missing) {
      const p = products.find((x) => x.id === id)!;
      await enqueueBuild({ ...job.data, productIds: [id] }, `build:single:${id}:${p.source_input_hash}`);
    }
  }

  if (built.length) {
    await resumeImports(storeId);
    await enqueueTranslate({ storeId, importId, productIds: built }, `translate:${job.id}:${built[0]}`);
  }
  if (importId) {
    await refreshCounts(importId);
    await checkFinalize(importId);
  }
}

async function persist(p: ProductRow, ai: AiProduct, model: string, promptVersion: string, reviewThreshold: number | undefined, overwriteManual: boolean): Promise<void> {
  const { sql, db } = wdb();
  const guarded = applyGuards(p.group, ai, { reviewThreshold, handle: p.handle });
  const fields = fieldsFromOutput(guarded.output);

  await sql.begin(async (tx) => {
    const manual = new Map(
      (await tx<Array<{ field_path: string; value: string }>>`
        select field_path, value from product_fields where product_id = ${p.id} and origin = 'manual'`).map((r) => [r.field_path, r.value]),
    );
    for (const [field, value] of fields) {
      const confidence = guarded.output.confidence?.[field] ?? null;
      if (manual.has(field) && !overwriteManual) {
        // L1: a merchant's edit always wins; keep the AI suggestion next to it.
        await tx`update product_fields set ai_suggestion = ${value}, updated_at = now() where product_id = ${p.id} and field_path = ${field}`;
        continue;
      }
      await tx`
        insert into product_fields (product_id, store_id, field_path, value, confidence, origin, source_hash)
        values (${p.id}, ${p.store_id}, ${field}, ${value}, ${confidence}, 'ai', ${sha256Hex(value)})
        on conflict (product_id, field_path) do update set value = excluded.value, confidence = excluded.confidence,
          origin = 'ai', ai_suggestion = null, source_hash = excluded.source_hash, updated_at = now()`;
    }
    const output: ProductOutput = { ...guarded.output, status: guarded.status };
    if (!overwriteManual) {
      if (manual.has("title")) output.title = manual.get("title")!;
      if (manual.has("description_html")) output.description_html = manual.get("description_html")!;
    }
    const reasons = guarded.reviewReasons;
    await tx`
      update products set output = ${JSON.stringify(output)}::jsonb, title = ${output.title}, category = ${output.category},
        min_confidence = ${guarded.minConfidence}, review_reasons = ${JSON.stringify(reasons)}::jsonb, status = ${guarded.status},
        model = ${model}, prompt_version = ${promptVersion}, built_input_hash = source_input_hash,
        attempts = attempts + 1, error = null, version = version + 1, updated_at = now(),
        approved_at = case when ${guarded.status} = 'approved' then now() else null end
      where id = ${p.id}`;
    await tx`delete from claims where product_id = ${p.id}`;
    for (const c of guarded.claims) {
      await tx`insert into claims (product_id, store_id, text, source_row, source_column, source_quote, verified, rejected_reason)
        values (${p.id}, ${p.store_id}, ${c.text}, ${c.sourceRow ?? null}, ${c.sourceColumn ?? null}, ${c.sourceQuote ?? null}, ${c.verified}, ${c.rejectedReason ?? null})`;
    }
    // Rows that failed on an earlier attempt (dashboard "retry") are resolved too once the product builds.
    const rowStatus = guarded.status === "approved" ? "done" : "needs_review";
    await tx`update import_rows set status = ${rowStatus}, reason = ${reasons.length ? reasons.join("; ").slice(0, 1000) : null}, updated_at = now()
      where product_id = ${p.id} and status in ('grouped', 'pending', 'failed')`;
    // Queue translations: AI rows whose English changed go back to pending; manual ones become out of date (L3).
    const current = await tx<Array<{ field_path: string; source_hash: string }>>`
      select field_path, source_hash from product_fields where product_id = ${p.id}`;
    for (const f of current) {
      for (const locale of ["de", "fr"] as const) {
        await tx`
          insert into translations (product_id, store_id, field_path, locale, state)
          values (${p.id}, ${p.store_id}, ${f.field_path}, ${locale}, 'pending')
          on conflict (product_id, field_path, locale) do update set state = case
            when translations.source_hash is not distinct from ${f.source_hash} then translations.state
            when translations.origin = 'manual' then 'out_of_date'
            else 'pending' end, updated_at = now()`;
      }
    }
  });
  await publishProduct(db, p.id);
}

async function markFailed(productIds: string[], reason: string): Promise<void> {
  const { sql } = wdb();
  await sql`update products set status = 'failed', error = ${reason.slice(0, 1000)}, attempts = attempts + 1, updated_at = now()
    where id in ${sql(productIds)}`;
  await sql`update import_rows set status = 'failed', reason = ${reason.slice(0, 1000)}, updated_at = now()
    where product_id in ${sql(productIds)} and status in ('grouped', 'pending')`;
}
