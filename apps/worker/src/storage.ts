import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { repoRoot } from "./env";

/** Local-disk storage. Keys are relative paths like `uploads/<sha>.csv`, `thumbs/<sha>.webp`. */
export function storageDir(): string {
  const dir = process.env.STORAGE_DIR ?? "./storage";
  return isAbsolute(dir) ? dir : join(repoRoot(), dir);
}

export function storagePath(key: string): string {
  const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  if (clean.startsWith("..") || isAbsolute(clean)) throw new Error(`Invalid storage key ${key}`);
  return join(storageDir(), clean);
}

export async function readObject(key: string): Promise<Buffer> {
  return readFile(storagePath(key));
}

export async function writeObject(key: string, data: Uint8Array | Buffer): Promise<void> {
  const path = storagePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
