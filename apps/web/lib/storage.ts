import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export function storageRoot(): string {
  return resolve(process.env.STORAGE_DIR ?? resolve(process.cwd(), "../../storage"));
}

/** Resolves a storage key to an absolute path, refusing anything outside the storage root. */
export function storagePath(key: string): string {
  const root = storageRoot();
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + sep)) throw new Error("Invalid storage key");
  return full;
}

export async function writeStream(key: string, body: ReadableStream<Uint8Array>): Promise<number> {
  const full = storagePath(key);
  await mkdir(dirname(full), { recursive: true });
  const out = createWriteStream(full);
  let bytes = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } finally {
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
  }
  return bytes;
}

export async function exists(key: string): Promise<boolean> {
  try {
    await stat(storagePath(key));
    return true;
  } catch {
    return false;
  }
}
