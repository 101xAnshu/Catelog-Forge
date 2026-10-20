import type { ProductOutput } from "../ai/schema";

export type ExportProduct = ProductOutput & { id: string; images: string[]; brand?: string | null };

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  // spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV; header = union of keys in first-seen order. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) {
    seen.add(k);
    headers.push(k);
  }
  const lines = [headers.map(cell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => cell(r[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

const money = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

/** One row per variant, product fields repeated. */
export function productsToCsvRows(products: ExportProduct[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const p of products) {
    const variants = p.variants.length ? p.variants : [{ sku: null, options: {}, price_cents: null, currency: null, weight_grams: null }];
    for (const v of variants) {
      rows.push({
        product_id: p.id,
        handle: p.handle,
        title: p.title,
        status: p.status,
        category: p.category,
        tags: p.tags.join(", "),
        sku: v.sku,
        options: Object.entries(v.options).map(([k, val]) => `${k}=${val}`).join("; "),
        price: money(v.price_cents),
        currency: v.currency,
        weight_grams: v.weight_grams,
        description_html: p.description_html,
        attributes: Object.entries(p.attributes).map(([k, val]) => `${k}: ${val}`).join("; "),
        claims: p.claims.map((c) => `${c.text} [${c.source}]`).join("; "),
        min_confidence: Object.values(p.confidence).length ? Math.min(...Object.values(p.confidence)) : "",
        review_reason: p.review_reason,
        source_rows: p.source_rows.join(" "),
        image: p.images[0] ?? "",
        seo_title: p.seo.title,
        seo_description: p.seo.description,
      });
    }
  }
  return rows;
}

const SHOPIFY_COLUMNS = [
  "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published",
  "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value",
  "Variant SKU", "Variant Grams", "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price",
  "Variant Requires Shipping", "Variant Taxable", "Variant Weight Unit", "Image Src", "Image Position",
  "SEO Title", "SEO Description", "Status",
];

/** Shopify product CSV (one row per variant, extra rows for additional images). */
export function toShopifyCsvRows(products: ExportProduct[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const blank = () => Object.fromEntries(SHOPIFY_COLUMNS.map((c) => [c, ""])) as Record<string, unknown>;
  for (const p of products) {
    const optionNames = [...new Set(p.variants.flatMap((v) => Object.keys(v.options)))].slice(0, 3);
    const variants = p.variants.length ? p.variants : [{ sku: null, options: {}, price_cents: null, currency: null, weight_grams: null }];
    variants.forEach((v, i) => {
      const r = blank();
      r.Handle = p.handle;
      if (i === 0) {
        r.Title = p.title;
        r["Body (HTML)"] = p.description_html;
        r.Vendor = p.brand ?? "";
        r["Product Category"] = p.category;
        r.Type = p.category.split(">").pop()?.trim() ?? "";
        r.Tags = p.tags.join(", ");
        r.Published = p.status === "approved" ? "TRUE" : "FALSE";
        r["SEO Title"] = p.seo.title;
        r["SEO Description"] = p.seo.description;
        r.Status = p.status === "approved" ? "active" : "draft";
        if (p.images[0]) {
          r["Image Src"] = p.images[0];
          r["Image Position"] = 1;
        }
      }
      if (optionNames.length === 0) {
        r["Option1 Name"] = i === 0 ? "Title" : "";
        r["Option1 Value"] = "Default Title";
      } else {
        optionNames.forEach((name, n) => {
          if (i === 0) r[`Option${n + 1} Name`] = name.charAt(0).toUpperCase() + name.slice(1);
          r[`Option${n + 1} Value`] = v.options[name] ?? "";
        });
      }
      r["Variant SKU"] = v.sku ?? "";
      r["Variant Grams"] = v.weight_grams ?? "";
      r["Variant Inventory Policy"] = "deny";
      r["Variant Fulfillment Service"] = "manual";
      r["Variant Price"] = money(v.price_cents);
      r["Variant Requires Shipping"] = "TRUE";
      r["Variant Taxable"] = "TRUE";
      r["Variant Weight Unit"] = "g";
      rows.push(r);
    });
    p.images.slice(1).forEach((src, n) => {
      const r = blank();
      r.Handle = p.handle;
      r["Image Src"] = src;
      r["Image Position"] = n + 2;
      rows.push(r);
    });
  }
  return rows;
}
