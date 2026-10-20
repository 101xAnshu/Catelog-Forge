import { and, eq, inArray, isNull, sql } from "@cf/db/orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { products, variants } from "@cf/db";
import { enqueueBuild } from "@cf/queue";
import { web } from "@/lib/db";
import { withStore } from "@/lib/http";
import { republish } from "@/lib/publish";

export const runtime = "nodejs";

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
  action: z.enum(["approve", "send_back", "rerun"]),
  note: z.string().max(1000).optional(),
  overrides: z
    .object({
      tier: z.enum(["cheap", "strong", "vision"]).optional(),
      promptVersion: z.string().max(20).optional(),
      temperature: z.number().min(0).max(1).optional(),
      overwriteManual: z.boolean().optional(),
    })
    .optional(),
});

export const POST = withStore(async (req, ctx) => {
  const body = Body.parse(await req.json());
  const db = web().db;
  const scope = and(eq(products.storeId, ctx.storeId), inArray(products.id, body.ids), isNull(products.deletedAt));

  if (body.action === "approve") {
    // Products with an unpriced variant cannot be approved; they are reported back instead of silently skipped.
    const blocked = await db
      .selectDistinct({ id: products.id, title: products.title })
      .from(products)
      .leftJoin(variants, eq(variants.productId, products.id))
      .where(and(scope, sql`(${variants.id} is null or ${variants.priceCents} is null)`));
    const blockedIds = new Set(blocked.map((b) => b.id));
    const ok = body.ids.filter((id) => !blockedIds.has(id));
    if (ok.length) {
      await db
        .update(products)
        .set({ status: "approved", approvedAt: new Date(), version: sql`${products.version} + 1`, updatedAt: new Date() })
        .where(and(eq(products.storeId, ctx.storeId), inArray(products.id, ok), isNull(products.deletedAt)));
      await republish(ctx.storeId, ok);
    }
    return NextResponse.json({ approved: ok.length, blocked: blocked.map((b) => ({ id: b.id, title: b.title, reason: "Missing price" })) });
  }

  if (body.action === "send_back") {
    const rows = await db
      .update(products)
      .set({ status: "needs_review", approvedAt: null, reviewNote: body.note ?? null, version: sql`${products.version} + 1`, updatedAt: new Date() })
      .where(scope)
      .returning({ id: products.id });
    await republish(ctx.storeId, rows.map((r) => r.id));
    return NextResponse.json({ updated: rows.length });
  }

  const rows = await db
    .update(products)
    .set({ status: "processing", error: null, version: sql`${products.version} + 1`, updatedAt: new Date() })
    .where(scope)
    .returning({ id: products.id });
  const ids = rows.map((r) => r.id);
  await republish(ctx.storeId, ids);
  const stamp = Date.now();
  for (let i = 0; i < ids.length; i += 10) {
    await enqueueBuild(
      { importId: null, storeId: ctx.storeId, productIds: ids.slice(i, i + 10), kind: "rerun", overrides: body.overrides },
      `rerun:${ctx.storeId}:${stamp}:${i / 10}`,
    );
  }
  return NextResponse.json({ queued: ids.length });
});
