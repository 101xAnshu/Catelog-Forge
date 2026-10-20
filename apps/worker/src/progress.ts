import type { ImportCounts, ImportStatus } from "@cf/db";
import { publishProgress } from "@cf/queue";
import { wdb } from "./db";

export async function setImportStatus(
  importId: string,
  status: ImportStatus,
  extra: { stage?: string; error?: string; errorCode?: string } = {},
): Promise<void> {
  const { sql } = wdb();
  const [row] = await sql<{ store_id: string }[]>`
    update imports set status = ${status},
      stage = coalesce(${extra.stage ?? null}, stage),
      error = coalesce(${extra.error ?? null}, error),
      error_code = coalesce(${extra.errorCode ?? null}, error_code),
      paused_until = case when ${status} = 'paused' then paused_until else null end,
      paused_reason = case when ${status} = 'paused' then paused_reason else null end,
      started_at = coalesce(started_at, now()),
      finished_at = case when ${status} in ('completed','failed') then now() else finished_at end,
      updated_at = now()
    where id = ${importId}
    returning store_id`;
  if (row) await publishProgress(row.store_id, { type: "import", importId, status });
}

export async function failImport(importId: string, errorCode: string, error: string): Promise<void> {
  await setImportStatus(importId, "failed", { error, errorCode });
}

/** Recomputes the per-import counters from row statuses (the source of truth) and broadcasts them. */
export async function refreshCounts(importId: string): Promise<ImportCounts | null> {
  const { sql } = wdb();
  const [c] = await sql<Array<ImportCounts & { store_id: string }>>`
    select i.store_id,
      i.total_rows::int as total,
      count(r.id) filter (where r.status in ('pending','grouped'))::int as pending,
      count(r.id) filter (where r.status = 'done')::int as done,
      count(r.id) filter (where r.status = 'needs_review')::int as needs_review,
      count(r.id) filter (where r.status = 'failed')::int as failed,
      (select count(distinct r2.product_id) from import_rows r2 where r2.import_id = i.id and r2.product_id is not null)::int as products,
      (select count(*) from assets a where a.import_id = i.id and a.status = 'orphan')::int as orphan_photos
    from imports i left join import_rows r on r.import_id = i.id
    where i.id = ${importId}
    group by i.id`;
  if (!c) return null;
  const { store_id, ...counts } = c;
  // Merge so extra counters (e.g. skipped_unchanged written by the group stage) survive.
  await sql`update imports set counts = coalesce(counts, '{}'::jsonb) || ${JSON.stringify(counts)}::jsonb, updated_at = now() where id = ${importId}`;
  await publishProgress(store_id, { type: "import", importId });
  return counts;
}
