import { createHash, randomUUID } from "node:crypto";
import { loadRootEnv } from "../../apps/worker/src/env";

loadRootEnv();
process.env.AI_PROVIDER = "fake";
process.env.FAKE_AI_LATENCY_MS ??= "5";

const { getDb, enqueueImportStage } = await import("../../apps/worker/src/testing");
const { writeObject } = await import("../../apps/worker/src/storage");

export const db = () => getDb("script");

export async function createStore(name = "Test store"): Promise<string> {
  const { sql } = db();
  const [s] = await sql<Array<{ id: string }>>`
    insert into stores (name, slug, base_currency) values (${name}, ${`test-${randomUUID().slice(0, 8)}`}, 'EUR') returning id`;
  return s!.id;
}

/** Mirrors what the upload API does: store the file, insert the import (deduped by sha), enqueue parse. */
export async function startImport(storeId: string, data: Buffer | string, filename: string, photosZip?: Buffer): Promise<{ id: string; created: boolean }> {
  const { sql } = db();
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  const sha = createHash("sha256").update(buf).digest("hex");
  const sheetKey = `uploads/${sha}-${filename}`;
  await writeObject(sheetKey, buf);
  let photosKey: string | null = null;
  if (photosZip) {
    photosKey = `uploads/${createHash("sha256").update(photosZip).digest("hex")}-photos.zip`;
    await writeObject(photosKey, photosZip);
  }
  const inserted = await sql<Array<{ id: string }>>`
    insert into imports (store_id, file_sha256, filename, sheet_key, photos_key, settings)
    values (${storeId}, ${sha}, ${filename}, ${sheetKey}, ${photosKey}, ${JSON.stringify({ routing: "auto", useBatch: false, promptVersion: "v1" })}::jsonb)
    on conflict (store_id, file_sha256) do nothing returning id`;
  if (inserted[0]) {
    await enqueueImportStage({ importId: inserted[0].id, storeId, stage: "parse" });
    return { id: inserted[0].id, created: true };
  }
  const [existing] = await sql<Array<{ id: string }>>`select id from imports where store_id = ${storeId} and file_sha256 = ${sha}`;
  return { id: existing!.id, created: false };
}

export interface ImportState {
  status: string;
  total_rows: number;
  error: string | null;
  paused_reason: string | null;
}

export async function importState(importId: string): Promise<ImportState> {
  const { sql } = db();
  const [r] = await sql<ImportState[]>`select status, total_rows, error, paused_reason from imports where id = ${importId}`;
  return r!;
}

export async function waitForImport(importId: string, timeoutMs = 120_000, onTick?: (s: ImportState) => void): Promise<ImportState> {
  const started = Date.now();
  for (;;) {
    const s = await importState(importId);
    onTick?.(s);
    if (s.status === "completed" || s.status === "failed") return s;
    if (Date.now() - started > timeoutMs) throw new Error(`import ${importId} still ${s.status} after ${timeoutMs} ms`);
    await Bun.sleep(250);
  }
}

export async function rowCounts(importId: string): Promise<Record<string, number>> {
  const { sql } = db();
  const rows = await sql<Array<{ status: string; n: number }>>`
    select status, count(*)::int as n from import_rows where import_id = ${importId} group by status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function duplicateCheck(storeId: string): Promise<{ dupSkus: number; dupHandles: number; products: number }> {
  const { sql } = db();
  const [r] = await sql<Array<{ dup_skus: number; dup_handles: number; products: number }>>`
    select
      (select count(*) from (select sku from variants where store_id = ${storeId} and sku is not null group by sku having count(*) > 1) x)::int as dup_skus,
      (select count(*) from (select handle from products where store_id = ${storeId} group by handle having count(*) > 1) y)::int as dup_handles,
      (select count(*) from products where store_id = ${storeId})::int as products`;
  return { dupSkus: r!.dup_skus, dupHandles: r!.dup_handles, products: r!.products };
}

export async function aiCallCount(importId: string): Promise<number> {
  const { sql } = db();
  const [r] = await sql<Array<{ n: number }>>`select count(*)::int as n from ai_calls where import_id = ${importId}`;
  return r!.n;
}

/** A deliberately messy supplier sheet: split/duplicated/conflicting rows, mixed prices/units, HTML, German text. */
export function messyCsv(products = 60, seed = 1): string {
  const header = "SKU;Product Name;Brand;Description;Preis;Size;Colour;Weight;Notes";
  const lines = [header];
  const colors = ["terracota", "Natur", "schwarz", "white", "antracite"];
  const prices = (n: number) => [`${n},99 €`, `€${n}.50`, `${n}.5`, `£${n}`, `EUR ${n}`, `1.${String(n).padStart(3, "0")},00 €`][n % 6];
  for (let i = 1; i <= products; i++) {
    const base = `TP-${String(i).padStart(4, "0")}`;
    const name = productName(i);
    const desc = i % 5 === 0 ? `<p>Hand-thrown pot<script>alert(1)</script> with drainage hole</p>` : `Classic planter number ${i} with drainage hole`;
    const notes = i % 3 === 0 ? "frost-resistant (not frost-proof, bring indoors below 0 °C)" : i % 7 === 0 ? "Handgefertigt aus Ton, nicht frostfest" : "";
    for (const [vi, size] of ["20 cm", "12 in", "30cm"].entries()) {
      if (i % 4 === 0 && vi === 2) continue;
      const price = i % 11 === 0 && vi === 1 ? "" : prices(i + vi);
      const weight = vi === 1 ? `${2 + vi} lbs` : `${1.5 + vi} kg`;
      lines.push([`${base}-${vi + 1}`, name, "Verdant", desc, price, size, colors[i % colors.length], weight, notes].map(csvCell).join(";"));
    }
    if (i % 6 === 0) lines.push(lines[lines.length - 1]!); // exact duplicate row
    if (i % 13 === 0) lines.push([`${base}-1`, name, "Verdant", desc, "99,00 €", "20 cm", colors[i % colors.length], "1.5 kg", notes].map(csvCell).join(";")); // conflicting price
  }
  // shuffle rows deterministically so variants are out of order
  const body = lines.slice(1);
  let s = seed;
  for (let i = body.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [body[i], body[j]] = [body[j]!, body[i]!];
  }
  return [header, ...body].join("\n");
}

const ADJ = ["Rustic", "Glazed", "Hanging", "Tall", "Ribbed", "Speckled", "Matte", "Footed", "Wide", "Classic", "Fluted", "Low"];
const NOUN = ["Terracotta Planter", "Herb Pot", "Orchid Pot", "Cache-Pot", "Bonsai Bowl", "Balcony Trough", "Seed Tray", "Pflanztopf", "Vase", "Lantern"];
const SERIES = ["Aurora", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Isla", "Juniper"];

/** Distinct, realistic product names (no two products differ only by a number). */
export function productName(i: number): string {
  return `${SERIES[Math.floor(i / 120) % SERIES.length]} ${ADJ[i % ADJ.length]} ${NOUN[Math.floor(i / ADJ.length) % NOUN.length]}`;
}

function csvCell(v: string): string {
  return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
