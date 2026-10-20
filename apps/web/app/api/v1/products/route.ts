import { NextResponse } from "next/server";
import { and, asc, eq, gt, inArray, isNull } from "@cf/db/orm";
import { products, variants } from "@cf/db";
import { web } from "@/lib/db";
import { withStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public API: approved products, cursor-paginated by id. */
export const GET = withStore(async (req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const cursor = url.searchParams.get("cursor");
  const db = web().db;
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.storeId, ctx.storeId), eq(products.status, "approved"), isNull(products.deletedAt), cursor ? gt(products.id, cursor) : undefined))
    .orderBy(asc(products.id))
    .limit(limit);
  const vs = rows.length ? await db.select().from(variants).where(inArray(variants.productId, rows.map((r) => r.id))).orderBy(asc(variants.position)) : [];
  const data = rows.map((p) => ({
    id: p.id,
    ...(p.output ?? {}),
    handle: p.handle,
    status: p.status,
    variants: vs
      .filter((v) => v.productId === p.id)
      .map((v) => ({ sku: v.sku, options: v.options, price_cents: v.priceCents, currency: v.currency, weight_grams: v.weightGrams })),
  }));
  return NextResponse.json({ data, nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null });
}, { allowApiKey: true });
