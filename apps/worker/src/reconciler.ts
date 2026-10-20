import { createHash } from "node:crypto";
import {
  enqueueBuild, enqueueTranslate, getQueue, QUEUES, redisConnection, safeJobId,
  type BuildJob, type ImportJob, type ImportStage, type TranslateJob,
} from "@cf/queue";
import { wdb } from "./db";
import { BUILD_BATCH } from "./stages/group";
import { checkFinalize } from "./stages/finalize";

const STAGE_FOR_STATUS: Record<string, ImportStage> = {
  queued: "parse",
  parsing: "parse",
  cleaning: "clean",
  grouping: "group",
};

/** Re-adds a stage job unless an equivalent one is still waiting/active; finished leftovers are replaced. */
async function ensureStageJob(data: ImportJob): Promise<void> {
  const queue = getQueue<ImportJob>(QUEUES.import);
  const jobId = safeJobId(`${data.importId}:${data.stage}`);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== "completed" && state !== "failed" && state !== "unknown") return;
    await existing.remove().catch(() => undefined);
  }
  await queue.add(data.stage, data, { jobId });
}

async function productsCoveredBy<T extends { productIds: string[] }>(name: string): Promise<Set<string>> {
  const queue = getQueue<T>(name as never);
  const jobs = await queue.getJobs(["waiting", "active", "delayed", "paused", "prioritized", "waiting-children"]);
  return new Set(jobs.flatMap((j) => j?.data?.productIds ?? []));
}

const idFor = (prefix: string, ids: string[]) => `${prefix}:${createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16)}`;

/**
 * Rebuilds queue state from Postgres. Runs on boot and every 30 s, so a crash, a lost Redis or a
 * dropped job can never strand an import: whatever the DB says is unfinished is scheduled again.
 */
export async function reconcile(): Promise<{ imports: number; builds: number; translations: number }> {
  const redis = redisConnection();
  const lock = await redis.set("cf:reconcile:lock", String(process.pid), "PX", 25_000, "NX");
  if (!lock) return { imports: 0, builds: 0, translations: 0 };
  const { sql } = wdb();
  let builds = 0;
  let translationJobs = 0;

  // Lift expired pauses so the UI does not keep showing "Paused".
  await sql`update imports set status = case when stage = 'translate' then 'translating' else 'building' end,
    paused_until = null, paused_reason = null, updated_at = now()
    where status = 'paused' and paused_until < now()`;

  const open = await sql<Array<{ id: string; store_id: string; status: string }>>`
    select id, store_id, status from imports where status not in ('completed', 'failed') order by created_at`;
  const buildCovered = await productsCoveredBy<BuildJob>(QUEUES.build);
  const translateCovered = await productsCoveredBy<TranslateJob>(QUEUES.translate);

  for (const imp of open) {
    const stage = STAGE_FOR_STATUS[imp.status];
    if (stage) {
      await ensureStageJob({ importId: imp.id, storeId: imp.store_id, stage });
      continue;
    }
    const stuck = (await sql<Array<{ id: string }>>`
      select id from products where last_import_id = ${imp.id} and status = 'processing' order by id`)
      .map((r) => r.id)
      .filter((id) => !buildCovered.has(id));
    for (let i = 0; i < stuck.length; i += BUILD_BATCH) {
      const ids = stuck.slice(i, i + BUILD_BATCH);
      await enqueueBuild({ importId: imp.id, storeId: imp.store_id, productIds: ids, kind: "build" }, idFor(`build:${imp.id}:resume`, ids));
      builds++;
    }
    // Rows still "grouped" whose product is not processing (crash between steps) get re-resolved by a rebuild.
    const orphanRows = (await sql<Array<{ product_id: string }>>`
      select distinct r.product_id from import_rows r join products p on p.id = r.product_id
      where r.import_id = ${imp.id} and r.status = 'grouped' and p.status <> 'processing'`)
      .map((r) => r.product_id)
      .filter((id) => !buildCovered.has(id) && !stuck.includes(id));
    if (orphanRows.length) {
      await sql`update products set status = 'processing', built_input_hash = null where id in ${sql(orphanRows)}`;
      for (let i = 0; i < orphanRows.length; i += BUILD_BATCH) {
        const ids = orphanRows.slice(i, i + BUILD_BATCH);
        await enqueueBuild({ importId: imp.id, storeId: imp.store_id, productIds: ids, kind: "build" }, idFor(`build:${imp.id}:regroup`, ids));
        builds++;
      }
    }
    const pendingTr = (await sql<Array<{ product_id: string }>>`
      select distinct t.product_id from translations t join products p on p.id = t.product_id
      where p.last_import_id = ${imp.id} and t.state = 'pending' and p.status <> 'processing'`)
      .map((r) => r.product_id)
      .filter((id) => !translateCovered.has(id));
    for (let i = 0; i < pendingTr.length; i += 20) {
      const ids = pendingTr.slice(i, i + 20);
      await enqueueTranslate({ storeId: imp.store_id, importId: imp.id, productIds: ids }, idFor(`translate:${imp.id}:resume`, ids));
      translationJobs++;
    }
    await checkFinalize(imp.id);
  }

  // Edits outside imports (manual English edits, re-runs) leave pending translations too.
  const loose = await sql<Array<{ product_id: string; store_id: string }>>`
    select distinct t.product_id, t.store_id from translations t join products p on p.id = t.product_id
    where t.state = 'pending' and p.status <> 'processing'
      and (p.last_import_id is null or p.last_import_id in (select id from imports where status in ('completed','failed')))
    limit 500`;
  const byStore = new Map<string, string[]>();
  for (const r of loose) if (!translateCovered.has(r.product_id)) byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r.product_id]);
  for (const [storeId, ids] of byStore) {
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      await enqueueTranslate({ storeId, importId: null, productIds: chunk }, idFor("translate:loose", chunk));
      translationJobs++;
    }
  }
  return { imports: open.length, builds, translations: translationJobs };
}
