import { enqueueWebhook, publishProgress } from "@cf/queue";
import { wdb } from "../db";
import { refreshCounts } from "../progress";

/**
 * Completes an import once every row is terminal, no product is still building and no translation is pending.
 * Safe to call any number of times from any worker: the import row is locked and the event insert is idempotent.
 */
export async function checkFinalize(importId: string): Promise<boolean> {
  const { sql } = wdb();
  const [open] = await sql<Array<{ rows: number; products: number; translations: number; status: string }>>`
    select
      (select count(*) from import_rows where import_id = ${importId} and status in ('pending', 'grouped'))::int as rows,
      (select count(*) from products where last_import_id = ${importId} and status = 'processing')::int as products,
      (select count(*) from translations t join products p on p.id = t.product_id
        where p.last_import_id = ${importId} and t.state = 'pending')::int as translations,
      (select status from imports where id = ${importId}) as status`;
  if (!open || ["completed", "failed", "cancelled", "queued", "parsing", "cleaning", "grouping"].includes(open.status)) return false;
  if (open.rows > 0 || open.products > 0) return false;
  if (open.translations > 0) {
    if (open.status === "building") {
      await sql`update imports set status = 'translating', stage = 'translate', updated_at = now() where id = ${importId} and status = 'building'`;
    }
    return false;
  }

  const counts = await refreshCounts(importId);
  if (!counts) return false;
  const event = await sql.begin(async (tx) => {
    const [imp] = await tx<Array<{ store_id: string; status: string; total_rows: number; filename: string }>>`
      select store_id, status, total_rows, filename from imports where id = ${importId} for update`;
    if (!imp || imp.status === "completed" || imp.status === "failed" || imp.status === "cancelled") return null;
    const sum = counts.done + counts.needs_review + counts.failed;
    const ok = sum === imp.total_rows;
    await tx`update imports set status = ${ok ? "completed" : "failed"}, stage = 'finalize',
      error = ${ok ? null : `Counts do not add up: ${sum} of ${imp.total_rows} rows accounted for`},
      error_code = ${ok ? null : "COUNTS_MISMATCH"}, finished_at = now(), paused_until = null, paused_reason = null, updated_at = now()
      where id = ${importId}`;
    const type = ok ? "import.completed" : "import.failed";
    const [ev] = await tx<Array<{ id: string }>>`
      insert into events (store_id, import_id, type, payload)
      values (${imp.store_id}, ${importId}, ${type}, ${JSON.stringify({ importId, filename: imp.filename, status: ok ? "completed" : "failed", counts })}::jsonb)
      on conflict (import_id, type) do nothing returning id`;
    return ev ? { id: ev.id, storeId: imp.store_id, status: ok ? "completed" : "failed" } : null;
  });
  if (!event) return false;
  await enqueueWebhook(event.id);
  await publishProgress(event.storeId, { type: "import", importId, status: event.status });
  return true;
}
