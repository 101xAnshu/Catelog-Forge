import { NextResponse } from "next/server";
import { getImport } from "@/lib/imports";
import { HttpError, withStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withStore<{ id: string }>(async (_req, ctx, { id }) => {
  const imp = await getImport(ctx.storeId, id);
  if (!imp) throw new HttpError(404, "NOT_FOUND", "Import not found.");
  return NextResponse.json(imp);
}, { allowApiKey: true });
