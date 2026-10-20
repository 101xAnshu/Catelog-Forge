import { and, eq, inArray } from "@cf/db/orm";
import { NextResponse } from "next/server";
import { importRows, imports, products } from "@cf/db";
import { publishProgress, removeImportJobs } from "@cf/queue";
import { web } from "@/lib/db";
import { HttpError, withStore } from "@/lib/http";

export const runtime = "nodejs";

const TERMINAL = ["completed", "failed", "cancelled"];

/**
 * Cancel: stops an import in place. Unfinished rows end as failed ("Import cancelled") so the counts
 * still add up to the sheet; products already built are kept, products still waiting for AI are failed.
 */
export const POST = withStore<{ id: string }>(async (_req, ctx, { id }) => {
  const db = web().db;
  const [imp] = await db.select().from(imports).where(and(eq(imports.storeId, ctx.storeId), eq(imports.id, id))).limit(1);
  if (!imp) throw new HttpError(404, "NOT_FOUND", "Import not found.");
  if (TERMINAL.includes(imp.status)) throw new HttpError(409, "NOT_RUNNING", `Import is already ${imp.status}.`);

  await db.transaction(async (tx) => {
    await tx
      .update(imports)
      .set({ status: "cancelled", pausedUntil: null, pausedReason: null, error: "Cancelled by merchant", errorCode: "CANCELLED", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(imports.id, id));
    await tx
      .update(importRows)
      .set({ status: "failed", reason: "Import cancelled" })
      .where(and(eq(importRows.importId, id), inArray(importRows.status, ["pending", "grouped"])));
    await tx
      .update(products)
      .set({ status: "failed", error: "Import cancelled before the AI built this product", updatedAt: new Date() })
      .where(and(eq(products.storeId, ctx.storeId), eq(products.lastImportId, id), eq(products.status, "processing")));
  });
  const removedJobs = await removeImportJobs(id);
  await publishProgress(ctx.storeId, { type: "import", importId: id, status: "cancelled" }).catch(() => undefined);
  return NextResponse.json({ cancelled: true, removedJobs });
});
