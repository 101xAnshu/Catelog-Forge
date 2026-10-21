import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import Papa from "papaparse";
import sharp from "sharp";
import * as XLSX from "xlsx";
import yauzl from "yauzl";
import { decodeText, detectHeaders, type HeaderMap } from "@cf/core";
import { enqueueImportStage } from "@cf/queue";
import { wdb } from "../db";
import { failImport, refreshCounts, setImportStatus } from "../progress";
import { readObject, writeObject } from "../storage";

export const LIMITS = {
  maxRows: 10_000,
  maxPhotos: 2_000,
  maxPhotoBytes: 20 * 1024 * 1024,
  maxZipUncompressedBytes: 1024 * 1024 * 1024,
  chunkSize: 1000,
};

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export class ImportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Reads CSV/XLSX into a grid of display strings (SheetJS raw:false keeps SKUs like 00123 and 1.23E+11 intact). */
export function readSheet(buf: Buffer, filename: string): string[][] {
  const ext = extname(filename).toLowerCase();
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (ext === ".xlsx" || ext === ".xls" || isZip) {
    if (!isZip && ext === ".xlsx") throw new ImportError("PARSE_ERROR", "File is not a valid XLSX workbook");
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(buf, { type: "buffer", cellDates: false });
    } catch (e) {
      throw new ImportError("PARSE_ERROR", `Could not read workbook: ${(e as Error).message}`);
    }
    const first = wb.SheetNames[0];
    const ws = first ? wb.Sheets[first] : undefined;
    if (!ws) throw new ImportError("EMPTY_SHEET", "Workbook has no sheets");
    return XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "", blankrows: false });
  }
  const { text } = decodeText(buf);
  if (text.includes("\u0000")) throw new ImportError("UNSUPPORTED_FILE_TYPE", "File looks binary, not a CSV");
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false, delimitersToGuess: [",", ";", "\t", "|"] });
  return parsed.data.map((r) => r.map((c) => (c ?? "").toString()));
}

const isBlank = (r: string[]) => r.every((c) => !c || !String(c).trim());

/** Stable key per column for the stored row; duplicate headers get `_2`, `_3` (M26). */
export function rawKeys(header: HeaderMap): string[] {
  const keys: string[] = [];
  for (const col of header.columns) {
    let key = col.header || `Column ${col.index + 1}`;
    for (let n = 2; keys.includes(key); n++) key = `${col.header || `Column ${col.index + 1}`}_${n}`;
    keys.push(key);
  }
  return keys;
}

/** Header-keyed copy of the row for the review screen. */
function rawRecord(cells: string[], header: HeaderMap, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  header.columns.forEach((col, i) => {
    out[keys[i]!] = cells[col.index] ?? "";
  });
  return out;
}

export async function runParse(importId: string): Promise<void> {
  const { sql } = wdb();
  const [imp] = await sql<Array<{ id: string; store_id: string; filename: string; sheet_key: string; photos_key: string | null; photo_keys: string[]; status: string; settings: Record<string, unknown> }>>`
    select id, store_id, filename, sheet_key, photos_key, photo_keys, status, settings from imports where id = ${importId}`;
  if (!imp || imp.status === "completed" || imp.status === "failed") return;
  await setImportStatus(importId, "parsing", { stage: "parse" });

  let grid: string[][];
  try {
    grid = readSheet(await readObject(imp.sheet_key), imp.filename);
  } catch (e) {
    const err = e instanceof ImportError ? e : new ImportError("PARSE_ERROR", (e as Error).message);
    await failImport(importId, err.code, err.message);
    return;
  }
  const header = detectHeaders(grid.slice(0, 50));
  const body = grid
    .map((cells, i) => ({ cells, rowNumber: i + 1 }))
    .slice(header.headerRowIndex + 1)
    .filter((r) => !isBlank(r.cells));
  if (body.length === 0) {
    await failImport(importId, "EMPTY_SHEET", "The sheet has a header but no product rows");
    return;
  }
  if (body.length > LIMITS.maxRows) {
    await failImport(importId, "TOO_MANY_ROWS", `The sheet has ${body.length.toLocaleString("en")} rows; the limit is ${LIMITS.maxRows.toLocaleString("en")}`);
    return;
  }

  await sql`update imports set total_rows = ${body.length}, settings = settings || ${JSON.stringify({ headerMap: header })}::jsonb where id = ${importId}`;
  const keys = rawKeys(header);
  for (let i = 0; i < body.length; i += LIMITS.chunkSize) {
    const chunk = body.slice(i, i + LIMITS.chunkSize).map((r) => ({
      import_id: importId,
      store_id: imp.store_id,
      row_number: r.rowNumber,
      raw: JSON.stringify(rawRecord(r.cells, header, keys)),
    }));
    await sql`insert into import_rows ${sql(chunk, "import_id", "store_id", "row_number", "raw")} on conflict (import_id, row_number) do nothing`;
  }

  await ingestPhotos(importId, imp.store_id, imp.photos_key, imp.photo_keys ?? []);
  await refreshCounts(importId);
  await setImportStatus(importId, "cleaning", { stage: "clean" });
  await enqueueImportStage({ importId, storeId: imp.store_id, stage: "clean" });
}

