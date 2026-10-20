import type { CleanedRow, HeaderMap } from "../types";
import { sha256Hex } from "../hash";
import { cleanText } from "./encoding";
import { escapeHtml, htmlToText, looksLikeHtml, MAX_DESCRIPTION_CHARS, sanitizeDescription } from "./html";
import { issue, type Issue } from "./issues";
import { normalizeColor } from "./color";
import { detectLanguage } from "./language";
import { normalizeCurrencyCode, parsePrice } from "./price";
import { normalizeSize, parseLength, parseWeight } from "./units";
import { headerUnit } from "./headers";

const LENGTH_UNITS = new Set(["mm", "cm", "m", "in", "inch", "inches", '"', "″", "zoll"]);

/** Deterministic cleaning of one sheet row; never calls the AI. */
export function cleanRow(cells: string[], header: HeaderMap, rowNumber: number, opts: { defaultCurrency: string }): CleanedRow {
  const issues: Issue[] = [];
  const at = (i: Issue): Issue => ({ ...i, rows: [rowNumber] });
  const values = new Map<string, { value: string; header: string }[]>();
  const cellMap: Record<string, string> = {};
  const extra: Record<string, string> = {};

  for (const col of header.columns) {
    const { value, repaired } = cleanText(cells[col.index]);
    if (!value) continue;
    if (repaired) issues.push(at(issue("ENCODING_REPAIRED", "info", `Fixed broken characters in ${col.header}`, { field: col.header })));
    cellMap[col.header] = looksLikeHtml(value) ? htmlToText(value) : value;
    if (!col.field) {
      extra[col.header] = value;
      continue;
    }
    const list = values.get(col.field) ?? [];
    list.push({ value, header: col.header });
    values.set(col.field, list);
  }

  const first = (f: string): { value: string; header: string } | null => values.get(f)?.[0] ?? null;
  const joined = (f: string): string | null => {
    const list = values.get(f);
    return list && list.length ? list.map((v) => v.value).join("\n") : null;
  };

  const sku = first("sku")?.value.replace(/\s+/g, "") ?? null;
  const parentSku = first("parent_sku")?.value.replace(/\s+/g, "") ?? null;
  const name = first("name")?.value ?? null;
  const brand = first("brand")?.value ?? null;

  // description: sanitize, truncate huge text
  let descriptionHtml: string | null = null;
  let descriptionText: string | null = null;
  const rawDesc = joined("description");
  if (rawDesc) {
    let source = looksLikeHtml(rawDesc) ? rawDesc : `<p>${escapeHtml(rawDesc).replace(/\n+/g, "</p><p>")}</p>`;
    if (/<script|on[a-z]+\s*=|javascript:|<iframe|<style/i.test(rawDesc)) {
      issues.push(at(issue("UNSAFE_HTML_REMOVED", "info", "Removed unsafe HTML from description", { field: "description" })));
    }
    let text = htmlToText(source);
    if (text.length > MAX_DESCRIPTION_CHARS) {
      issues.push(at(issue("DESCRIPTION_TRUNCATED", "warn", `Description was ${text.length} characters; truncated to ${MAX_DESCRIPTION_CHARS}`, { field: "description" })));
      source = `<p>${escapeHtml(text.slice(0, MAX_DESCRIPTION_CHARS))}</p>`;
      text = text.slice(0, MAX_DESCRIPTION_CHARS);
    }
    descriptionHtml = sanitizeDescription(source) || null;
    descriptionText = text || null;
  }

  // price
  const currencyHint = first("currency")?.value ?? null;
  const priceCell = first("price");
  let priceCents: number | null = null;
  let currency: string | null = normalizeCurrencyCode(currencyHint);
  const pr = parsePrice(priceCell?.value ?? null, {
    currencyHint: currencyHint ?? headerUnit(priceCell?.header ?? ""),
    defaultCurrency: opts.defaultCurrency,
  });
  issues.push(...pr.issues.map(at));
  if (pr.money) {
    priceCents = pr.money.cents;
    currency = pr.money.currency;
  }

  // size
  let size: string | null = null;
  const sizeCell = first("size");
  if (sizeCell) {
    const unit = headerUnit(sizeCell.header);
    if (unit && LENGTH_UNITS.has(unit) && /^\d+(?:[.,]\d+)?$/.test(sizeCell.value)) {
      const len = parseLength(sizeCell.value, "size", unit === "inch" || unit === "inches" ? "in" : unit);
      size = len.display;
      issues.push(...len.issues.filter((i) => i.code !== "UNIT_ASSUMED").map(at));
      if (unit !== "cm" && len.display) {
        issues.push(at(issue("UNIT_CONVERTED", "info", `${sizeCell.value} ${unit} → ${len.display}`, { field: "size", original: `${sizeCell.value} ${unit}` })));
      }
    } else {
      const n = normalizeSize(sizeCell.value);
      size = n.value;
      issues.push(...n.issues.map(at));
    }
  }

  const colorRes = normalizeColor(first("color")?.value ?? null);
  issues.push(...colorRes.issues.map(at));

  // weight
  const weightCell = first("weight");
  const unitHint = first("weight_unit")?.value ?? headerUnit(weightCell?.header ?? "");
  const w = parseWeight(weightCell?.value ?? null, unitHint);
  issues.push(...w.issues.map(at));

  const notes = joined("notes");
  const category = first("category")?.value ?? null;
  const imageRef = first("image")?.value ?? null;
  const tags = (joined("tags") ?? "")
    .split(/[,;|]/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (!sku) issues.push(at(issue("SKU_MISSING", "error", "Missing SKU", { field: "sku" })));
  if (!name) issues.push(at(issue("NAME_MISSING", "error", "Missing product name", { field: "name" })));

  const language = detectLanguage([name, descriptionText, notes].filter(Boolean).join(" "));
  if (language === "de" || language === "fr") {
    issues.push(at(issue("SOURCE_LANGUAGE", "warn", `Source text is in ${language === "de" ? "German" : "French"}`, { field: "description" })));
  }

  const canonical = {
    sku, parentSku, name, brand, descriptionHtml, priceCents, currency, size, color: colorRes.value,
    material: first("material")?.value ?? null, weightGrams: w.grams, dimensions: first("dimensions")?.value ?? null,
    category, notes, imageRef, tags, extra,
  };

  return {
    rowNumber,
    ...canonical,
    descriptionText,
    cells: cellMap,
    language,
    issues,
    rowHash: sha256Hex(JSON.stringify(canonical)),
  };
}
