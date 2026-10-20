import { computeInputHash, groupRows, matchPhotos, slugify, type CleanedRow, type ProductGroup } from "@cf/core";
import { enqueueBuild } from "@cf/queue";
import type { DbHandle } from "@cf/db";
import { wdb } from "../db";
import { refreshCounts, setImportStatus } from "../progress";
import { checkFinalize } from "./finalize";

/** Products per AI request: small enough that the JSON answer fits comfortably in the output budget. */
export const BUILD_BATCH = 5;

interface ExistingProduct {
  id: string;
  handle: string;
  status: string;
  built_input_hash: string | null;
  deleted_at: Date | null;
}

async function uniqueHandle(sql: DbHandle["sql"], storeId: string, base: string, productId?: string): Promise<string> {
  const taken = new Set(
    (await sql<Array<{ handle: string }>>`
      select handle from products where store_id = ${storeId} and (handle = ${base} or handle like ${`${base}-%`})
        and (${productId ?? null}::uuid is null or id <> ${productId ?? null}::uuid)`).map((r) => r.handle),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function runGroup(importId: string): Promise<void> {
  const { sql } = wdb();
  const [imp] = await sql<Array<{ store_id: string; status: string; base_currency: string }>>`
    select i.store_id, i.status, s.base_currency from imports i join stores s on s.id = i.store_id where i.id = ${importId}`;
  if (!imp || imp.status === "completed" || imp.status === "failed") return;
  const storeId = imp.store_id;
  await setImportStatus(importId, "grouping", { stage: "group" });

  const rows = await sql<Array<{ id: string; row_number: number; cleaned: CleanedRow }>>`
    select id, row_number, cleaned from import_rows
    where import_id = ${importId} and cleaned is not null and status <> 'failed'
    order by row_number`;
  const rowIdByNumber = new Map(rows.map((r) => [r.row_number, r.id]));
  const groups = groupRows(rows.map((r) => r.cleaned), { defaultCurrency: imp.base_currency });

  const assets = await sql<Array<{ id: string; filename: string; sha256: string }>>`
    select id, filename, sha256 from assets where import_id = ${importId} and status <> 'invalid'`;
  const matches = matchPhotos(assets, groups);
  const shaById = new Map(assets.map((a) => [a.id, a.sha256]));
  const photosByKey = new Map<string, string[]>();
  for (const m of matches) {
    if (!m.productKey) continue;
    const list = photosByKey.get(m.productKey) ?? [];
    list.push(m.assetId);
    photosByKey.set(m.productKey, list);
  }

  const toBuild: string[] = [];
  let skippedUnchanged = 0;
  const grouped = new Set<number>();
  for (const group of groups) {
    const assetIds = photosByKey.get(group.productKey) ?? [];
    const inputHash = computeInputHash(group, assetIds.map((id) => shaById.get(id) ?? id).sort());
    const snapshot: ProductGroup = { ...group, inputHash, photoKeys: assetIds };
    const rowNumbers = group.rows.map((r) => r.rowNumber);
    rowNumbers.forEach((n) => grouped.add(n));
    const rowIds = rowNumbers.map((n) => rowIdByNumber.get(n)).filter((id): id is string => !!id);

    await sql.begin(async (tx) => {
      const [existing] = await tx<ExistingProduct[]>`
        select id, handle, status, built_input_hash, deleted_at from products
        where store_id = ${storeId} and product_key = ${group.productKey} for update`;

      if (existing?.deleted_at) {
        // L4: a deleted product is never silently resurrected by a re-import.
        await tx`update import_rows set status = 'needs_review', product_id = ${existing.id}, group_key = ${group.productKey},
          reason = 'Product was deleted by the merchant but is present in this import', updated_at = now()
          where id in ${tx(rowIds)}`;
        return;
      }

      let productId: string;
      const unchanged = existing && existing.built_input_hash === inputHash && existing.status !== "failed";
      if (existing) {
        productId = existing.id;
        await tx`update products set "group" = ${JSON.stringify(snapshot)}::jsonb, source_input_hash = ${inputHash},
          last_import_id = ${importId}, status = ${unchanged ? existing.status : "processing"},
          version = version + 1, updated_at = now()
          where id = ${productId}`;
      } else {
        const name = group.rows.find((r) => r.name)?.name ?? group.variants[0]?.sku ?? group.productKey;
        const handle = await uniqueHandle(tx as unknown as DbHandle["sql"], storeId, slugify(name));
        const [created] = await tx<Array<{ id: string }>>`
          insert into products (store_id, product_key, handle, status, "group", source_input_hash, last_import_id, title)
          values (${storeId}, ${group.productKey}, ${handle}, 'processing', ${JSON.stringify(snapshot)}::jsonb, ${inputHash}, ${importId}, ${name})
          on conflict (store_id, product_key) do update set last_import_id = excluded.last_import_id
          returning id`;
        productId = created!.id;
      }

      await writeVariants(tx as unknown as DbHandle["sql"], storeId, productId, group);
      if (assetIds.length) {
        await tx`update assets set product_id = ${productId}, product_key = ${group.productKey},
          match_method = m.method from (values ${tx(matches.filter((m) => m.productKey === group.productKey).map((m) => [m.assetId, m.method ?? "name"]) as never)}) as m(id, method)
          where assets.id = m.id::uuid`;
      }

      if (unchanged) {
        skippedUnchanged++;
        // Same input as the last successful build: no AI call, rows inherit the product's state.
        const rowStatus = existing!.status === "needs_review" || existing!.status === "rejected" ? "needs_review" : "done";
        await tx`update import_rows set status = ${rowStatus}, product_id = ${productId}, group_key = ${group.productKey},
          reason = ${rowStatus === "needs_review" ? "Unchanged since last import; product is awaiting review" : null}, updated_at = now()
          where id in ${tx(rowIds)}`;
      } else {
        await tx`update import_rows set status = 'grouped', product_id = ${productId}, group_key = ${group.productKey}, updated_at = now()
          where id in ${tx(rowIds)}`;
        toBuild.push(productId);
      }
    });
  }

  // Rows the grouper could not place (should be none) still need a terminal state.
  const ungrouped = rows.filter((r) => !grouped.has(r.row_number)).map((r) => r.id);
  if (ungrouped.length) {
    await sql`update import_rows set status = 'failed', reason = 'Row could not be grouped into a product', updated_at = now()
      where id in ${sql(ungrouped)} and status = 'pending'`;
  }
  const orphans = matches.filter((m) => !m.productKey).map((m) => [m.assetId, m.reason ?? "No product matched this photo"]);
  if (orphans.length) {
    await sql`update assets set status = 'orphan', reason = m.reason
      from (values ${sql(orphans as never)}) as m(id, reason)
      where assets.id = m.id::uuid and assets.import_id = ${importId} and assets.status = 'ok'`;
  }

  // Products whose input did not change cost no AI call; metrics use this for "saved by skipping".
  await sql`update imports set counts = coalesce(counts, '{}'::jsonb) || ${JSON.stringify({ skipped_unchanged: skippedUnchanged })}::jsonb
    where id = ${importId}`;
  await refreshCounts(importId);
  await setImportStatus(importId, "building", { stage: "build" });
  for (let i = 0; i < toBuild.length; i += BUILD_BATCH) {
    await enqueueBuild(
      { importId, storeId, productIds: toBuild.slice(i, i + BUILD_BATCH), kind: "build" },
      `build:${importId}:${i / BUILD_BATCH}`,
    );
  }
  await checkFinalize(importId);
}

async function writeVariants(sql: DbHandle["sql"], storeId: string, productId: string, group: ProductGroup): Promise<void> {
  const skus = group.variants.map((v) => v.sku).filter((s): s is string => !!s);
  const clashes = new Set(
    skus.length
      ? (await sql<Array<{ sku: string }>>`select sku from variants where store_id = ${storeId} and sku in ${sql(skus)} and product_id <> ${productId}`).map((r) => r.sku)
      : [],
  );
  const keys: string[] = [];
  for (const [position, v] of group.variants.entries()) {
    const clash = v.sku !== null && clashes.has(v.sku);
    const variantKey = v.sku ?? `opts:${JSON.stringify(Object.entries(v.options).sort())}`;
    keys.push(variantKey);
    if (clash) {
      group.issues.push({ code: "SKU_TAKEN", severity: "error", message: `SKU ${v.sku} already belongs to another product`, field: "sku", rows: v.sourceRows });
    }
    await sql`
      insert into variants (store_id, product_id, variant_key, sku, options, price_cents, currency, weight_grams, source_rows, position)
      values (${storeId}, ${productId}, ${variantKey}, ${clash ? null : v.sku}, ${JSON.stringify(v.options)}::jsonb, ${v.priceCents},
        ${v.currency}, ${v.weightGrams}, ${JSON.stringify(v.sourceRows)}::jsonb, ${position})
      on conflict (product_id, variant_key) do update set sku = excluded.sku, options = excluded.options,
        price_cents = excluded.price_cents, currency = excluded.currency, weight_grams = excluded.weight_grams,
        source_rows = excluded.source_rows, position = excluded.position`;
  }
  if (keys.length) await sql`delete from variants where product_id = ${productId} and variant_key not in ${sql(keys)}`;
}