interface PhotoFile { name: string; data: Buffer }

async function ingestPhotos(importId: string, storeId: string, zipKey: string | null, looseKeys: string[]): Promise<void> {
  let count = 0;
  const handle = async (file: PhotoFile) => {
    if (++count > LIMITS.maxPhotos) return;
    await storePhoto(importId, storeId, file);
  };
  for (const key of looseKeys) {
    const data = await readObject(key).catch(() => null);
    if (data) await handle({ name: basename(key).replace(/^[0-9a-f]{8,}[-_]/, ""), data });
  }
  if (zipKey) {
    const zip = await readObject(zipKey).catch(() => null);
    if (zip) await readZip(zip, handle);
  }
}

function readZip(buf: Buffer, onFile: (f: PhotoFile) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(new ImportError("PHOTOS_ZIP_INVALID", `Photo ZIP could not be opened: ${err?.message ?? "unknown"}`));
      let total = 0;
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = basename(entry.fileName);
        const skip =
          entry.fileName.endsWith("/") || entry.fileName.includes("__MACOSX") || name.startsWith(".") ||
          !IMAGE_EXT.has(extname(name).toLowerCase());
        total += entry.uncompressedSize;
        if (skip || entry.uncompressedSize > LIMITS.maxPhotoBytes || total > LIMITS.maxZipUncompressedBytes) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return zip.readEntry();
          const parts: Buffer[] = [];
          let size = 0;
          stream.on("data", (d: Buffer) => {
            size += d.length;
            if (size > LIMITS.maxPhotoBytes) stream.destroy(); // guards against lying size headers (zip bombs)
            else parts.push(d);
          });
          stream.on("close", () => {
            const data = Buffer.concat(parts);
            const done = size > LIMITS.maxPhotoBytes ? Promise.resolve() : onFile({ name, data });
            done.then(() => zip.readEntry(), reject);
          });
          stream.on("error", () => zip.readEntry());
        });
      });
      zip.readEntry();
    });
  });
}

async function storePhoto(importId: string, storeId: string, file: PhotoFile): Promise<void> {
  const { sql } = wdb();
  const sha = createHash("sha256").update(file.data).digest("hex");
  const ext = extname(file.name).toLowerCase() || ".jpg";
  let status: "ok" | "invalid" = "ok";
  let reason: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let thumbKey: string | null = null;
  const storageKey = `photos/${sha}${ext}`;
  try {
    const meta = await sharp(file.data).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    thumbKey = `thumbs/${sha}.webp`;
    const thumb = await sharp(file.data).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    await writeObject(storageKey, file.data);
    await writeObject(thumbKey, thumb);
  } catch (e) {
    status = "invalid";
    reason = `Not a readable image: ${(e as Error).message.slice(0, 120)}`;
    thumbKey = null;
  }
  await sql`
    insert into assets (store_id, import_id, filename, sha256, storage_key, thumb_key, width, height, status, reason)
    values (${storeId}, ${importId}, ${file.name}, ${sha}, ${storageKey}, ${thumbKey}, ${width}, ${height}, ${status}, ${reason})
    on conflict (import_id, filename) do nothing`;
}
