import { NextResponse } from "next/server";
import { listProducts, parseProductQuery } from "@/lib/products";
import { withStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withStore(async (req, ctx) => {
  const q = parseProductQuery(new URL(req.url));
  const { rows, total } = await listProducts(ctx.storeId, q);
  return NextResponse.json({ rows, total, page: q.page, pageSize: q.pageSize });
});
