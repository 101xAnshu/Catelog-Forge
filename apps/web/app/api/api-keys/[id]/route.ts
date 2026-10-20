import { and, eq } from "@cf/db/orm";
import { NextResponse } from "next/server";
import { apiKeys } from "@cf/db";
import { web } from "@/lib/db";
import { HttpError, withStore } from "@/lib/http";

export const runtime = "nodejs";

export const DELETE = withStore<{ id: string }>(async (_req, ctx, { id }) => {
  if (ctx.via !== "session") throw new HttpError(403, "FORBIDDEN", "Revoke keys from the dashboard.");
  const rows = await web()
    .db.update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.storeId, ctx.storeId)))
    .returning({ id: apiKeys.id });
  if (!rows.length) throw new HttpError(404, "NOT_FOUND", "API key not found.");
  return NextResponse.json({ ok: true });
});
