import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";

/** One queue per stage keeps concurrency and rate limits tunable per stage. */
export const QUEUES = {
  import: "cf-import", // parse → clean → group (one job per stage per import)
  build: "cf-build", // AI product build, batches of products
  translate: "cf-translate", // AI translation, batches of fields
  webhook: "cf-webhook", // outbox delivery
} as const;

export type ImportStage = "parse" | "clean" | "group" | "finalize";

export interface ImportJob { importId: string; storeId: string; stage: ImportStage }
export interface BuildJob {
  importId: string | null; // null for re-runs started from the dashboard
  storeId: string;
  productIds: string[];
  kind: "build" | "rerun";
  overrides?: { tier?: "cheap" | "strong" | "vision"; promptVersion?: string; temperature?: number; overwriteManual?: boolean };
}
export interface TranslateJob { storeId: string; importId: string | null; productIds: string[] }
export interface WebhookJob { eventId: string }

export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 24 * 3600 },
};

/** Redis channel for real-time progress; payload is `ProgressEvent` JSON. */
export const progressChannel = (storeId: string) => `cf:progress:${storeId}`;
export interface ProgressEvent { type: "import" | "product"; importId?: string; productId?: string; status?: string }

const g = globalThis as unknown as { __cfRedis?: Redis; __cfQueues?: Map<string, Queue> };

export function redisConnection(): Redis {
  g.__cfRedis ??= new IORedis(process.env.REDIS_URL ?? "redis://localhost:6380", { maxRetriesPerRequest: null });
  return g.__cfRedis;
}

export function getQueue<T>(name: (typeof QUEUES)[keyof typeof QUEUES]): Queue<T> {
  g.__cfQueues ??= new Map();
  let q = g.__cfQueues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection(), defaultJobOptions: DEFAULT_JOB_OPTS });
    g.__cfQueues.set(name, q);
  }
  return q as Queue<T>;
}

/** BullMQ rejects ":" in custom ids; every id passes through here so callers can use readable `a:b:c` ids. */
export const safeJobId = (id: string): string => id.replaceAll(":", "_");

/** Deterministic job ids make double-enqueue (retries, reconciler, double clicks) a no-op. */
export async function enqueueImportStage(job: ImportJob): Promise<void> {
  await getQueue<ImportJob>(QUEUES.import).add(job.stage, job, { jobId: safeJobId(`${job.importId}:${job.stage}`) });
}

export async function enqueueBuild(job: BuildJob, jobId: string): Promise<void> {
  await getQueue<BuildJob>(QUEUES.build).add(job.kind, job, { jobId: safeJobId(jobId) });
}

export async function enqueueTranslate(job: TranslateJob, jobId: string): Promise<void> {
  await getQueue<TranslateJob>(QUEUES.translate).add("translate", job, { jobId: safeJobId(jobId) });
}

export async function enqueueWebhook(eventId: string): Promise<void> {
  await getQueue<WebhookJob>(QUEUES.webhook).add("deliver", { eventId }, { jobId: safeJobId(`webhook:${eventId}`), attempts: 8, backoff: { type: "exponential", delay: 5000 } });
}

export async function publishProgress(storeId: string, event: ProgressEvent): Promise<void> {
  await redisConnection().publish(progressChannel(storeId), JSON.stringify(event));
}

/** Re-exported so apps share one bullmq instance/version. */
export { Worker, Job } from "bullmq";
