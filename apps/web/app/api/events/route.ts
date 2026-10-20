import { progressChannel, redisConnection } from "@cf/queue";
import { getStoreContext } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-Sent Events: relays worker progress published on Redis for the current store. */
export async function GET(req: Request) {
  const ctx = await getStoreContext();
  if (!ctx) return errorResponse(401, "UNAUTHORIZED", "Sign in first.");
  const channel = progressChannel(ctx.storeId);
  const sub = redisConnection().duplicate({ lazyConnect: true });
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        sub.disconnect();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const heartbeat = setInterval(() => send(`: ping\n\n`), 15000);
      req.signal.addEventListener("abort", cleanup);
      sub.on("message", (_ch: string, message: string) => send(`data: ${message}\n\n`));
      sub.on("error", () => cleanup());
      try {
        await sub.connect();
        await sub.subscribe(channel);
        send(`retry: 3000\ndata: ${JSON.stringify({ type: "hello" })}\n\n`);
      } catch {
        cleanup();
      }
    },
    cancel() {
      closed = true;
      sub.disconnect();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
