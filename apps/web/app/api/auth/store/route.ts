import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { STORE_COOKIE } from "@/lib/auth";
import { withStore, HttpError } from "@/lib/http";

export const runtime = "nodejs";

/** Switches the active store (only to a store the user is a member of). */
export const POST = withStore(async (req, ctx) => {
  const { storeId } = z.object({ storeId: z.string().uuid() }).parse(await req.json());
  if (!ctx.stores.some((s) => s.id === storeId)) throw new HttpError(403, "FORBIDDEN", "Not a member of that store.");
  (await cookies()).set(STORE_COOKIE, storeId, { httpOnly: true, sameSite: "lax", path: "/" });
  return NextResponse.json({ ok: true });
});
