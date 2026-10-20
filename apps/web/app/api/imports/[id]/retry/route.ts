import { and, eq, inArray, isNotNull, sql } from "@cf/db/orm";
import { NextResponse } from "next/server";
import { importRows, imports, products } from "@cf/db";
import { enqueueBuild, enqueueImportStage } from "@cf/queue";
import { web } from "@/lib/db";
import { HttpError, withStore } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Retry: a failed-at-parse import re-runs from parse; otherwise the products behind failed rows are rebuilt.
 * The job id includes a timestamp so a deliberate retry is never swallowed by the dedupe of the original job.
 */
export const POST = withStore<{ id: string }>(async (_req, ctx, { id }) => {
  const db = web().db;
  const [imp] = await db.select().from(imports).where(and(eq(imports.storeId, ctx.storeId), eq(imports.id, id))).limit(1);
  if (!imp) throw new HttpError(404, "NOT_FOUND", "Import not found.");

  const [rowCount] = await db.select({ n: sql<number>`count(*)::int` }).from(importRows).where(eq(importRows.importId, id));
  if (imp.status === "failed" && (rowCount?.n ?? 0) === 0) {
    await db.update(imports).set({ status: "queued", error: null, errorCode: null, updatedAt: new Date() }).where(eq(imports.id, id));
    await enqueueImportStage({ importId: id, storeId: ctx.storeId, stage: "parse" });
    return NextResponse.json({ retried: "import" });
  }

  const failed = await db
    .selectDistinct({ productId: importRows.productId })
    .from(importRows)
    .where(and(eq(importRows.importId, id), eq(importRows.status, "failed"), isNotNull(importRows.productId)));
  const productIds = failed.map((r) => r.productId).filter((p): p is string => !!p);
  if (productIds.length === 0) return NextResponse.json({ retried: 0, message: "No retryable failed rows (rows that failed cleaning need a corrected sheet)." });

  await db.transaction(async (tx) => {
    await tx
      .update(products)
      .set({ status: "processing", error: null, updatedAt: new Date() })
      .where(and(eq(products.storeId, ctx.storeId), inArray(products.id, productIds)));
    await tx
      .update(importRows)
      .set({ status: "grouped", reason: null })
      .where(and(eq(importRows.importId, id), eq(importRows.status, "failed"), inArray(importRows.productId, productIds)));
    await tx.update(imports).set({ status: "building", finishedAt: null, updatedAt: new Date() }).where(eq(imports.id, id));
  });
  const stamp = Date.now();
  for (let i = 0; i < productIds.length; i += 10) {
    await enqueueBuild(
      { importId: id, storeId: ctx.storeId, productIds: productIds.slice(i, i + 10), kind: "build" },
      `retry:${id}:${stamp}:${i / 10}`,
    );
  }
  return NextResponse.json({ retried: productIds.length });
});
