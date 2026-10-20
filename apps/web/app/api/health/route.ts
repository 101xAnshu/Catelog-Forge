import { NextResponse } from "next/server";
import { redisConnection } from "@cf/queue";
import { web } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Platform health check: 200 when Postgres and Redis answer, 503 otherwise. */
export async function GET() {
  const checks: Record<string, "ok" | string> = {};
  try {
    await web().sql`select 1`;
    checks.postgres = "ok";
  } catch (err) {
    checks.postgres = (err as Error).message.slice(0, 200);
  }
  try {
    checks.redis = (await redisConnection().ping()) === "PONG" ? "ok" : "unexpected reply";
  } catch (err) {
    checks.redis = (err as Error).message.slice(0, 200);
  }
  const ok = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
