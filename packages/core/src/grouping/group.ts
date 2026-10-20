import type { CleanedRow, ProductGroup, VariantDraft } from "../types";
import { COLORS } from "../cleaning/color";
import { issue, type Issue } from "../cleaning/issues";
import { sha256Hex } from "../hash";

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    while (this.parent[i] !== r) {
      const next = this.parent[i] as number;
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

const SIZE_WORDS = new Set(["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "small", "medium", "large", "klein", "mittel",
  "gross", "groß", "petit", "moyen", "grand", "mini", "maxi"]);
const COLOR_WORDS = new Set<string>([...COLORS, "gray", "schwarz", "weiss", "weiß", "grau", "rot", "gelb", "grün", "blau",
  "braun", "natur", "noir", "blanc", "gris", "rouge", "vert", "bleu", "terracota"]);

/** Tokens in a SKU suffix that may encode this row's own size/colour option. */
function optionTokens(row: CleanedRow): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    if (!s) return;
    for (const n of s.match(/\d+(?:[.,]\d+)?/g) ?? []) {
      out.add(n.replace(",", "."));
      out.add(String(Math.round(Number(n.replace(",", ".")))));
    }
    const word = s.replace(/[^a-z]/gi, "").toUpperCase();
    if (word) out.add(word);
  };
  add(row.size);
  for (const i of row.issues) if (i.field === "size" && i.original) add(i.original);
  if (row.color) {
    const c = row.color.toUpperCase().replace(/\s+/g, "");
    out.add(c);
    out.add(c.slice(0, 3));
    out.add(c.slice(0, 2));
    out.add(c.replace(/[AEIOU]/g, "").slice(0, 3));
    out.add(c.charAt(0));
  }
  for (const i of row.issues) if (i.field === "color" && i.original) out.add(i.original.toUpperCase().replace(/\s+/g, ""));
  return out;
}

/** SKU base with trailing size/colour segments removed, or null when nothing was stripped. */
export function skuBase(row: CleanedRow): string | null {
  if (!row.sku) return null;
  const parts = row.sku.toUpperCase().split(/[-_/. ]+/).filter(Boolean);
  const tokens = optionTokens(row);
  let stripped = false;
  while (parts.length > 1 && tokens.has(parts[parts.length - 1] as string)) {
    parts.pop();
    stripped = true;
  }
  return stripped ? parts.join("-") : null;
}

/** SKU minus a trailing variant index (`-1`, `-12`, `-B`); null when there is no SKU. */
function skuFamily(sku: string | null): string | null {
  if (!sku) return null;
  const parts = sku.toUpperCase().split(/[-_/. ]+/).filter(Boolean);
  if (parts.length > 1 && /^(\d{1,2}|[A-Z])$/.test(parts[parts.length - 1] as string)) parts.pop();
  return parts.join("-");
}

