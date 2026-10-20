import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./client";

const folder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(): Promise<void> {
  const { db, close } = createDb("script");
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  await runMigrations();
  console.info("migrations applied");
}
