import { and, asc, eq, gt, inArray } from "@cf/db/orm";
import { assets, products, variants } from "@cf/db";
import type { ProductOutput } from "@cf/core";
import { web } from "./db";
import { productWhere, type ProductQuery } from "./products";

export type ExportFormat = "csv" | "json" | "shopify";

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection from supplier text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;
const money = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

const CSV_HEADER = [
  "handle", "title", "status", "category", "tags", "description_html", "sku", "options", "price", "currency",
  "weight_grams", "attributes", "claims", "min_confidence", "review_reason", "source_rows", "seo_title", "seo_description",
];

const SHOPIFY_HEADER = [
  "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published",
  "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value",
  "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Policy", "Variant Fulfillment Service",
  "Variant Price", "Variant Requires Shipping", "Variant Taxable", "Image Src", "Image Position",
  "SEO Title", "SEO Description", "Variant Weight Unit", "Status",
];

type Row = typeof products.$inferSelect;
type VariantRow = typeof variants.$inferSelect;

async function* productPages(storeId: string, filters: Omit<ProductQuery, "page" | "pageSize" | "sort" | "dir">) {
  const db = web().db;
  let after: string | null = null;
  for (;;) {
    const where = and(productWhere(storeId, filters), after ? gt(products.id, after) : undefined);
    const page: Row[] = await db.select().from(products).where(where).orderBy(asc(products.id)).limit(500);
    if (page.length === 0) return;
    const ids = page.map((p) => p.id);
    const [vs, imgs] = await Promise.all([
      db.select().from(variants).where(inArray(variants.productId, ids)).orderBy(asc(variants.position)),
      db
        .select({ productId: assets.productId, storageKey: assets.storageKey })
        .from(assets)
        .where(and(inArray(assets.productId, ids), eq(assets.status, "ok")))
        .orderBy(asc(assets.filename)),
    ]);
    const byProduct = new Map<string, VariantRow[]>();
    for (const v of vs) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
    const images = new Map<string, string[]>();
    for (const i of imgs) if (i.productId) images.set(i.productId, [...(images.get(i.productId) ?? []), i.storageKey]);
    yield page.map((p) => ({ product: p, variants: byProduct.get(p.id) ?? [], images: images.get(p.id) ?? [] }));
    after = page[page.length - 1]?.id ?? null;
    if (page.length < 500) return;
  }
}

function outputOf(p: Row): Partial<ProductOutput> {
  return (p.output ?? {}) as Partial<ProductOutput>;
}

/** Streams the export so 10k+ products never sit in memory at once (EDGE S12). */
export function exportStream(
  storeId: string,
  format: ExportFormat,
  filters: Omit<ProductQuery, "page" | "pageSize" | "sort" | "dir">,
  appUrl: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => controller.enqueue(enc.encode(s));
      try {
        if (format === "csv") push(csvLine(CSV_HEADER));
        if (format === "shopify") push(csvLine(SHOPIFY_HEADER));
        if (format === "json") push("[\n");
        let first = true;
        for await (const page of productPages(storeId, filters)) {
          for (const { product: p, variants: vs, images } of page) {
            const o = outputOf(p);
            if (format === "json") {
              const doc: ProductOutput = {
                title: o.title ?? p.title ?? "",
                handle: p.handle,
                description_html: o.description_html ?? "",
                category: o.category ?? p.category ?? "",
                tags: o.tags ?? [],
                attributes: o.attributes ?? {},
                variants: vs.map((v) => ({ sku: v.sku, options: v.options, price_cents: v.priceCents, currency: v.currency, weight_grams: v.weightGrams })),
                claims: o.claims ?? [],
                confidence: o.confidence ?? {},
                status: (p.status === "archived" ? "rejected" : p.status) as ProductOutput["status"],
                review_reason: p.reviewReasons.join("; ") || null,
                source_rows: o.source_rows ?? [...new Set(vs.flatMap((v) => v.sourceRows))].sort((a, b) => a - b),
                seo: o.seo ?? { title: "", description: "" },
              };
              push(`${first ? "" : ",\n"}${JSON.stringify(doc)}`);
              first = false;
              continue;
            }
            if (format === "csv") {
              for (const v of vs.length ? vs : [null]) {
                push(
                  csvLine([
                    p.handle, o.title ?? p.title, p.status, o.category ?? p.category, (o.tags ?? []).join(", "), o.description_html,
                    v?.sku, v ? Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join("; ") : "",
                    v ? money(v.priceCents) : "", v?.currency, v?.weightGrams, o.attributes ?? {},
                    (o.claims ?? []).map((c: ProductOutput["claims"][number]) => `${c.text} [${c.source}]`).join("; "), p.minConfidence,
                    p.reviewReasons.join("; "), (v?.sourceRows ?? o.source_rows ?? []).join(" "), o.seo?.title, o.seo?.description,
                  ]),
                );
              }
              continue;
            }
            // Shopify product CSV: first row carries product fields, following rows only variant fields.
            const optionNames = [...new Set(vs.flatMap((v) => Object.keys(v.options)))].slice(0, 3);
            const rows = vs.length ? vs : [null];
            rows.forEach((v, i) => {
              const opt = (n: number) => {
                const name = optionNames[n];
                if (!name) return ["", ""];
                return [i === 0 ? capitalize(name) : "", v?.options[name] ?? ""];
              };
              const noOptions = optionNames.length === 0;
              const img = images[i];
              push(
                csvLine([
                  p.handle,
                  i === 0 ? o.title ?? p.title : "",
                  i === 0 ? o.description_html : "",
                  i === 0 ? o.attributes?.brand ?? "" : "",
                  i === 0 ? o.category ?? p.category : "",
                  i === 0 ? (o.category ?? "").split(">").pop()?.trim() : "",
                  i === 0 ? (o.tags ?? []).join(", ") : "",
                  i === 0 ? String(p.status === "approved").toUpperCase() : "",
                  ...(noOptions && i === 0 ? ["Title", "Default Title"] : opt(0)),
                  ...opt(1),
                  ...opt(2),
                  v?.sku ?? "",
                  v?.weightGrams ?? "",
                  "",
                  "deny",
                  "manual",
                  v ? money(v.priceCents) : "",
                  "TRUE",
                  "TRUE",
                  img ? `${appUrl}/api/files/${img}` : "",
                  img ? i + 1 : "",
                  i === 0 ? o.seo?.title ?? "" : "",
                  i === 0 ? o.seo?.description ?? "" : "",
                  "g",
                  i === 0 ? (p.status === "approved" ? "active" : "draft") : "",
                ]),
              );
            });
            // Extra images beyond the variant count get image-only rows.
            for (let j = rows.length; j < images.length; j++) {
              const row = SHOPIFY_HEADER.map(() => "");
              row[0] = p.handle;
              row[22] = `${appUrl}/api/files/${images[j]}`;
              row[23] = String(j + 1);
              push(csvLine(row));
            }
          }
        }
        if (format === "json") push("\n]\n");
        controller.close();
      } catch (err) {
        console.error("[export]", err);
        controller.error(err);
      }
    },
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
