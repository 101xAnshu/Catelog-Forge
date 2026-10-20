export const RISKY_CLAIM_TERMS: string[] = [
  "frost-proof", "frostproof", "waterproof", "water-resistant", "weatherproof", "organic", "handmade", "hand-made",
  "hand-thrown", "handcrafted", "dishwasher-safe", "dishwasher safe", "microwave-safe", "oven-safe", "bpa-free", "vegan",
  "food-safe", "food safe", "non-toxic", "eco-friendly", "biodegradable", "compostable", "recycled", "sustainable",
  "fair trade", "certified", "fsc", "uv-resistant", "rust-proof", "rustproof", "fireproof", "hypoallergenic",
  "antibacterial", "100% cotton", "solid wood", "lifetime warranty", "made in",
];

const NEGATIONS = new Set(["not", "no", "non", "never", "nicht", "kein", "keine", "pas", "ni", "without", "ohne", "sans"]);

/** Lower-case, unify dashes, strip punctuation; keeps words and numbers. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‐‑‒–—-]/g, " ")
    .replace(/[^\p{L}\p{N}%°]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (s: string) => normalizeForMatch(s).split(" ").filter(Boolean);

/** True when `quote` appears in `cell` (exact after normalisation, or ≥90% of its words in order-insensitive overlap). */
export function quoteMatches(quote: string, cell: string): boolean {
  const q = normalizeForMatch(quote);
  const c = normalizeForMatch(cell);
  if (!q || !c) return false;
  if (c.includes(q)) return true;
  const qw = q.split(" ");
  const cw = new Set(c.split(" "));
  const hit = qw.filter((w) => cw.has(w)).length;
  return qw.length >= 3 && hit / qw.length >= 0.9;
}

/** Finds the phrase in text and reports whether every occurrence is negated ("not frost-proof"). */
export function phraseStatus(phrase: string, text: string): "absent" | "negated" | "present" {
  const p = words(phrase);
  const t = words(text);
  if (!p.length) return "absent";
  let found = false;
  for (let i = 0; i + p.length <= t.length; i++) {
    if (p.every((w, j) => t[i + j] === w)) {
      found = true;
      const before = t.slice(Math.max(0, i - 3), i);
      if (!before.some((w) => NEGATIONS.has(w))) return "present";
    }
  }
  // also accept the joined form ("frostproof" vs "frost proof")
  const joined = p.join("");
  if (!found && p.length > 1 && t.includes(joined)) return "present";
  return found ? "negated" : "absent";
}

/** Whether the claim text is supported (present and not negated) by the quote. */
export function claimSupportedByQuote(claim: string, quote: string): { ok: boolean; reason?: string } {
  const status = phraseStatus(claim, quote);
  if (status === "present") return { ok: true };
  if (status === "negated") return { ok: false, reason: "Source negates this claim" };
  // content-word fallback: every meaningful word of the claim appears in the quote, none negated
  const cw = words(claim).filter((w) => w.length > 2);
  const qw = words(quote);
  if (cw.length && cw.every((w) => qw.includes(w))) {
    if (cw.some((w) => phraseStatus(w, quote) === "negated")) return { ok: false, reason: "Source negates this claim" };
    return { ok: true };
  }
  return { ok: false, reason: "Claim is not stated in the quoted text" };
}
