import { AiServerError, AiTimeoutError, RateLimitError, type AiProvider, type CompletionRequest, type CompletionResult, type Tier } from "./types";
import { GROQ_MODELS } from "./cost";
import { phraseStatus } from "@cf/core";

type Failure = "rate_limit" | "invalid_json" | "timeout" | "server_error" | "invented_claim";

export function parseFailureSpec(spec: string | undefined): Partial<Record<Failure, number>> {
  const out: Partial<Record<Failure, number>> = {};
  for (const part of (spec ?? "").split(",")) {
    const [k, v] = part.split(":");
    if (k && v && !Number.isNaN(Number(v))) out[k.trim() as Failure] = Number(v);
  }
  return out;
}

interface Cell { row: number; column: string; text: string }
interface FakeProductInput { id: string; cells: Cell[] }

/** Finds the largest parseable JSON value embedded in a prompt. */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try { return JSON.parse(fence[1]); } catch { /* fall through */ }
  }
  const starts: number[] = [];
  for (let i = 0; i < text.length && starts.length < 40; i++) if (text[i] === "{" || text[i] === "[") starts.push(i);
  for (const s of starts) {
    const closer = text[s] === "{" ? "}" : "]";
    let end = text.lastIndexOf(closer);
    for (let tries = 0; end > s && tries < 6; tries++) {
      try { return JSON.parse(text.slice(s, end + 1)); } catch { end = text.lastIndexOf(closer, end - 1); }
    }
  }
  return null;
}

const ROW_KEYS = ["row", "rowNumber", "row_number", "sourceRow"];

/** Walks an arbitrary prompt payload collecting (row, column, text) cells. */
function collectCells(node: unknown, row: number | null, out: Cell[]): void {
  if (Array.isArray(node)) { for (const n of node) collectCells(n, row, out); return; }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  let r = row;
  for (const k of ROW_KEYS) if (typeof obj[k] === "number") r = obj[k] as number;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && r !== null && v.trim() && !ROW_KEYS.includes(k)) out.push({ row: r, column: k, text: v });
    else if (v && typeof v === "object") collectCells(v, r, out);
  }
}

function findProducts(payload: unknown): FakeProductInput[] {
  const found: FakeProductInput[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.id === "string" && Object.keys(obj).length > 1) {
      const cells: Cell[] = [];
      collectCells(obj, null, cells);
      found.push({ id: obj.id, cells });
      return;
    }
    Object.values(obj).forEach(visit);
  };
  visit(payload);
  return found;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const CLAIM_TERMS = [
  "frost-resistant", "frost resistant", "frost-proof", "handmade", "hand-made", "hand-thrown", "organic", "waterproof",
  "water-resistant", "dishwasher-safe", "dishwasher safe", "uv-resistant", "uv resistant", "recycled", "fsc", "food-safe",
  "food safe", "drainage hole", "handgefertigt", "frostfest", "frostbeständig",
];

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/planter|pot|topf|cache-pot/i, "Home & Garden > Planters"],
  [/vase/i, "Home & Garden > Decor > Vases"],
  [/string light|fairy light|lichterkette/i, "Home & Garden > Lighting > String Lights"],
  [/lamp|light|lampe|lantern|laterne/i, "Home & Garden > Lighting > Lamps"],
  [/mug|cup|tasse|bowl|plate|teller/i, "Home & Garden > Kitchen & Dining > Tableware"],
  [/cushion|pillow|kissen|throw|blanket/i, "Home & Garden > Decor > Cushions & Throws"],
  [/candle|kerze/i, "Home & Garden > Decor > Candles"],
  [/coir|door mat|fußmatte|fussmatte/i, "Home & Garden > Decor > Door Mats"],
  [/chair|table|stool|bench|tisch|stuhl/i, "Home & Garden > Lawn & Garden > Outdoor Furniture"],
  [/basket|korb|storage/i, "Home & Garden > Storage & Organisation > Baskets"],
  [/watering can|gießkanne/i, "Home & Garden > Watering Equipment"],
  [/bird|vogel/i, "Home & Garden > Lawn & Garden > Bird Feeders"],
  [/tool|trowel|shovel|rake|pruner|shears/i, "Home & Garden > Gardening > Gardening Tools"],
];

