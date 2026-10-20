import { createHmac } from "node:crypto";
import type { WebhookJob } from "@cf/queue";
import type { Job } from "@cf/queue";
import { wdb } from "./db";

/** Delivers an outbox event to the store's webhook with an HMAC-SHA256 signature. */
export async function runWebhook(job: Job<WebhookJob>): Promise<void> {
  const { sql } = wdb();
  const [ev] = await sql<Array<{ id: string; type: string; payload: Record<string, unknown>; created_at: Date; webhook_url: string | null; webhook_secret: string; webhook_status: string }>>`
    select e.id, e.type, e.payload, e.created_at, e.webhook_status, s.webhook_url, s.webhook_secret
    from events e join stores s on s.id = e.store_id where e.id = ${job.data.eventId}`;
  if (!ev || ev.webhook_status === "delivered") return;
  if (!ev.webhook_url) {
    await sql`update events set webhook_status = 'skipped' where id = ${ev.id}`;
    return;
  }
  const body = JSON.stringify({ id: ev.id, type: ev.type, created_at: ev.created_at, data: ev.payload });
  const signature = createHmac("sha256", ev.webhook_secret).update(body).digest("hex");
  const attempt = job.attemptsMade + 1;
  try {
    const res = await fetch(ev.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-catalogforge-signature": `sha256=${signature}`, "x-catalogforge-event": ev.type },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
    await sql`update events set webhook_status = 'delivered', webhook_attempts = ${attempt}, delivered_at = now(), webhook_last_error = null where id = ${ev.id}`;
  } catch (err) {
    const final = attempt >= (job.opts.attempts ?? 1);
    await sql`update events set webhook_status = ${final ? "failed" : "pending"}, webhook_attempts = ${attempt},
      webhook_last_error = ${(err as Error).message.slice(0, 500)} where id = ${ev.id}`;
    throw err;
  }
}
