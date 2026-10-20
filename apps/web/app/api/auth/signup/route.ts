import { eq } from "@cf/db/orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_COUNTRY_LOCALES, countryLocales, hashPassword, storeMembers, stores, users } from "@cf/db";
import { createSession } from "@/lib/auth";
import { web } from "@/lib/db";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Use at least 8 characters"),
  storeName: z.string().min(2).max(80),
  currency: z.string().regex(/^[A-Z]{3}$/).default("EUR"),
});

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 40) || "store";
}

/** Creates user + store + membership + default country→locale mapping in one transaction. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const { email, password, storeName, currency } = parsed.data;
  const db = web().db;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing) return errorResponse(409, "EMAIL_TAKEN", "An account with this email already exists.");
  const passwordHash = await hashPassword(password);
  const userId = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ email: email.toLowerCase(), passwordHash }).returning({ id: users.id });
    const slug = `${slugify(storeName)}-${Math.random().toString(36).slice(2, 7)}`;
    const [store] = await tx.insert(stores).values({ name: storeName, slug, baseCurrency: currency }).returning({ id: stores.id });
    if (!user || !store) throw new Error("signup failed");
    await tx.insert(storeMembers).values({ storeId: store.id, userId: user.id, role: "owner" });
    await tx
      .insert(countryLocales)
      .values(DEFAULT_COUNTRY_LOCALES.map(([countryCode, locale]) => ({ storeId: store.id, countryCode, locale })));
    return user.id;
  });
  await createSession(userId);
  return NextResponse.json({ ok: true }, { status: 201 });
}
