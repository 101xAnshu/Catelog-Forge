import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export type DbRole = "web" | "storefront" | "worker" | "script";

/**
 * Each process role gets its own pool so a busy worker can never starve storefront reads:
 * `storefront` (small, short statement timeout), `web` (dashboard/API), `worker`.
 */
export function createDb(role: DbRole = "script"): DbHandle {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const max = { web: 10, storefront: 5, worker: 8, script: 4 }[role];
  const client = postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: {
      application_name: `catalogforge-${role}`,
      statement_timeout: role === "storefront" ? 2000 : role === "worker" ? 60000 : 15000,
    },
  });
  return { db: drizzle(client, { schema }), sql: client, close: () => client.end({ timeout: 5 }) };
}

const globalCache = globalThis as unknown as { __cfDb?: Partial<Record<DbRole, DbHandle>> };

/** Process-wide singleton per role (survives Next.js dev hot reloads). */
export function getDb(role: DbRole = "web"): DbHandle {
  globalCache.__cfDb ??= {};
  const existing = globalCache.__cfDb[role];
  if (existing) return existing;
  const handle = createDb(role);
  globalCache.__cfDb[role] = handle;
  return handle;
}