const DE: Record<string, string> = {
  planter: "Pflanzgefäß", pot: "Topf", "hand-thrown": "handgedrehter", terracotta: "Terrakotta", with: "mit", and: "und",
  drainage: "Abfluss", hole: "loch", the: "der", for: "für", indoor: "Innenbereich", outdoor: "Außenbereich", garden: "Garten",
  natural: "natur", black: "schwarz", white: "weiß", grey: "grau", red: "rot", green: "grün", blue: "blau", bring: "bringen",
  indoors: "drinnen", below: "unter", "frost-resistant": "frostbeständig", ceramic: "Keramik", vase: "Vase", lamp: "Lampe",
  large: "groß", small: "klein", is: "ist", a: "ein", of: "aus", made: "hergestellt", from: "aus", "not": "nicht",
};
const FR: Record<string, string> = {
  planter: "jardinière", pot: "pot", "hand-thrown": "tourné à la main", terracotta: "terre cuite", with: "avec", and: "et",
  drainage: "drainage", hole: "trou", the: "le", for: "pour", indoor: "intérieur", outdoor: "extérieur", garden: "jardin",
  natural: "naturel", black: "noir", white: "blanc", grey: "gris", red: "rouge", green: "vert", blue: "bleu", bring: "rentrer",
  indoors: "à l'intérieur", below: "en dessous de", "frost-resistant": "résistant au gel", ceramic: "céramique", vase: "vase",
  lamp: "lampe", large: "grand", small: "petit", is: "est", a: "un", of: "de", made: "fabriqué", from: "en", "not": "pas",
};

