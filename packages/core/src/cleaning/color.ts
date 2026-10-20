import { issue, type Issue } from "./issues";

export const COLORS = [
  "black", "white", "grey", "silver", "red", "orange", "yellow", "green", "blue", "navy", "purple",
  "pink", "brown", "beige", "cream", "ivory", "gold", "bronze", "copper", "natural", "terracotta",
  "anthracite", "charcoal", "olive", "sage", "mint", "teal", "turquoise", "burgundy", "mustard",
  "sand", "stone", "taupe", "rust", "clear", "multicolour",
] as const;

const SYNONYMS: Record<string, string> = {
  gray: "grey", "light grey": "grey", "dark grey": "anthracite", multicolor: "multicolour", multi: "multicolour",
  transparent: "clear", tan: "beige", offwhite: "cream", "off-white": "cream", "off white": "cream",
  // German
  schwarz: "black", weiß: "white", weiss: "white", grau: "grey", rot: "red", orange: "orange", gelb: "yellow",
  grün: "green", gruen: "green", blau: "blue", lila: "purple", rosa: "pink", braun: "brown", natur: "natural",
  anthrazit: "anthracite", silber: "silver", kupfer: "copper",
  // French
  noir: "black", blanc: "white", gris: "grey", rouge: "red", jaune: "yellow", vert: "green", bleu: "blue",
  violet: "purple", rose: "pink", marron: "brown", naturel: "natural", "terre cuite": "terracotta",
};

/** Optimal-string-alignment (Damerau-Levenshtein) distance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** Maps a supplier colour to the canonical vocabulary, fixing typos and DE/FR names. */
export function normalizeColor(raw: string | null | undefined): { value: string | null; issues: Issue[] } {
  if (!raw || !raw.trim()) return { value: null, issues: [] };
  const original = raw.trim();
  const s = original.toLowerCase().replace(/\s+/g, " ");
  if ((COLORS as readonly string[]).includes(s)) return { value: s, issues: [] };
  const syn = SYNONYMS[s];
  if (syn) {
    return { value: syn, issues: [issue("COLOR_TRANSLATED", "info", `"${original}" → ${syn}`, { field: "color", original })] };
  }
  let best: { color: string; dist: number } | null = null;
  for (const c of [...COLORS, ...Object.keys(SYNONYMS)]) {
    const dist = editDistance(s, c);
    if (!best || dist < best.dist) best = { color: SYNONYMS[c] ?? c, dist };
  }
  const maxDist = s.length >= 7 ? 2 : 1;
  if (best && best.dist <= maxDist && s.length >= 3) {
    return {
      value: best.color,
      issues: [issue("COLOR_TYPO_FIXED", "info", `"${original}" → ${best.color}`, { field: "color", original })],
    };
  }
  // Unknown colours are kept as written (e.g. "seafoam"), lower-cased.
  return { value: s, issues: [issue("COLOR_UNKNOWN", "info", `Colour "${original}" is not in the vocabulary`, { field: "color", original })] };
}
