import { NextResponse } from "next/server";
import { listImports } from "@/lib/imports";
import { withStore } from "@/lib/http";
import { assertRequestSize, createImportFromForm } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withStore(async (_req, ctx) => NextResponse.json({ imports: await listImports(ctx.storeId) }));

export const POST = withStore(async (req, ctx) => {
  assertRequestSize(req);
  const form = await req.formData();
  const result = await createImportFromForm(ctx.storeId, form, "dashboard");
  return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
});