function pseudoTranslate(text: string, locale: "de" | "fr"): string {
  const dict = locale === "de" ? DE : FR;
  // Tokens like ⟦T1⟧ are never touched; words are swapped where the dictionary knows them.
  return text.replace(/[A-Za-z][A-Za-z-]*/g, (w) => {
    const t = dict[w.toLowerCase()];
    if (!t) return w;
    return w[0] === w[0]?.toUpperCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic stand-in for a real model: powers demo mode (no API key) and failure-injection tests.
 * It only ever cites text that really exists in the prompt, unless `invented_claim` is injected.
 */
export class FakeProvider implements AiProvider {
  readonly name = "fake" as const;
  constructor(
    private readonly failures = parseFailureSpec(process.env.FAKE_AI_FAILURES),
    private readonly latencyMs = Number(process.env.FAKE_AI_LATENCY_MS ?? 30),
  ) {}

  modelFor(tier: Tier): string {
    return `fake/${GROQ_MODELS[tier]}`;
  }

  private roll(kind: Failure): boolean {
    const p = this.failures[kind] ?? 0;
    return p > 0 && Math.random() < p;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (this.roll("rate_limit")) throw new RateLimitError(Number(process.env.FAKE_AI_RETRY_AFTER_MS ?? 2000));
    if (this.roll("timeout")) throw new AiTimeoutError();
    if (this.roll("server_error")) throw new AiServerError("Fake provider 503", 503);

    const payload = extractJson(req.user);
    const isTranslation =
      !!payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown }).items);
    let text = isTranslation ? this.translate(req, payload as { items: Array<{ key: string; text: string }> }) : this.build(payload);
    if (this.roll("invalid_json")) text = text.slice(0, Math.floor(text.length / 2));
    return {
      text,
      model: this.modelFor(req.tier),
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      cachedTokens: 0,
      latencyMs: Date.now() - started,
    };
  }

  private translate(req: CompletionRequest, payload: { items: Array<{ key: string; text: string }>; locale?: string }): string {
    const hint = `${payload.locale ?? ""} ${req.system} ${req.user.slice(0, 400)}`;
    const locale: "de" | "fr" = /\bfr\b|french|français/i.test(hint) && !/\bde\b|german|deutsch/i.test(hint) ? "fr" : "de";
    return JSON.stringify({ items: payload.items.map((i) => ({ key: i.key, text: pseudoTranslate(i.text, locale) })) });
  }

  private build(payload: unknown): string {
    const products = findProducts(payload).map((p) => {
      const h = hash(p.id + p.cells.map((c) => c.text).join("|"));
      const nameCell =
        p.cells.find((c) => /^(name|title|product|product[ _]?name|bezeichnung|produkt(name)?|artikel(name)?)$/i.test(c.column)) ??
        p.cells.find((c) => /name|title|bezeichnung/i.test(c.column) && !/brand|marke/i.test(c.column));
      const descCell = p.cells.find((c) => /desc/i.test(c.column));
      const name = (nameCell?.text ?? "Untitled product").replace(/\s+\d+(\.\d+)?\s?(cm|mm|in|")\b/gi, "").trim();
      const title = name.replace(/\b\w/g, (m) => m.toUpperCase()).slice(0, 120);
      const all = p.cells.map((c) => c.text).join(" ");
      const hinted = CATEGORY_HINTS.find(([re]) => re.test(all))?.[1];
      const category = hinted ?? "Home & Garden > Garden Decor";
      const claims: Array<{ text: string; quote: string; row: number; column: string }> = [];
      for (const cell of p.cells) {
        const lower = cell.text.toLowerCase();
        for (const term of CLAIM_TERMS) {
          const idx = lower.indexOf(term);
          // A decent model does not claim what the source negates ("not frost-proof").
          if (idx >= 0 && !claims.some((c) => c.text === term) && phraseStatus(term, cell.text) === "present") {
            claims.push({ text: term, quote: cell.text.slice(idx, idx + term.length), row: cell.row, column: cell.column });
          }
        }
      }
      const material = /terracotta|terrakotta|terre cuite/i.test(all) ? "terracotta" : /ceramic|keramik/i.test(all) ? "ceramic" : /wood|holz|oak/i.test(all) ? "wood" : null;
      const attributes: Record<string, string> = {};
      if (material) attributes.material = material;
      const care = p.cells.find((c) => /bring indoors[^.;)]*/i.test(c.text));
      if (care) attributes.care = care.text.match(/bring indoors[^.;)]*/i)![0].replace(/^./, (m) => m.toUpperCase());
      const descText = descCell?.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      let description = `<p>${escape(descText || title)}</p>`;
      if (this.roll("invented_claim")) {
        claims.push({ text: "organic", quote: "certified organic", row: p.cells[0]?.row ?? 1, column: "Notes" });
        description += "<p>Certified organic.</p>";
      }
      // Mostly confident on clean input, with an occasional genuinely unsure field (~8%).
      const conf = (k: number) => ((h >> k) % 25 === 0 ? 55 + ((h >> k) % 14) : 78 + ((h >> k) % 21));
      const confidence: Record<string, number> = {
        title: nameCell ? Math.max(conf(1), 85) : 55,
        description_html: descCell ? conf(3) : 66,
        category: hinted ? conf(5) : 62,
        tags: conf(7),
      };
      for (const k of Object.keys(attributes)) confidence[`attributes.${k}`] = conf(k.length + 9);
      return {
        id: p.id,
        title,
        description_html: description,
        category,
        tags: Array.from(new Set(title.toLowerCase().split(/[^a-zäöüß]+/).filter((w) => w.length > 3))).slice(0, 6),
        attributes,
        seo_title: title.slice(0, 60),
        seo_description: (descText || title).slice(0, 155),
        claims,
        confidence,
        needs_review: false,
        review_reason: null,
      };
    });
    return JSON.stringify({ products });
  }
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
