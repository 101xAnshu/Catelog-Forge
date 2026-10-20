import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { and, eq, inArray } from "@cf/db/orm";
import { events, imports, products, storefrontProducts } from "@cf/db";
import { web } from "@/lib/db";
import { getImport, importRowsPage, orphanPhotos } from "@/lib/imports";
import { HttpError, withStore } from "@/lib/http";
import { storagePath } from "@/lib/storage";
import { storefrontTag } from "@/lib/storefront/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withStore<{ id: string }>(async (req, ctx, { id }) => {
  const imp = await getImport(ctx.storeId, id);
  if (!imp) throw new HttpError(404, "NOT_FOUND", "Import not found.");
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get("pageSize") ?? 50)));
  const status = url.searchParams.get("status") ?? undefined;
  const [rows, orphans] = await Promise.all([importRowsPage(ctx.storeId, id, { status, page, pageSize }), orphanPhotos(ctx.storeId, id)]);
  return NextResponse.json({ import: imp, rows: rows.rows, totalRows: rows.total, page, pageSize, orphanPhotos: orphans });
});

/**
 * Deletes a finished run and undoes it: its rows, photos and uploaded files, plus the products it last
 * touched (and their storefront entries). Products a later import also updated are kept; AI cost history
 * stays so metrics remain accurate. Running imports must be cancelled first so no worker writes into them.
 */
export const DELETE = withStore<{ id: string }>(async (_req, ctx, { id }) => {
  const db = web().db;
  const [imp] = await db.select().from(imports).where(and(eq(imports.storeId, ctx.storeId), eq(imports.id, id))).limit(1);
  if (!imp) throw new HttpError(404, "NOT_FOUND", "Import not found.");
  if (!["completed", "failed", "cancelled"].includes(imp.status)) {
    throw new HttpError(409, "IMPORT_RUNNING", "This import is still running. Cancel it first, then delete it.");
  }

  const deletedProducts = await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.storeId, ctx.storeId), eq(products.lastImportId, id)));
    const ids = owned.map((p) => p.id);
    if (ids.length) {
      await tx.delete(storefrontProducts).where(and(eq(storefrontProducts.storeId, ctx.storeId), inArray(storefrontProducts.productId, ids)));
      await tx.delete(products).where(and(eq(products.storeId, ctx.storeId), inArray(products.id, ids))); // cascades variants, fields, claims, translations
    }
    await tx.delete(events).where(and(eq(events.storeId, ctx.storeId), eq(events.importId, id)));
    await tx.delete(imports).where(eq(imports.id, id)); // cascades import_rows and assets
    return ids.length;
  });

  // Uploaded sheet/zip live in one per-upload folder; shared thumbnails (keyed by content hash) are left alone.
  await rm(storagePath(dirname(imp.sheetKey)), { recursive: true, force: true }).catch(() => undefined);
  revalidateTag(storefrontTag(ctx.storeId));
  return NextResponse.json({ deleted: true, deletedProducts });
});
