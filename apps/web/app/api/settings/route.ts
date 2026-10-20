import { and, eq, notInArray } from "@cf/db/orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiKeys, countryLocales, stores } from "@cf/db";
import { web } from "@/lib/db";
import { withStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withStore(async (_req, ctx) => {
  const db = web().db;
  const [locales, keys] = await Promise.all([
    db.select().from(countryLocales).where(eq(countryLocales.storeId, ctx.storeId)).orderBy(countryLocales.countryCode),
    db
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .where(eq(apiKeys.storeId, ctx.storeId))
      .orderBy(apiKeys.createdAt),
  ]);
  const s = ctx.store;
  return NextResponse.json({
    store: { id: s.id, name: s.name, slug: s.slug, baseCurrency: s.baseCurrency, webhookUrl: s.webhookUrl, webhookSecret: s.webhookSecret, settings: s.settings },
    countryLocales: locales.map((l) => ({ countryCode: l.countryCode, locale: l.locale })),
    apiKeys: keys,
    demoMode: !process.env.GROQ_API_KEY,
  });
});

const Body = z.object({
  name: z.string().min(2).max(80).optional(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  webhookUrl: z.union([z.string().url().startsWith("http"), z.literal("")]).optional(),
  settings: z
    .object({
      routingThreshold: z.number().int().min(0).max(100).optional(),
      reviewThreshold: z.number().int().min(0).max(100).optional(),
      promptVersion: z.enum(["v1", "v2"]).optional(),
      useBatch: z.boolean().optional(),
      brandGlossary: z.array(z.string().max(80)).max(200).optional(),
    })
    .optional(),
  countryLocales: z
    .array(z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/), locale: z.enum(["en", "de", "fr"]) }))
    .max(250)
    .optional(),
});

export const POST = withStore(async (req, ctx) => {
  const body = Body.parse(await req.json());
  const db = web().db;
  await db.transaction(async (tx) => {
    const set: Partial<typeof stores.$inferInsert> = {};
    if (body.name) set.name = body.name;
    if (body.baseCurrency) set.baseCurrency = body.baseCurrency;
    if (body.webhookUrl !== undefined) set.webhookUrl = body.webhookUrl || null;
    if (body.settings) set.settings = { ...ctx.store.settings, ...body.settings };
    if (Object.keys(set).length) await tx.update(stores).set(set).where(eq(stores.id, ctx.storeId));
    if (body.countryLocales) {
      const codes = body.countryLocales.map((c) => c.countryCode);
      await tx
        .delete(countryLocales)
        .where(and(eq(countryLocales.storeId, ctx.storeId), codes.length ? notInArray(countryLocales.countryCode, codes) : undefined));
      for (const c of body.countryLocales) {
        await tx
          .insert(countryLocales)
          .values({ storeId: ctx.storeId, countryCode: c.countryCode, locale: c.locale })
          .onConflictDoUpdate({ target: [countryLocales.storeId, countryLocales.countryCode], set: { locale: c.locale } });
      }
    }
  });
  return NextResponse.json({ ok: true });
});
