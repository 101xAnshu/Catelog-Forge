import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { storagePath } from "@/lib/storage";

export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
};

/** Serves stored photos/thumbnails. Only image types; keys are confined to STORAGE_DIR. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const rel = key.map(decodeURIComponent).join("/");
  const type = TYPES[extname(rel).toLowerCase()];
  if (!type || rel.includes("..")) return new Response("Not found", { status: 404 });
  let full: string;
  try {
    full = storagePath(rel);
    const s = await stat(full);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    const body = Readable.toWeb(createReadStream(full)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "content-type": type,
        "content-length": String(s.size),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
