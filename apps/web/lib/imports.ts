import { and, desc, eq, inArray, sql } from "@cf/db/orm";
import { assets, importRows, imports } from "@cf/db";
import { web } from "./db";

export interface LiveCounts {
  total: number;
  pending: number;
  done: number;
  needs_review: number;
  failed: number;
}

/** Counts straight from row statuses, so the UI always matches the invariant done+review+failed+pending = total. */
export async function liveCounts(importIds: string[]): Promise<Map<string, LiveCounts>> {
  const out = new Map<string, LiveCounts>();
  if (importIds.length === 0) return out;
  const rows = await web()
    .db.select({ importId: importRows.importId, status: importRows.status, n: sql<number>`count(*)::int` })
    .from(importRows)
    .where(inArray(importRows.importId, importIds))
    .groupBy(importRows.importId, importRows.status);
  for (const id of importIds) out.set(id, { total: 0, pending: 0, done: 0, needs_review: 0, failed: 0 });
  for (const r of rows) {
    const c = out.get(r.importId);
    if (!c) continue;
    c.total += r.n;
    if (r.status === "done") c.done += r.n;
    else if (r.status === "needs_review") c.needs_review += r.n;
    else if (r.status === "failed") c.failed += r.n;
    else c.pending += r.n;
  }
  return out;
}

export async function listImports(storeId: string, limit = 30) {
  const rows = await web()
    .db.select()
    .from(imports)
    .where(eq(imports.storeId, storeId))
    .orderBy(desc(imports.createdAt))
    .limit(limit);
  const counts = await liveCounts(rows.map((r) => r.id));
  return rows.map((r) => serializeImport(r, counts.get(r.id)));
}

export function serializeImport(r: typeof imports.$inferSelect, live?: LiveCounts) {
  const total = Math.max(r.totalRows, live?.total ?? 0);
  const counts = {
    ...r.counts,
    total,
    done: live?.done ?? r.counts.done ?? 0,
    needs_review: live?.needs_review ?? r.counts.needs_review ?? 0,
    failed: live?.failed ?? r.counts.failed ?? 0,
    pending: live ? total - live.done - live.needs_review - live.failed : r.counts.pending ?? 0,
  };
  const elapsedMs = r.startedAt ? (r.finishedAt ?? new Date()).getTime() - r.startedAt.getTime() : 0;
  const processed = counts.done + counts.needs_review + counts.failed;
  return {
    id: r.id,
    filename: r.filename,
    status: r.status,
    stage: r.stage,
    source: r.source,
    pausedUntil: r.pausedUntil?.toISOString() ?? null,
    pausedReason: r.pausedReason,
    error: r.error,
    errorCode: r.errorCode,
    settings: r.settings,
    counts,
    rowsPerMinute: elapsedMs > 5000 ? Math.round((processed / elapsedMs) * 60000) : null,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

export async function getImport(storeId: string, id: string) {
  const [row] = await web().db.select().from(imports).where(and(eq(imports.storeId, storeId), eq(imports.id, id))).limit(1);
  if (!row) return null;
  const counts = await liveCounts([id]);
  return serializeImport(row, counts.get(id));
}

export async function importRowsPage(
  storeId: string,
  importId: string,
  opts: { status?: string; page: number; pageSize: number },
) {
  const where = and(
    eq(importRows.storeId, storeId),
    eq(importRows.importId, importId),
    opts.status ? eq(importRows.status, opts.status as typeof importRows.$inferSelect.status) : undefined,
  );
  const db = web().db;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        rowNumber: importRows.rowNumber,
        status: importRows.status,
        reason: importRows.reason,
        issues: importRows.issues,
        productId: importRows.productId,
        raw: importRows.raw,
      })
      .from(importRows)
      .where(where)
      .orderBy(importRows.rowNumber)
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(importRows).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}

export async function orphanPhotos(storeId: string, importId: string) {
  return web()
    .db.select({ id: assets.id, filename: assets.filename, status: assets.status, reason: assets.reason, thumbKey: assets.thumbKey })
    .from(assets)
    .where(and(eq(assets.storeId, storeId), eq(assets.importId, importId), inArray(assets.status, ["orphan", "invalid"])))
    .orderBy(assets.filename)
    .limit(500);
}
