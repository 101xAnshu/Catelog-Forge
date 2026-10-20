import { NextResponse } from "next/server";
import { listImports } from "@/lib/imports";
import { withStore } from "@/lib/http";
import { assertRequestSize, createImportFromForm } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public API: programmatic imports. Auth: `Authorization: Bearer <api key>`. */
export const POST = withStore(async (req, ctx) => {
  assertRequestSize(req);
  const result = await createImportFromForm(ctx.storeId, await req.formData(), "api");
  const base = process.env.APP_URL ?? new URL(req.url).origin;
  return NextResponse.json(
    { ...result, statusUrl: `${base}/api/v1/imports/${result.id}` },
    { status: result.duplicate ? 200 : 202 },
  );
}, { allowApiKey: true });

export const GET = withStore(async (_req, ctx) => NextResponse.json({ imports: await listImports(ctx.storeId, 50) }), { allowApiKey: true });
