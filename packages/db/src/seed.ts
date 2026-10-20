import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { apiKeys, countryLocales, storeMembers, stores, users } from "./schema";
import { hashPassword } from "./password";
import { hashToken } from "./tokens";

export const DEFAULT_COUNTRY_LOCALES: Array<[string, "de" | "fr"]> = [
  ["DE", "de"], ["AT", "de"], ["CH", "de"], ["LI", "de"], ["FR", "fr"], ["BE", "fr"], ["LU", "fr"], ["MC", "fr"],
];

export const DEMO_EMAIL = "demo@catalogforge.dev";
export const DEMO_PASSWORD = "demo1234";
export const DEMO_API_KEY = "cf_demo_0123456789abcdef0123456789abcdef";

/** Idempotent: demo store, user, API key and country→locale mapping. */
export async function seed(): Promise<{ storeId: string }> {
  const { db, close } = createDb("script");
  try {
    const [store] = await db
      .insert(stores)
      .values({ name: "Demo Garden Store", slug: "demo", baseCurrency: "EUR" })
      .onConflictDoUpdate({ target: stores.slug, set: { name: sql`excluded.name` } })
      .returning({ id: stores.id });
    if (!store) throw new Error("seed: store not created");
    const [user] = await db
      .insert(users)
      .values({ email: DEMO_EMAIL, passwordHash: await hashPassword(DEMO_PASSWORD) })
      .onConflictDoUpdate({ target: users.email, set: { passwordHash: sql`excluded.password_hash` } })
      .returning({ id: users.id });
    if (!user) throw new Error("seed: user not created");
    await db.insert(storeMembers).values({ storeId: store.id, userId: user.id, role: "owner" }).onConflictDoNothing();
    await db
      .insert(apiKeys)
      .values({ storeId: store.id, name: "Demo key", keyHash: hashToken(DEMO_API_KEY), prefix: DEMO_API_KEY.slice(0, 8) })
      .onConflictDoNothing();
    await db
      .insert(countryLocales)
      .values(DEFAULT_COUNTRY_LOCALES.map(([countryCode, locale]) => ({ storeId: store.id, countryCode, locale })))
      .onConflictDoNothing();
    return { storeId: store.id };
  } finally {
    await close();
  }
}

if (import.meta.main) {
  const { storeId } = await seed();
  console.info(`seeded demo store ${storeId} (login ${DEMO_EMAIL} / ${DEMO_PASSWORD})`);
}
