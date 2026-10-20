import { eq } from "@cf/db/orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { users, verifyPassword } from "@cf/db";
import { createSession } from "@/lib/auth";
import { web } from "@/lib/db";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "INVALID_INPUT", "Enter an email and password.");
  const [user] = await web().db.select().from(users).where(eq(users.email, parsed.data.email.toLowerCase())).limit(1);
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return errorResponse(401, "INVALID_CREDENTIALS", "Email or password is wrong.");
  }
  await createSession(user.id);
  return NextResponse.json({ ok: true });
}
