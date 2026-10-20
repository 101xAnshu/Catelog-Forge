import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { aiCallCount, createStore, db, duplicateCheck, messyCsv, rowCounts, startImport, waitForImport } from "./helpers";

const { startWorkers } = await import("../../apps/worker/src/workers");
let running: Awaited<ReturnType<typeof startWorkers>>;

beforeAll(async () => {
  running = await startWorkers({ log: false, reconcileEveryMs: 2000 });
});
afterAll(async () => {
  await running.stop();
});

describe("import pipeline (fake AI)", () => {
  test("messy sheet: every row terminal, counts add up, no duplicate SKUs or handles", async () => {
    const storeId = await createStore();
    const csv = messyCsv(60);
    const { id } = await startImport(storeId, csv, "messy.csv");
    const final = await waitForImport(id);
    expect(final.status).toBe("completed");
    const counts = await rowCounts(id);
    expect(counts.pending ?? 0).toBe(0);
    expect(counts.grouped ?? 0).toBe(0);
    expect((counts.done ?? 0) + (counts.needs_review ?? 0) + (counts.failed ?? 0)).toBe(final.total_rows);
    const dup = await duplicateCheck(storeId);
    expect(dup.dupSkus).toBe(0);
    expect(dup.dupHandles).toBe(0);
    expect(dup.products).toBeGreaterThan(40);
    expect(dup.products).toBeLessThanOrEqual(60);

    const { sql } = db();
    // unsafe HTML never survives into stored descriptions
    const [scripts] = await sql<Array<{ n: number }>>`select count(*)::int as n from product_fields where store_id = ${storeId} and value ilike '%<script%'`;
    expect(scripts!.n).toBe(0);
    // translations were produced ahead of time for DE and FR
    const [tr] = await sql<Array<{ n: number }>>`select count(*)::int as n from translations where store_id = ${storeId} and state = 'fresh'`;
    expect(tr!.n).toBeGreaterThan(0);
    // completion event written to the outbox exactly once
    const [ev] = await sql<Array<{ n: number }>>`select count(*)::int as n from events where import_id = ${id}`;
    expect(ev!.n).toBe(1);
  }, 120_000);

  test("re-uploading the same file returns the same import and costs nothing", async () => {
    const storeId = await createStore();
    const csv = messyCsv(20, 7);
    const first = await startImport(storeId, csv, "same.csv");
    await waitForImport(first.id);
    const calls = await aiCallCount(first.id);
    const again = await startImport(storeId, csv, "same.csv");
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(await aiCallCount(first.id)).toBe(calls);
  }, 120_000);

  test("modified file: unchanged products skip the AI, changed rows update existing products", async () => {
    const storeId = await createStore();
    const csv = messyCsv(20, 3);
    const first = await startImport(storeId, csv, "v1.csv");
    await waitForImport(first.id);
    const before = await duplicateCheck(storeId);
    // one product's description changes; everything else is byte-identical
    const changed = csv.replaceAll("Classic planter number 2 with drainage hole", "Updated planter number 2 with drainage hole");
    expect(changed).not.toBe(csv);
    const second = await startImport(storeId, changed, "v2.csv");
    expect(second.created).toBe(true);
    const final = await waitForImport(second.id);
    expect(final.status).toBe("completed");
    const after = await duplicateCheck(storeId);
    expect(after.products).toBe(before.products);
    expect(after.dupSkus).toBe(0);
    const { sql } = db();
    const [built] = await sql<Array<{ n: number }>>`
      select count(distinct p)::int as n from ai_calls, jsonb_array_elements_text(product_ids) p where import_id = ${second.id} and kind = 'build' and outcome = 'ok'`;
    expect(built!.n).toBeLessThan(before.products / 2);
  }, 120_000);
});
