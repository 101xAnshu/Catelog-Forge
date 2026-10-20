import { NextResponse } from "next/server";
import { z } from "zod";
import { getProductDetail } from "@/lib/products";
import { patchProduct, softDeleteProduct } from "@/lib/product-mutations";
import { HttpError, withStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Patch = z.object({
  version: z.number().int(),
  fields: z.record(z.string().max(80), z.string().max(20000)).optional(),
  translations: z.array(z.object({ fieldPath: z.string(), locale: z.enum(["de", "fr"]), value: z.string().max(20000) })).optional(),
  variants: z
    .array(
      z.object({
        id: z.string().uuid(),
        priceCents: z.number().int().nullable().optional(),
        currency: z.string().nullable().optional(),
        sku: z.string().max(100).nullable().optional(),
        weightGrams: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .optional(),
  action: z.enum(["approve", "send_back", "reject"]).optional(),
  note: z.string().max(1000).optional(),
});

export const GET = withStore<{ id: string }>(async (_req, ctx, { id }) => {
  const detail = await getProductDetail(ctx.storeId, id);
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Product not found.");
  return NextResponse.json(detail);
});

export const PATCH = withStore<{ id: string }>(async (req, ctx, { id }) => {
  const body = Patch.parse(await req.json());
  return NextResponse.json(await patchProduct(ctx.storeId, id, body));
});

export const DELETE = withStore<{ id: string }>(async (_req, ctx, { id }) => {
  await softDeleteProduct(ctx.storeId, id);
  return NextResponse.json({ ok: true });
});
