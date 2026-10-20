import { NextResponse } from "next/server";
import { getImport, importRowsPage, orphanPhotos } from "@/lib/imports";
import { HttpError, withStore } from "@/lib/http";

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
