import { and, eq, gt, isNull } from "@cf/db/orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { apiKeys, hashToken, sessions, storeMembers, stores, users } from "@cf/db";
import { web } from "./db";

export const SESSION_COOKIE = "cf_session";
export const STORE_COOKIE = "cf_store";
const SESSION_DAYS = 14;

export interface StoreContext {
  userId: string | null;
  email: string | null;
  storeId: string;
  store: typeof stores.$inferSelect;
  stores: Array<{ id: string; name: string }>;
  via: "session" | "api_key";
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await web().db.insert(sessions).values({ id: hashToken(token), userId, expiresAt });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await web().db.delete(sessions).where(eq(sessions.id, hashToken(token)));
  jar.delete(SESSION_COOKIE);
  jar.delete(STORE_COOKIE);
}

async function currentUser(): Promise<{ id: string; email: string } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await web()
    .db.select({ id: users.id, email: users.email })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

async function storeForUser(userId: string, email: string): Promise<StoreContext | null> {
  const memberships = await web()
    .db.select({ store: stores })
    .from(storeMembers)
    .innerJoin(stores, eq(stores.id, storeMembers.storeId))
    .where(eq(storeMembers.userId, userId))
    .orderBy(stores.createdAt);
  if (memberships.length === 0) return null;
  const wanted = (await cookies()).get(STORE_COOKIE)?.value;
  const chosen = memberships.find((m) => m.store.id === wanted) ?? memberships[0];
  if (!chosen) return null;
  return {
    userId,
    email,
    storeId: chosen.store.id,
    store: chosen.store,
    stores: memberships.map((m) => ({ id: m.store.id, name: m.store.name })),
    via: "session",
  };
}

async function storeForApiKey(): Promise<StoreContext | null> {
  const auth = (await headers()).get("authorization");
  const key = auth?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key) return null;
  const [row] = await web()
    .db.select({ store: stores, keyId: apiKeys.id })
    .from(apiKeys)
    .innerJoin(stores, eq(stores.id, apiKeys.storeId))
    .where(and(eq(apiKeys.keyHash, hashToken(key)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  void web().db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId)).catch(() => undefined);
  return { userId: null, email: null, storeId: row.store.id, store: row.store, stores: [{ id: row.store.id, name: row.store.name }], via: "api_key" };
}

/** Resolves the store for an API request: session cookie first, then `Authorization: Bearer <api key>`. */
export async function getStoreContext(opts: { allowApiKey?: boolean } = {}): Promise<StoreContext | null> {
  const user = await currentUser();
  if (user) return storeForUser(user.id, user.email);
  if (opts.allowApiKey) return storeForApiKey();
  return null;
}

/** For server components: redirects to /login when not signed in. */
export async function requireStore(): Promise<StoreContext> {
  const ctx = await getStoreContext();
  if (!ctx) redirect("/login");
  return ctx;
}
