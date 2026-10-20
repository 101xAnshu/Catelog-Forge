import { cleanRow, type CleanedRow, type HeaderMap } from "@cf/core";
import { enqueueImportStage } from "@cf/queue";
import { wdb } from "../db";
import { refreshCounts, setImportStatus } from "../progress";
import { rawKeys } from "./parse";

const CHUNK = 1000;

/** A row we cannot turn into anything sellable, with the reason shown to the merchant. */
function unusableReason(row: CleanedRow): string | null {
  if (!row.sku && !row.name && !row.descriptionText && !row.parentSku) {
    return "Row has no SKU, name or description, so it cannot be matched to a product";
  }
  return null;
}

export async function runClean(importId: string): Promise<void> {
  const { sql } = wdb();
  const [imp] = await sql<Array<{ store_id: string; status: string; settings: { headerMap?: HeaderMap }; base_currency: string }>>`
    select i.store_id, i.status, i.settings, s.base_currency from imports i join stores s on s.id = i.store_id where i.id = ${importId}`;
  if (!imp || imp.status === "completed" || imp.status === "failed") return;
  const header = imp.settings.headerMap;
  if (!header) throw new Error(`Import ${importId} has no header map; parse did not finish`);
  await setImportStatus(importId, "cleaning", { stage: "clean" });

  // jsonb does not keep key order, so cells are rebuilt in header order from the stored keys.
  const keys = rawKeys(header);
  const cleanHeader: HeaderMap = { ...header, columns: header.columns.map((c, i) => ({ ...c, index: i })) };

  // Resumable: only rows not cleaned yet are processed, in chunks.
  for (;;) {
    const rows = await sql<Array<{ id: string; row_number: number; raw: Record<string, string> }>>`
      select id, row_number, raw from import_rows
      where import_id = ${importId} and cleaned is null and status = 'pending'
      order by row_number limit ${CHUNK}`;
    if (rows.length === 0) break;
    const values = rows.map((r) => {
      const cells = keys.map((k) => r.raw[k] ?? "");
      const cleaned = cleanRow(cells, cleanHeader, r.row_number, {
        defaultCurrency: imp.base_currency,
      });
      const reason = unusableReason(cleaned);
      return [r.id, JSON.stringify(cleaned), JSON.stringify(cleaned.issues), cleaned.rowHash, reason ? "failed" : "pending", reason];
    });
    await sql`
      update import_rows as t set
        cleaned = v.cleaned::jsonb, issues = v.issues::jsonb, row_hash = v.row_hash,
        status = v.status, reason = v.reason, updated_at = now()
      from (values ${sql(values as never)}) as v(id, cleaned, issues, row_hash, status, reason)
      where t.id = v.id::uuid`;
    await refreshCounts(importId);
  }
  await setImportStatus(importId, "grouping", { stage: "group" });
  await enqueueImportStage({ importId, storeId: imp.store_id, stage: "group" });
}
