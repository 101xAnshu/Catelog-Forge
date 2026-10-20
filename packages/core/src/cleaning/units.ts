import { issue, type Issue } from "./issues";

const LENGTH_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  '"': 25.4,
  "″": 25.4,
  "''": 25.4,
  zoll: 25.4,
  ft: 304.8,
  feet: 304.8,
};

const WEIGHT_TO_G: Record<string, number> = {
  g: 1,
  gr: 1,
  gram: 1,
  grams: 1,
  gramm: 1,
  kg: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogramm: 1000,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
};

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;

function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** Formats centimetres without float noise: 20 → "20 cm", 20.32 → "20.3 cm". */
export function formatCm(cm: number): string {
  const r = Math.round(cm * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} cm`;
}

export interface LengthResult {
  cm: number | null;
  display: string | null;
  issues: Issue[];
}

/**
 * Reads a length such as `20cm`, `8"`, `8 in`, `Ø 25 cm`, `200 mm`.
 * Values without a unit are assumed to be `defaultUnit` (and flagged).
 */
export function parseLength(raw: string | null | undefined, field = "size", defaultUnit?: string): LengthResult {
  if (!raw || !raw.trim()) return { cm: null, display: null, issues: [] };
  const s = raw.trim().replace(/^ø\s*/i, "");
  const m = s.match(new RegExp(`^${NUM}\\s*(mm|cm|m|inches|inch|in|zoll|ft|feet|"|″|'')\\.?$`, "i"));
  if (m) {
    const unit = (m[2] as string).toLowerCase();
    const mm = toNumber(m[1] as string) * (LENGTH_TO_MM[unit] ?? 10);
    const cm = roundTo(mm / 10, 0.1);
    const issues: Issue[] = [];
    if (unit !== "cm") {
      issues.push(issue("UNIT_CONVERTED", "info", `${raw.trim()} → ${formatCm(cm)}`, { field, original: raw.trim() }));
    }
    return { cm, display: formatCm(cm), issues };
  }
  const bare = s.match(new RegExp(`^${NUM}$`));
  if (bare && defaultUnit) {
    const cm = roundTo((toNumber(bare[1] as string) * (LENGTH_TO_MM[defaultUnit] ?? 10)) / 10, 0.1);
    return {
      cm,
      display: formatCm(cm),
      issues: [issue("UNIT_ASSUMED", "warn", `No unit on "${raw.trim()}", assumed ${defaultUnit}`, { field, original: raw.trim() })],
    };
  }
  return { cm: null, display: null, issues: [] };
}

export interface WeightResult {
  grams: number | null;
  issues: Issue[];
}

export function parseWeight(raw: string | number | null | undefined, unitHint?: string | null): WeightResult {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { grams: null, issues: [] };
  const s = String(raw).trim();
  const m = s.match(new RegExp(`^${NUM}\\s*([a-zA-Z]+)?\\.?$`));
  if (!m) {
    return { grams: null, issues: [issue("WEIGHT_UNPARSEABLE", "warn", `Could not read weight "${s}"`, { field: "weight", original: s })] };
  }
  const unit = (m[2] ?? unitHint ?? "").toLowerCase();
  const factor = WEIGHT_TO_G[unit];
  const issues: Issue[] = [];
  let grams: number;
  if (factor === undefined) {
    if (unit) {
      return { grams: null, issues: [issue("WEIGHT_UNKNOWN_UNIT", "warn", `Unknown weight unit "${unit}"`, { field: "weight", original: s })] };
    }
    // No unit: values under 50 are almost certainly kg, larger ones grams.
    const n = toNumber(m[1] as string);
    grams = Math.round(n < 50 ? n * 1000 : n);
    issues.push(
      issue("UNIT_ASSUMED", "warn", `No unit on weight "${s}", assumed ${n < 50 ? "kg" : "g"}`, { field: "weight", original: s }),
    );
  } else {
    grams = Math.round(toNumber(m[1] as string) * factor);
    if (unit !== "g" && unit !== "gr" && unit !== "gram" && unit !== "grams" && unit !== "gramm") {
      issues.push(issue("UNIT_CONVERTED", "info", `${s} → ${grams} g`, { field: "weight", original: s }));
    }
  }
  if (grams <= 0 || grams > 1_000_000) {
    issues.push(issue("WEIGHT_IMPLAUSIBLE", "error", `Weight ${grams} g looks wrong`, { field: "weight", original: s }));
  }
  return { grams, issues };
}

const SIZE_WORDS = /^(xxs|xs|s|m|l|xl|xxl|xxxl|small|medium|large|klein|mittel|groß|gross|petit|moyen|grand|one size)$/i;

/** Normalises a size option: dimensions become cm, apparel sizes are upper-cased. */
export function normalizeSize(raw: string | null | undefined): { value: string | null; issues: Issue[] } {
  if (!raw || !raw.trim()) return { value: null, issues: [] };
  const s = raw.trim();
  if (SIZE_WORDS.test(s)) return { value: s.length <= 4 ? s.toUpperCase() : capitalize(s), issues: [] };
  const len = parseLength(s, "size");
  if (len.display) return { value: len.display, issues: len.issues };
  return { value: s, issues: [] };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
