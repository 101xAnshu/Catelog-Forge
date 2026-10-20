import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Walks up from this file to the monorepo root (the package.json that declares workspaces). */
export function repoRoot(): string {
  if (process.env.CF_REPO_ROOT) return process.env.CF_REPO_ROOT;
  let dir = import.meta.dir;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && readFileSync(pkg, "utf8").includes('"workspaces"')) return dir;
    dir = dirname(dir);
  }
  return resolve(import.meta.dir, "../../..");
}

/** Bun only auto-loads .env from the cwd; the worker also runs from apps/worker, so load the root one. */
export function loadRootEnv(): void {
  const file = join(repoRoot(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value.replace(/^["']|["']$/g, "");
  }
}
