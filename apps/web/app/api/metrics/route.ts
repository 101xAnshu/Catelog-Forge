import { NextResponse } from "next/server";
import { getMetrics } from "@/lib/metrics";
import { withStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withStore(async (_req, ctx) => NextResponse.json(await getMetrics(ctx.storeId)));
