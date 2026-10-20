import { Job, QUEUES, Worker, redisConnection, type BuildJob, type ImportJob, type TranslateJob, type WebhookJob } from "@cf/queue";
import { wdb } from "./db";
import { failImport } from "./progress";
import { reconcile } from "./reconciler";
import { runBuild } from "./stages/build";
import { runClean } from "./stages/clean";
import { checkFinalize } from "./stages/finalize";
import { runGroup } from "./stages/group";
import { runParse } from "./stages/parse";
import { runTranslate } from "./stages/translate";
import { runWebhook } from "./webhook";

export interface RunningWorkers {
  stop: () => Promise<void>;
}

const concurrency = (name: string, fallback: number) => Number(process.env[`WORKER_${name}_CONCURRENCY`] ?? fallback);

export async function startWorkers(opts: { reconcileEveryMs?: number; log?: boolean } = {}): Promise<RunningWorkers> {
  const connection = redisConnection();
  const log = opts.log ?? true;
  const common = { connection, autorun: true, stalledInterval: 15_000, maxStalledCount: 3, lockDuration: 120_000 };

  const importWorker = new Worker<ImportJob>(
    QUEUES.import,
    async (job: Job<ImportJob>) => {
      try {
        if (job.data.stage === "parse") await runParse(job.data.importId);
        else if (job.data.stage === "clean") await runClean(job.data.importId);
        else if (job.data.stage === "group") await runGroup(job.data.importId);
        else await checkFinalize(job.data.importId);
      } catch (err) {
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          await failImport(job.data.importId, "STAGE_FAILED", `${job.data.stage} failed: ${(err as Error).message}`);
          return;
        }
        throw err;
      }
    },
    { ...common, concurrency: concurrency("IMPORT", 2) },
  );

  // A limiter is required for manual rate limiting (worker.rateLimit) to pause the whole queue.
  const limiter = { max: 10_000, duration: 1000 };
  const buildWorker: Worker<BuildJob> = new Worker<BuildJob>(QUEUES.build, (job) => runBuild(job, buildWorker), {
    ...common, concurrency: concurrency("BUILD", 4), limiter,
  });
  const translateWorker: Worker<TranslateJob> = new Worker<TranslateJob>(QUEUES.translate, (job) => runTranslate(job, translateWorker), {
    ...common, concurrency: concurrency("TRANSLATE", 2), limiter,
  });
  const webhookWorker = new Worker<WebhookJob>(QUEUES.webhook, runWebhook, { ...common, concurrency: 2 });

  const all = [importWorker, buildWorker, translateWorker, webhookWorker];
  for (const w of all) {
    w.on("failed", (job, err) => {
      if (log && err.message !== "bullmq:rateLimitExceeded") console.warn(`[${w.name}] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
    });
    w.on("error", (err) => log && console.error(`[${w.name}] ${err.message}`));
  }

  const runReconcile = async () => {
    try {
      const r = await reconcile();
      if (log && (r.builds || r.translations)) console.info(`reconciler: ${r.imports} open imports, re-queued ${r.builds} build and ${r.translations} translate jobs`);
    } catch (err) {
      if (log) console.error(`reconciler failed: ${(err as Error).message}`);
    }
  };
  await runReconcile();
  const timer = setInterval(runReconcile, opts.reconcileEveryMs ?? 30_000);

  return {
    stop: async () => {
      clearInterval(timer);
      await Promise.all(all.map((w) => w.close()));
    },
  };
}

export async function shutdownConnections(): Promise<void> {
  await redisConnection().quit().catch(() => undefined);
  await wdb().close();
}