/** Name minus sizes, colours, numbers and units; used to join split rows of the same product. */
export function nameKey(row: CleanedRow): string | null {
  if (!row.name) return null;
  const own = new Set([row.color, row.size].filter(Boolean).map((s) => (s as string).toLowerCase()));
  // Numbers with a unit are variant sizes; bare numbers ("Planter 2") identify a product unless they are this row's size.
  const ownNumbers = new Set((row.size ?? "").match(/\d+(?:[.,]\d+)?/g) ?? []);
  const tokens = row.name
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?\s*(?:cm|mm|m|in|inch|inches|"|″|kg|g|lbs?|oz|l|ml|liter|litre)\b/g, " ")
    .replace(/\d+(?:[.,]\d+)?/g, (n) => (ownNumbers.has(n) ? " " : ` n${n.replace(",", ".")} `))
    .split(/[^a-z0-9.äöüßàâçéèêëîïôûùÿœ]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !SIZE_WORDS.has(t) && !COLOR_WORDS.has(t) && !own.has(t));
  const key = tokens.join(" ").trim();
  return key.length >= 3 ? key : null;
}

function variantLabel(v: VariantDraft): string {
  const opts = Object.entries(v.options).map(([k, val]) => `${k} ${val}`);
  return opts.length ? opts.join(", ") : v.sku ?? "default variant";
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const map = new Map<string, Issue>();
  for (const i of issues) {
    const key = `${i.code}|${i.field ?? ""}|${i.message}`;
    const existing = map.get(key);
    if (existing) existing.rows = [...new Set([...(existing.rows ?? []), ...(i.rows ?? [])])].sort((a, b) => a - b);
    else map.set(key, { ...i, rows: [...(i.rows ?? [])] });
  }
  return [...map.values()];
}

export function computeInputHash(group: ProductGroup, photoShas: string[]): string {
  return sha256Hex(JSON.stringify({ rows: group.rows.map((r) => r.rowHash).sort(), photos: [...photoShas].sort() }));
}

function messinessScore(rows: CleanedRow[], issues: Issue[]): number {
  let score = 0;
  for (const i of issues) score += i.severity === "error" ? 15 : i.severity === "warn" ? 6 : 2;
  if (rows.some((r) => r.language === "de" || r.language === "fr")) score += 20;
  if (!rows.some((r) => r.descriptionText)) score += 10;
  if (rows.some((r) => (r.descriptionText?.length ?? 0) > 2000)) score += 10;
  if (new Set(rows.map((r) => r.name).filter(Boolean)).size > 1 && !rows.some((r) => r.size || r.color)) score += 10;
  return Math.min(100, score);
}

/** Groups cleaned rows into products with variants. Deterministic for the same input. */
export function groupRows(rows: CleanedRow[], _opts: { defaultCurrency: string }): ProductGroup[] {
  const uf = new UnionFind(rows.length);
  const bases = rows.map(skuBase);

  // Phase 1: strong identifiers.
  const byKey = new Map<string, number>();
  const link = (key: string, i: number) => {
    const prev = byKey.get(key);
    if (prev === undefined) byKey.set(key, i);
    else uf.union(prev, i);
  };
  rows.forEach((r, i) => {
    if (r.parentSku) link(`parent:${r.parentSku.toUpperCase()}`, i);
    if (r.sku) link(`sku:${r.sku.toUpperCase()}`, i);
    const b = bases[i];
    if (b) {
      link(`base:${b}`, i);
      // a row whose full SKU equals another row's base (e.g. parent row "TC-PL") joins too
      link(`sku:${b}`, i);
    }
  });

  // Phase 2: name joins, unless both sides already carry different SKU families
  // (TP-0001-1/TP-0001-2 share family TP-0001; PL-001 vs PL-002 stay apart).
  const identities = new Map<number, Set<string>>();
  rows.forEach((r, i) => {
    const ident = bases[i] ?? skuFamily(r.parentSku ?? r.sku);
    if (!ident) return;
    const root = uf.find(i);
    const set = identities.get(root) ?? new Set<string>();
    set.add(ident);
    identities.set(root, set);
  });
  const byName = new Map<string, number>();
  rows.forEach((r, i) => {
    const nk = nameKey(r);
    if (!nk) return;
    const key = `${(r.brand ?? "").toLowerCase()}|${nk}`;
    const prev = byName.get(key);
    if (prev === undefined) {
      byName.set(key, i);
      return;
    }
    const ra = uf.find(prev);
    const rb = uf.find(i);
    if (ra === rb) return;
    const a = identities.get(ra);
    const b = identities.get(rb);
    if (a?.size && b?.size && ![...a].some((x) => b.has(x))) return;
    uf.union(ra, rb);
    const merged = new Set([...(a ?? []), ...(b ?? [])]);
    identities.delete(ra);
    identities.delete(rb);
    if (merged.size) identities.set(uf.find(ra), merged);
  });

  const components = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const root = uf.find(i);
    const list = components.get(root) ?? [];
    list.push(i);
    components.set(root, list);
  });

  const groups: ProductGroup[] = [];
  for (const idxs of components.values()) {
    const groupRowsSorted = idxs.map((i) => rows[i] as CleanedRow).sort((a, b) => a.rowNumber - b.rowNumber);
    const groupBases = idxs.map((i) => bases[i]).filter((b): b is string => !!b).sort();
    const parents = groupRowsSorted.map((r) => r.parentSku?.toUpperCase()).filter((p): p is string => !!p).sort();
    const skus = groupRowsSorted.map((r) => r.sku?.toUpperCase()).filter((s): s is string => !!s).sort();
    const firstNamed = groupRowsSorted.find((r) => nameKey(r));
    const productKey = parents[0]
      ? `sku:${parents[0]}`
      : groupBases[0]
        ? `sku:${groupBases[0]}`
        : skus[0]
          ? `sku:${skus[0]}`
          : firstNamed
            ? `name:${(firstNamed.brand ?? "").toLowerCase()}|${nameKey(firstNamed)}`
            : `row:${(groupRowsSorted[0] as CleanedRow).rowHash.slice(0, 16)}`;

    const issues: Issue[] = [];
    const hasSku = skus.length > 0;
    const hasName = groupRowsSorted.some((r) => r.name);
    for (const r of groupRowsSorted) {
      for (const i of r.issues) {
        if (i.code === "PRICE_MISSING") continue; // judged per variant below
        if (i.code === "SKU_MISSING" && hasSku) continue;
        if (i.code === "NAME_MISSING" && hasName) continue;
        issues.push(i);
      }
    }

    // exact duplicates
    const byHash = new Map<string, number[]>();
    for (const r of groupRowsSorted) byHash.set(r.rowHash, [...(byHash.get(r.rowHash) ?? []), r.rowNumber]);
    for (const nums of byHash.values()) {
      if (nums.length > 1) issues.push(issue("DUPLICATE_ROW", "info", `Rows ${nums.join(", ")} are identical and were merged`, { rows: nums }));
    }

    // variants
    const variantRows = new Map<string, CleanedRow[]>();
    for (const r of groupRowsSorted) {
      const options: Record<string, string> = {};
      if (r.size) options.size = r.size;
      if (r.color) options.color = r.color;
      const sig = Object.entries(options).map(([k, v]) => `${k}=${v}`).join("|");
      // rows without SKU that only add text (split rows) attach to the product, not a new variant
      const key = r.sku ? `sku:${r.sku.toUpperCase()}` : sig ? `opt:${sig}` : "";
      if (!key) continue;
      variantRows.set(key, [...(variantRows.get(key) ?? []), r]);
    }
    if (variantRows.size === 0) variantRows.set("default", groupRowsSorted);
    // an opt:-only variant that matches a sku variant's options is the same variant
    for (const [key, list] of [...variantRows.entries()]) {
      if (!key.startsWith("opt:")) continue;
      const sig = key.slice(4);
      const match = [...variantRows.entries()].find(([k, l]) => k.startsWith("sku:") && optionsSig(l[0] as CleanedRow) === sig);
      if (match) {
        match[1].push(...list);
        variantRows.delete(key);
      }
    }

    const variants: VariantDraft[] = [];
    for (const list of variantRows.values()) {
      const nums = list.map((r) => r.rowNumber);
      const options: Record<string, string> = {};
      const size = list.find((r) => r.size)?.size;
      const color = list.find((r) => r.color)?.color;
      if (size) options.size = size;
      if (color) options.color = color;
      const sku = list.find((r) => r.sku)?.sku ?? null;
      const v: VariantDraft = { sku, options, priceCents: null, currency: null, weightGrams: null, sourceRows: nums };

      const prices = list.filter((r) => r.priceCents !== null);
      const distinctPrices = [...new Set(prices.map((r) => `${r.priceCents}|${r.currency}`))];
      if (prices[0]) {
        v.priceCents = prices[0].priceCents;
        v.currency = prices[0].currency;
      }
      if (distinctPrices.length > 1) {
        issues.push(issue("PRICE_CONFLICT", "error",
          `Conflicting price for ${sku ?? variantLabel(v)} (rows ${prices.map((r) => r.rowNumber).join(", ")})`,
          { field: "price", rows: prices.map((r) => r.rowNumber) }));
      }
      const weights = list.filter((r) => r.weightGrams !== null);
      if (weights[0]) v.weightGrams = weights[0].weightGrams;
      if (new Set(weights.map((r) => r.weightGrams)).size > 1) {
        issues.push(issue("WEIGHT_CONFLICT", "error",
          `Conflicting weight for ${sku ?? variantLabel(v)} (rows ${weights.map((r) => r.rowNumber).join(", ")})`,
          { field: "weight", rows: weights.map((r) => r.rowNumber) }));
      }
      variants.push(v);
    }
    variants.sort((a, b) => (a.sourceRows[0] ?? 0) - (b.sourceRows[0] ?? 0));

    const currencies = new Set(variants.map((v) => v.currency).filter(Boolean));
    if (currencies.size > 1) {
      issues.push(issue("MIXED_CURRENCY", "warn", `Mixed currencies: ${[...currencies].join(", ")}`, { field: "price" }));
    }
    // only options whose values differ between variants are real variant options
    const optionNames = (["size", "color"] as const).filter(
      (k) => new Set(variants.map((v) => v.options[k]).filter(Boolean)).size > 1,
    );
    for (const v of variants) {
      for (const k of Object.keys(v.options)) if (!optionNames.includes(k as "size" | "color")) delete v.options[k];
    }

    for (const v of variants) {
      if (v.priceCents === null) {
        const priceIssue = v.sourceRows
          .flatMap((n) => groupRowsSorted.find((r) => r.rowNumber === n)?.issues ?? [])
          .find((i) => i.field === "price" && i.code !== "PRICE_MISSING");
        if (!priceIssue) {
          issues.push(issue("PRICE_MISSING", "error", `No price for ${variantLabel(v)}`, { field: "price", rows: v.sourceRows }));
        }
      }
    }
    const finalIssues = dedupeIssues(issues);
    const group: ProductGroup = {
      productKey,
      rows: groupRowsSorted,
      variants,
      optionNames: [...optionNames],
      issues: finalIssues,
      inputHash: "",
      photoKeys: [],
      messiness: messinessScore(groupRowsSorted, finalIssues),
    };
    group.inputHash = computeInputHash(group, []);
    groups.push(group);
  }
  return groups.sort((a, b) => (a.rows[0]?.rowNumber ?? 0) - (b.rows[0]?.rowNumber ?? 0));
}

function optionsSig(r: CleanedRow): string {
  const options: Record<string, string> = {};
  if (r.size) options.size = r.size;
  if (r.color) options.color = r.color;
  return Object.entries(options).map(([k, v]) => `${k}=${v}`).join("|");
}
