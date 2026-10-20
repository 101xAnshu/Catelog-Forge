import { and, eq, inArray } from "@cf/db/orm";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { imports, type ImportSettings } from "@cf/db";
import { enqueueImportStage } from "@cf/queue";
import { web } from "./db";
import { HttpError } from "./http";
import { storagePath } from "./storage";

export const LIMITS = {
  sheetBytes: 25 * 1024 * 1024,
  zipBytes: 500 * 1024 * 1024,
  imageBytes: 20 * 1024 * 1024,
  images: 2000,
  requestBytes: 600 * 1024 * 1024,
};

const SHEET_EXT = new Set([".csv", ".tsv", ".txt", ".xlsx"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function startsWith(head: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => head[i] === b);
}

/** Checks extension AND magic bytes, so a renamed PDF or binary never reaches the parser (EDGE M1). */
function sniff(kind: "sheet" | "zip" | "image", name: string, head: Uint8Array): void {
  const ext = extname(name).toLowerCase();
  if (kind === "sheet") {
    if (!SHEET_EXT.has(ext)) throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", `"${name}" is not a CSV or XLSX file.`);
    if (ext === ".xlsx" && !startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
      throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", `"${name}" is not a valid XLSX file (it may be renamed or corrupt).`);
    }
    if (ext !== ".xlsx") {
      if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x25, 0x50, 0x44, 0x46])) {
        throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", `"${name}" looks like a binary file, not CSV text.`);
      }
      if (head.subarray(0, 4096).includes(0)) {
        throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", `"${name}" contains binary data, not CSV text.`);
      }
    }
    return;
  }
  if (kind === "zip") {
    if (ext !== ".zip" || !startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
      throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", `"${name}" is not a ZIP archive.`);
    }
    return;
  }
  const isImage =
    startsWith(head, [0xff, 0xd8, 0xff]) ||
    startsWith(head, [0x89, 0x50, 0x4e, 0x47]) ||
    (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head.subarray(8), [0x57, 0x45, 0x42, 0x50]));
  if (!IMAGE_EXT.has(ext) || !isImage) {
    throw new HttpError(415, "UNSUPPORTED_FILE_TYPE", `"${name}" is not a JPG, PNG or WebP image.`);
  }
}

async function saveFile(file: File, key: string, kind: "sheet" | "zip" | "image"): Promise<string> {
  const limit = kind === "sheet" ? LIMITS.sheetBytes : kind === "zip" ? LIMITS.zipBytes : LIMITS.imageBytes;
  if (file.size === 0) throw new HttpError(400, "EMPTY_FILE", `"${file.name}" is empty.`);
  if (file.size > limit) {
    throw new HttpError(413, "FILE_TOO_LARGE", `"${file.name}" is ${mb(file.size)}; the limit for this file type is ${mb(limit)}.`);
  }
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  sniff(kind, file.name, head);
  const full = storagePath(key);
  await mkdir(dirname(full), { recursive: true });
  const hash = createHash("sha256");
  const out = createWriteStream(full);
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return hash.digest("hex");
}

const safeName = (name: string) => name.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";

export interface CreateImportResult {
  id: string;
  duplicate: boolean;
  status: string;
}

/**
 * Saves the upload, dedupes on sha256(sheet + photos) per store, and queues parsing.
 * Returns immediately; all work happens in the worker (EDGE S1, S4).
 */
export async function createImportFromForm(
  storeId: string,
  form: FormData,
  source: "dashboard" | "api",
): Promise<CreateImportResult> {
  const sheet = form.get("sheet");
  if (!(sheet instanceof File)) throw new HttpError(400, "SHEET_REQUIRED", "Attach a CSV or XLSX sheet in the `sheet` field.");
  const photos = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  const zips = photos.filter((f) => extname(f.name).toLowerCase() === ".zip");
  const images = photos.filter((f) => extname(f.name).toLowerCase() !== ".zip");
  if (zips.length > 1) throw new HttpError(400, "TOO_MANY_ZIPS", "Upload photos as one ZIP, or as individual images.");
  if (images.length > LIMITS.images) {
    throw new HttpError(413, "TOO_MANY_PHOTOS", `${images.length} photos uploaded; the limit is ${LIMITS.images}.`);
  }

  const settings: ImportSettings = {
    routing: (["auto", "cheap", "strong"] as const).find((r) => r === form.get("routing")) ?? "auto",
    promptVersion: (["v1", "v2"] as const).find((v) => v === form.get("promptVersion")) ?? "v1",
    useBatch: form.get("useBatch") === "true" || form.get("useBatch") === "on",
  };

  const uploadDir = `${storeId}/uploads/${randomUUID()}`;
  try {
    const sheetExt = extname(sheet.name).toLowerCase() || ".csv";
    const sheetKey = `${uploadDir}/sheet${sheetExt}`;
    const sheetSha = await saveFile(sheet, sheetKey, "sheet");
    const parts = [sheetSha];
    let photosKey: string | null = null;
    if (zips[0]) {
      photosKey = `${uploadDir}/photos.zip`;
      parts.push(await saveFile(zips[0], photosKey, "zip"));
    }
    const photoKeys: string[] = [];
    for (const img of images) {
      const key = `${uploadDir}/photos/${safeName(img.name)}`;
      parts.push(await saveFile(img, key, "image"));
      photoKeys.push(key);
    }
    const fileSha256 = createHash("sha256").update(parts.sort().join(":")).digest("hex");

    const db = web().db;
    const insert = () =>
      db
        .insert(imports)
        .values({
          storeId,
          fileSha256,
          filename: sheet.name.slice(0, 200),
          sheetKey,
          photosKey,
          photoKeys,
          settings,
          source,
          counts: { total: 0, pending: 0, done: 0, needs_review: 0, failed: 0, products: 0, orphan_photos: 0 },
        })
        .onConflictDoNothing({ target: [imports.storeId, imports.fileSha256] })
        .returning({ id: imports.id, status: imports.status });

    let [created] = await insert();
    if (!created) {
      const [existing] = await db
        .select({ id: imports.id, status: imports.status })
        .from(imports)
        .where(and(eq(imports.storeId, storeId), eq(imports.fileSha256, fileSha256)))
        .limit(1);
      // A cancelled or failed import must not block uploading the same file again: it keeps its history
      // under a superseded hash and the new upload runs (products still upsert, so nothing is duplicated).
      if (existing && (existing.status === "cancelled" || existing.status === "failed")) {
        await db
          .update(imports)
          .set({ fileSha256: `${fileSha256}:superseded:${existing.id}` })
          .where(and(eq(imports.id, existing.id), inArray(imports.status, ["cancelled", "failed"])));
        [created] = await insert();
      }
      if (!created) {
        await rm(storagePath(uploadDir), { recursive: true, force: true });
        if (!existing) throw new HttpError(409, "DUPLICATE_RACE", "This file is being imported; refresh in a moment.");
        return { id: existing.id, duplicate: true, status: existing.status };
      }
    }
    await enqueueImportStage({ importId: created.id, storeId, stage: "parse" });
    return { id: created.id, duplicate: false, status: created.status };
  } catch (err) {
    await rm(storagePath(uploadDir), { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export function assertRequestSize(req: Request): void {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > LIMITS.requestBytes) {
    throw new HttpError(413, "FILE_TOO_LARGE", `Upload is ${mb(len)}; the total limit is ${mb(LIMITS.requestBytes)}.`);
  }
}
