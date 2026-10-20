import type { CleanedRow, ProductGroup } from "../types";
import type { AiProduct, ProductOutput } from "./schema";
import { editDistance } from "../cleaning/color";
import { htmlToText, sanitizeDescription } from "../cleaning/html";
import { claimSupportedByQuote, phraseStatus, quoteMatches, RISKY_CLAIM_TERMS } from "./claims";
import { CATEGORY_TAXONOMY, categoryAlias } from "./taxonomy";

export const DEFAULT_REVIEW_THRESHOLD = 70;

export interface GuardedClaim {
  text: string;
  sourceRow: number | null;
  sourceColumn: string | null;
  sourceQuote: string | null;
  verified: boolean;
  rejectedReason: string | null;
}

export interface GuardResult {
  output: ProductOutput;
  claims: GuardedClaim[];
  reviewReasons: string[];
  status: "needs_review" | "approved";
  minConfidence: number;
}

function findCell(row: CleanedRow, column: string): string | null {
  if (row.cells[column] !== undefined) return row.cells[column] as string;
  const lc = column.toLowerCase().trim();
  const key = Object.keys(row.cells).find((k) => k.toLowerCase().trim() === lc);
  return key ? (row.cells[key] as string) : null;
}

/** Nearest taxonomy path by leaf name, then by edit distance on the whole path. */
export function nearestCategory(category: string): string {
  const lc = category.toLowerCase();
  const leaf = lc.split(">").pop()?.trim() ?? lc;
  const byLeaf = CATEGORY_TAXONOMY.find((c) => (c.toLowerCase().split(">").pop()?.trim() ?? "") === leaf);
  if (byLeaf) return byLeaf;
  const contains = CATEGORY_TAXONOMY.find((c) => c.toLowerCase().includes(leaf) || leaf.includes(c.toLowerCase().split(">").pop()?.trim() ?? "@@"));
  if (contains) return contains;
  // a typo in the last segment ("Plantrs") still identifies the node
  const leafTypo = CATEGORY_TAXONOMY.filter((c) => editDistance(leaf, c.toLowerCase().split(">").pop()?.trim() ?? "") <= 2);
  if (leaf.length >= 5 && leafTypo.length === 1) return leafTypo[0] as string;
  let best = { c: "Uncategorized", d: Infinity };
  for (const c of CATEGORY_TAXONOMY) {
    const d = editDistance(lc, c.toLowerCase());
    if (d < best.d) best = { c, d };
  }
  // Only accept near-typos; an unrelated sibling ("Decor > Textiles" → "Decor > Vases") is worse than review.
  return best.d <= Math.max(2, Math.floor(lc.length / 10)) ? best.c : "Uncategorized";
}

/**
 * Deterministic checks applied to every AI result. The AI can only *propose* text;
 * money, SKUs and weights come from cleaning, and every claim must be backed by a verbatim source quote.
 */
