import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createStore, db, duplicateCheck, importState, messyCsv, rowCounts, startImport, waitForImport } from "./helpers";

const ROOT = join(import.meta.dir, "../..");

function spawnWorker(extraEnv: Record<string, string> = {}) {
  return Bun.spawn(["bun", join(ROOT, "apps/worker/src/index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      AI_PROVIDER: "fake",
      FAKE_AI_LATENCY_MS: "120",
      WORKER_BUILD_CONCURRENCY: "2",
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function terminalRatio(importId: string): Promise<number> {
  const s = await importState(importId);
  if (!s.total_rows) return 0;
  const c = await rowCounts(importId);
  return ((c.done ?? 0) + (c.needs_review ?? 0) + (c.failed ?? 0)) / s.total_rows;
}

describe("crash safety", () => {
  test("kill -9 mid-import, restart: resumes, nothing lost, nothing doubled", async () => {
    const storeId = await createStore("restart test");
    const csv = messyCsv(400, 11);
    const { id } = await startImport(storeId, csv, "restart.csv");

    let worker = spawnWorker();
    // wait until ~40% of rows are finished, then crash hard (no graceful shutdown)
    const started = Date.now();
    let ratio = 0;
    while ((ratio = await terminalRatio(id)) < 0.4) {
      if (Date.now() - started > 120_000) throw new Error(`never reached 40% (at ${ratio})`);
      await Bun.sleep(100);
    }
    worker.kill(9);
    await worker.exited;
    const atCrash = await terminalRatio(id);
    expect(atCrash).toBeLessThan(1);
    expect((await importState(id)).status).not.toBe("completed");

    worker = spawnWorker();
    const final = await waitForImport(id, 240_000);
    worker.kill("SIGTERM");
    await worker.exited;

    expect(final.status).toBe("completed");
    const counts = await rowCounts(id);
    expect((counts.done ?? 0) + (counts.needs_review ?? 0) + (counts.failed ?? 0)).toBe(final.total_rows);
    expect(counts.pending ?? 0).toBe(0);
    expect(counts.grouped ?? 0).toBe(0);
    const dup = await duplicateCheck(storeId);
    expect(dup.dupSkus).toBe(0);
    expect(dup.dupHandles).toBe(0);
    expect(dup.products).toBe(400);
    const { sql } = db();
    const [ev] = await sql<Array<{ n: number }>>`select count(*)::int as n from events where import_id = ${id}`;
    expect(ev!.n).toBe(1);
  }, 400_000);

  test("rate limits pause the import, then it resumes and completes", async () => {
    const storeId = await createStore("rate limit test");
    const { id } = await startImport(storeId, messyCsv(40, 5), "ratelimit.csv");
    const worker = spawnWorker({ FAKE_AI_FAILURES: "rate_limit:0.35,invalid_json:0.1,timeout:0.05", FAKE_AI_RETRY_AFTER_MS: "1500", FAKE_AI_LATENCY_MS: "20" });
    let sawPaused = false;
    const final = await waitForImport(id, 240_000, (s) => {
      if (s.status === "paused" && s.paused_reason?.includes("Rate limited")) sawPaused = true;
    });
    worker.kill("SIGTERM");
    await worker.exited;
    expect(sawPaused).toBe(true);
    expect(final.status).toBe("completed");
    const { sql } = db();
    const outcomes = await sql<Array<{ outcome: string; n: number }>>`
      select outcome, count(*)::int as n from ai_calls where import_id = ${id} group by outcome`;
    const byOutcome = Object.fromEntries(outcomes.map((o) => [o.outcome, o.n]));
    expect(byOutcome.rate_limited ?? 0).toBeGreaterThan(0);
    expect(byOutcome.ok ?? 0).toBeGreaterThan(0);
    const counts = await rowCounts(id);
    expect((counts.done ?? 0) + (counts.needs_review ?? 0) + (counts.failed ?? 0)).toBe(final.total_rows);
  }, 300_000);
});