export function applyGuards(
  group: ProductGroup,
  ai: AiProduct,
  opts: { reviewThreshold?: number; handle: string },
): GuardResult {
  const threshold = opts.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
  const reasons: string[] = [];
  const confidence: Record<string, number> = { ...ai.confidence };
  const sourceText = group.rows.flatMap((r) => Object.values(r.cells)).join("\n");

  // 1. claims: verify quote against the cited cell (or relocate it if it exists elsewhere)
  const claims: GuardedClaim[] = [];
  for (const c of ai.claims) {
    const row = group.rows.find((r) => r.rowNumber === c.row);
    let cell = row ? findCell(row, c.column) : null;
    let sourceRow: number | null = row ? c.row : null;
    let sourceColumn: string | null = cell !== null ? c.column : null;
    if (cell === null || !quoteMatches(c.quote, cell)) {
      // the model may have cited the wrong cell: accept only if the quote is verbatim somewhere in this product's source
      cell = null;
      for (const r of group.rows) {
        for (const [col, val] of Object.entries(r.cells)) {
          if (quoteMatches(c.quote, val)) {
            cell = val;
            sourceRow = r.rowNumber;
            sourceColumn = col;
            break;
          }
        }
        if (cell !== null) break;
      }
    }
    if (cell === null) {
      claims.push({ text: c.text, sourceRow: null, sourceColumn: null, sourceQuote: c.quote, verified: false, rejectedReason: "Quote not found in source" });
      continue;
    }
    // Check the quote and the whole cited cell: quoting "frost-proof" out of "not frost-proof" must still fail.
    const quoteSupport = claimSupportedByQuote(c.text, c.quote);
    const support = quoteSupport.ok && phraseStatus(c.text, cell) === "negated"
      ? { ok: false, reason: "Source negates this claim" }
      : quoteSupport;
    claims.push({
      text: c.text,
      sourceRow,
      sourceColumn,
      sourceQuote: c.quote,
      verified: support.ok,
      rejectedReason: support.ok ? null : (support.reason ?? "Unsupported"),
    });
  }
  for (const c of claims.filter((x) => !x.verified)) reasons.push(`Removed unsupported claim: ${c.text} (${c.rejectedReason})`);
  const verifiedClaims = claims.filter((c) => c.verified);

  // 2. risky terms anywhere in the output must be supported by the source (and not negated)
  let title = ai.title.trim();
  let descriptionHtml = sanitizeDescription(ai.description_html);
  let tags = [...new Set(ai.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(ai.attributes)) if (v && String(v).trim()) attributes[k] = String(v).trim();

  for (const term of RISKY_CLAIM_TERMS) {
    const inSource = phraseStatus(term, sourceText) === "present";
    if (inSource) continue;
    const removed: string[] = [];
    if (phraseStatus(term, title) === "present") {
      reasons.push(`Title contains unsupported claim "${term}"`);
      confidence.title = Math.min(confidence.title ?? 100, 40);
    }
    if (phraseStatus(term, htmlToText(descriptionHtml)) === "present") {
      descriptionHtml = stripSentencesWith(descriptionHtml, term);
      removed.push("description");
    }
    const keptTags = tags.filter((t) => phraseStatus(term, t) !== "present");
    if (keptTags.length !== tags.length) removed.push("tags");
    tags = keptTags;
    for (const [k, v] of Object.entries(attributes)) {
      if (phraseStatus(term, v) === "present") {
        delete attributes[k];
        delete confidence[`attributes.${k}`];
        removed.push(`attributes.${k}`);
      }
    }
    if (removed.length) reasons.push(`Removed unsupported claim "${term}" from ${removed.join(", ")}`);
  }

  // 3. category must be in taxonomy
  let category = ai.category.trim();
  // A known synonym ("Home Decor > Cushions") is the same category, not a guess: map it without review.
  const alias = CATEGORY_TAXONOMY.includes(category) ? null : categoryAlias(category);
  if (alias) category = alias;
  if (!CATEGORY_TAXONOMY.includes(category)) {
    const mapped = nearestCategory(category);
    reasons.push(`Category "${category}" is not in the taxonomy; mapped to "${mapped}"`);
    category = mapped;
    confidence.category = Math.min(confidence.category ?? 50, 50);
  }

  // 4. confidence gating
  for (const f of ["title", "description_html", "category"]) if (confidence[f] === undefined) confidence[f] = 50;
  for (const [field, value] of Object.entries(confidence)) {
    if (value < threshold) reasons.push(`Low confidence on ${field} (${Math.round(value)}%)`);
  }
  const minConfidence = Math.round(Math.min(...Object.values(confidence)));

  // 5. deterministic issues from cleaning (conflicts, missing prices, missing SKU …)
  for (const i of group.issues) if (i.severity === "error") reasons.push(i.message);
  if (ai.needs_review) reasons.push(ai.review_reason?.trim() || "Model flagged this product for review");
  if (!descriptionHtml) reasons.push("Description is empty");

  const uniqueReasons = [...new Set(reasons)];
  const status = uniqueReasons.length ? "needs_review" : "approved";
  const descText = htmlToText(descriptionHtml);

  const output: ProductOutput = {
    title,
    handle: opts.handle,
    description_html: descriptionHtml,
    category,
    tags,
    attributes,
    variants: group.variants.map((v) => ({
      sku: v.sku,
      options: v.options,
      price_cents: v.priceCents,
      currency: v.currency,
      weight_grams: v.weightGrams,
    })),
    claims: verifiedClaims.map((c) => ({
      text: c.text,
      source: `row ${c.sourceRow}, column ${c.sourceColumn}`,
      quote: c.sourceQuote ?? "",
      verified: true,
    })),
    confidence,
    status,
    review_reason: uniqueReasons.length ? uniqueReasons.join("; ") : null,
    source_rows: group.rows.map((r) => r.rowNumber),
    seo: {
      title: (ai.seo_title?.trim() || title).slice(0, 60),
      description: (ai.seo_description?.trim() || descText).slice(0, 155),
    },
  };
  return { output, claims, reviewReasons: uniqueReasons, status, minConfidence };
}

function stripSentencesWith(html: string, term: string): string {
  // remove list items / sentences containing the term, keep the rest of the markup
  let out = html.replace(/<li>[\s\S]*?<\/li>/gi, (li) => (phraseStatus(term, htmlToText(li)) === "present" ? "" : li));
  out = out.replace(/(^|>)([^<]+)/g, (_m, pre: string, text: string) => {
    const sentences = text.split(/(?<=[.!?])\s+/);
    return pre + sentences.filter((s) => phraseStatus(term, s) !== "present").join(" ");
  });
  return sanitizeDescription(out.replace(/<ul>\s*<\/ul>/g, ""));
}
