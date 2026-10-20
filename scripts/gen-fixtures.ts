/**
 * Deterministic generator for messy supplier fixtures + ground truth for the eval set.
 *
 *   bun scripts/gen-fixtures.ts
 *
 * Writes fixtures/small-20.csv, fixtures/messy-500.xlsx, fixtures/bulk-10000.csv,
 * fixtures/photos.zip, fixtures/ground-truth.json and eval/labelled.json.
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// xlsx and sharp are dependencies of the worker; resolve them from there (bun isolated installs).
const requireFromWorker = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const XLSX = requireFromWorker("xlsx") as typeof import("xlsx");
const sharp = requireFromWorker("sharp") as typeof import("sharp");

const ROOT = new URL("..", import.meta.url).pathname;
const FIX = join(ROOT, "fixtures");
const EVAL = join(ROOT, "eval");

/* ---------- seeded PRNG so fixtures are reproducible ---------- */
let seed = 0x2f6e2b1;
function rand(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const chance = (p: number) => rand() < p;

/* ---------- product templates (the ground truth) ---------- */
interface Template {
  base: string;
  name: string;
  brand: string;
  material: string;
  category: string;
  sizes: number[]; // cm, or [] for one-size
  colors: string[];
  priceCents: number; // price of the smallest size in EUR
  priceStep: number;
  weightG: number;
  description: string;
  notes: string;
  allowedClaims: string[];
  forbiddenClaims: string[];
  titleKeywords: string[];
}

const T = (t: Template) => t;
const TEMPLATES: Template[] = [
  T({ base: "TC-PL", name: "Hand-thrown Terracotta Planter", brand: "Erdwerk", material: "terracotta", category: "Home & Garden > Planters", sizes: [20, 30, 40], colors: ["terracotta"], priceCents: 2499, priceStep: 1000, weightG: 1800, description: "Hand-thrown terracotta planter with drainage hole.", notes: "frost-resistant (not frost-proof, bring indoors below 0 °C)", allowedClaims: ["hand-thrown", "frost-resistant"], forbiddenClaims: ["frost-proof", "waterproof"], titleKeywords: ["terracotta", "planter"] }),
  T({ base: "GC-PT", name: "Glazed Ceramic Pot", brand: "Erdwerk", material: "ceramic", category: "Home & Garden > Planters", sizes: [15, 25], colors: ["blue", "white", "green"], priceCents: 1899, priceStep: 800, weightG: 1200, description: "<p>Glazed ceramic pot for indoor plants.</p>", notes: "Indoor use only. No drainage hole.", allowedClaims: ["glazed"], forbiddenClaims: ["frost-proof", "dishwasher-safe"], titleKeywords: ["ceramic", "pot"] }),
  T({ base: "WC-CN", name: "Watering Can", brand: "Gießkraft", material: "galvanised steel", category: "Home & Garden > Watering Equipment", sizes: [], colors: ["grey", "green"], priceCents: 3450, priceStep: 0, weightG: 950, description: "Classic 5 litre watering can with brass rose.", notes: "Rust-resistant galvanised finish.", allowedClaims: ["rust-resistant"], forbiddenClaims: ["rustproof", "BPA-free"], titleKeywords: ["watering", "can"] }),
  T({ base: "BM-BW", name: "Bamboo Serving Bowl", brand: "Tavola", material: "bamboo", category: "Home & Garden > Kitchen & Dining > Serveware", sizes: [18, 24], colors: ["natural"], priceCents: 1599, priceStep: 600, weightG: 300, description: "Lightweight bamboo bowl for salads and snacks.", notes: "Hand wash only. Not dishwasher-safe.", allowedClaims: ["hand wash only"], forbiddenClaims: ["dishwasher-safe", "organic"], titleKeywords: ["bamboo", "bowl"] }),
  T({ base: "LN-NP", name: "Linen Napkin Set", brand: "Tavola", material: "linen", category: "Home & Garden > Kitchen & Dining > Table Linens", sizes: [], colors: ["white", "sage", "beige"], priceCents: 2900, priceStep: 0, weightG: 250, description: "Set of four stonewashed linen napkins.", notes: "Machine washable at 40 °C.", allowedClaims: ["machine washable", "stonewashed"], forbiddenClaims: ["organic", "handmade"], titleKeywords: ["linen", "napkin"] }),
  T({ base: "OC-BK", name: "Organic Cotton Bath Towel", brand: "Wellen", material: "cotton", category: "Home & Garden > Linens & Bedding > Towels", sizes: [70, 100], colors: ["white", "grey"], priceCents: 2400, priceStep: 900, weightG: 600, description: "Soft bath towel, 500 gsm.", notes: "Certified organic cotton (GOTS).", allowedClaims: ["organic", "GOTS certified"], forbiddenClaims: ["antibacterial"], titleKeywords: ["towel", "cotton"] }),
  T({ base: "CN-SY", name: "Soy Wax Candle", brand: "Lumen", material: "soy wax", category: "Home & Garden > Decor > Candles", sizes: [8, 12], colors: ["cream"], priceCents: 1450, priceStep: 700, weightG: 350, description: "Hand-poured soy wax candle with cotton wick.", notes: "Burn time approx. 40 hours. Handmade in Germany.", allowedClaims: ["hand-poured", "handmade"], forbiddenClaims: ["non-toxic", "organic"], titleKeywords: ["candle"] }),
  T({ base: "SH-GL", name: "Garden Gloves", brand: "Gießkraft", material: "leather", category: "Home & Garden > Gardening > Gardening Gloves", sizes: [], colors: ["brown"], priceCents: 1299, priceStep: 0, weightG: 150, description: "Goatskin leather gardening gloves.", notes: "Water-resistant, not waterproof.", allowedClaims: ["water-resistant"], forbiddenClaims: ["waterproof", "cut-proof"], titleKeywords: ["gloves"] }),
  T({ base: "PR-SH", name: "Pruning Shears", brand: "Schnittmeister", material: "stainless steel", category: "Home & Garden > Gardening > Gardening Tools", sizes: [20], colors: ["red", "black"], priceCents: 2799, priceStep: 0, weightG: 240, description: "Bypass pruning shears with stainless steel blades.", notes: "Lifetime warranty on blades.", allowedClaims: ["lifetime warranty"], forbiddenClaims: ["rustproof", "dishwasher-safe"], titleKeywords: ["pruning", "shears"] }),
  T({ base: "RB-BX", name: "Raised Bed Kit", brand: "Holzhaus", material: "larch wood", category: "Home & Garden > Gardening > Raised Garden Beds", sizes: [80, 120], colors: ["natural"], priceCents: 8900, priceStep: 3000, weightG: 14000, description: "Untreated larch raised bed, easy assembly.", notes: "Untreated wood. Weather-resistant.", allowedClaims: ["untreated", "weather-resistant"], forbiddenClaims: ["rot-proof", "organic"], titleKeywords: ["raised", "bed"] }),
  T({ base: "BF-FD", name: "Bird Feeder", brand: "Holzhaus", material: "pine wood", category: "Home & Garden > Lawn & Garden > Bird Feeders", sizes: [], colors: ["natural", "green"], priceCents: 1999, priceStep: 0, weightG: 700, description: "Hanging pine bird feeder.", notes: "FSC certified wood.", allowedClaims: ["FSC certified"], forbiddenClaims: ["squirrel-proof"], titleKeywords: ["bird", "feeder"] }),
  T({ base: "WL-LT", name: "Solar Wall Lantern", brand: "Lumen", material: "aluminium", category: "Home & Garden > Lighting > Outdoor Lighting", sizes: [25], colors: ["black", "anthracite"], priceCents: 3999, priceStep: 0, weightG: 800, description: "Solar powered wall lantern with dusk sensor.", notes: "IP44 splash-proof.", allowedClaims: ["IP44", "splash-proof"], forbiddenClaims: ["waterproof"], titleKeywords: ["lantern", "solar"] }),
  T({ base: "SC-CU", name: "Outdoor Seat Cushion", brand: "Wellen", material: "polyester", category: "Home & Garden > Lawn & Garden > Outdoor Furniture Accessories", sizes: [40, 50], colors: ["grey", "terracotta", "olive"], priceCents: 2299, priceStep: 500, weightG: 400, description: "Water-repellent outdoor cushion.", notes: "Water-repellent fabric. Cover removable.", allowedClaims: ["water-repellent", "removable cover"], forbiddenClaims: ["waterproof", "UV-resistant"], titleKeywords: ["cushion"] }),
  T({ base: "HB-PS", name: "Herb Seed Set", brand: "Saatgut Nord", material: "seeds", category: "Home & Garden > Gardening > Seeds", sizes: [], colors: ["multicolour"], priceCents: 999, priceStep: 0, weightG: 80, description: "Six varieties of culinary herb seeds.", notes: "Organic seeds, EU organic certified.", allowedClaims: ["organic"], forbiddenClaims: ["non-GMO", "heirloom"], titleKeywords: ["herb", "seed"] }),
  T({ base: "CB-BD", name: "Chopping Board", brand: "Tavola", material: "oak wood", category: "Home & Garden > Kitchen & Dining > Cutting Boards", sizes: [30, 40], colors: ["natural"], priceCents: 3299, priceStep: 1000, weightG: 1100, description: "Solid oak chopping board with juice groove.", notes: "Food-safe oil finish. Hand wash only.", allowedClaims: ["food-safe finish", "hand wash only"], forbiddenClaims: ["antibacterial", "dishwasher-safe"], titleKeywords: ["chopping", "board"] }),
  T({ base: "ST-MG", name: "Stoneware Mug", brand: "Erdwerk", material: "stoneware", category: "Home & Garden > Kitchen & Dining > Drinkware", sizes: [9], colors: ["sand", "blue", "black"], priceCents: 1499, priceStep: 0, weightG: 380, description: "Reactive glaze stoneware mug, 350 ml.", notes: "Dishwasher-safe and microwave-safe.", allowedClaims: ["dishwasher-safe", "microwave-safe"], forbiddenClaims: ["handmade", "lead-free"], titleKeywords: ["mug"] }),
  T({ base: "WT-TY", name: "Woven Storage Basket", brand: "Flechtwerk", material: "seagrass", category: "Home & Garden > Storage & Organisation > Baskets", sizes: [30, 40], colors: ["natural"], priceCents: 2799, priceStep: 900, weightG: 650, description: "Handwoven seagrass basket with handles.", notes: "Handwoven by artisans in Vietnam.", allowedClaims: ["handwoven"], forbiddenClaims: ["waterproof", "organic"], titleKeywords: ["basket"] }),
  T({ base: "HM-HK", name: "Garden Hammock", brand: "Wellen", material: "cotton", category: "Home & Garden > Lawn & Garden > Hammocks", sizes: [200], colors: ["cream", "blue"], priceCents: 6900, priceStep: 0, weightG: 2100, description: "Cotton hammock, max load 120 kg.", notes: "Max. load 120 kg. Bring indoors when wet.", allowedClaims: ["max load 120 kg"], forbiddenClaims: ["weatherproof", "UV-resistant"], titleKeywords: ["hammock"] }),
  T({ base: "CP-PT", name: "Copper Plant Mister", brand: "Gießkraft", material: "copper", category: "Home & Garden > Watering Equipment", sizes: [], colors: ["copper"], priceCents: 2499, priceStep: 0, weightG: 200, description: "Copper plated plant mister, 250 ml.", notes: "Copper plated (not solid copper).", allowedClaims: ["copper plated"], forbiddenClaims: ["solid copper"], titleKeywords: ["mister"] }),
  T({ base: "TK-BN", name: "Teak Garden Bench", brand: "Holzhaus", material: "teak wood", category: "Home & Garden > Lawn & Garden > Outdoor Furniture", sizes: [120, 150], colors: ["natural"], priceCents: 129900, priceStep: 30000, weightG: 22000, description: "Solid teak three-seater garden bench.", notes: "Grade A teak from FSC certified plantations. Oil yearly.", allowedClaims: ["FSC certified", "solid teak"], forbiddenClaims: ["maintenance-free", "weatherproof"], titleKeywords: ["teak", "bench"] }),
  T({ base: "DR-MT", name: "Coir Door Mat", brand: "Flechtwerk", material: "coir", category: "Home & Garden > Decor > Door Mats", sizes: [60, 75], colors: ["natural", "black"], priceCents: 2199, priceStep: 700, weightG: 1600, description: "Natural coir door mat with non-slip backing.", notes: "Non-slip PVC backing. For covered outdoor areas.", allowedClaims: ["non-slip"], forbiddenClaims: ["weatherproof", "eco-friendly"], titleKeywords: ["door", "mat"] }),
];

/* ---------- messiness helpers ---------- */
const COLOR_CODES: Record<string, string> = { grey: "GRY", green: "GRN", black: "BLK", blue: "BLU", white: "WHT", brown: "BRN", beige: "BGE", red: "RED" };
const colorCode = (c: string) => COLOR_CODES[c] ?? c.slice(0, 3).toUpperCase();

const CM_TO_IN = (cm: number) => Math.round((cm / 2.54) * 10) / 10;

function formatPrice(cents: number, style: number): string {
  const eur = Math.floor(cents / 100);
  const ct = String(cents % 100).padStart(2, "0");
  switch (style) {
    case 0: return `${eur},${ct} €`; // German
    case 1: return `${eur}.${ct}`; // plain
    case 2: return `€${eur}.${ct}`;
    case 3: return `EUR ${eur}`; // whole euros only
    case 4: return eur >= 1000 ? `${Math.floor(eur / 1000)}.${String(eur % 1000).padStart(3, "0")},${ct} €` : `${eur},${ct} €`;
    case 5: return `${eur},-`;
    default: return `${(cents / 100).toFixed(1)}`; // 12.5
  }
}

function formatWeight(g: number, style: number): string {
  switch (style) {
    case 0: return `${g} g`;
    case 1: return `${(g / 1000).toString().replace(".", ",")} kg`;
    case 2: return `${Math.round((g / 453.59237) * 10) / 10} lbs`;
    default: return `${g}g`;
  }
}

function formatSize(cm: number, style: number): string {
  switch (style) {
    case 0: return `${cm} cm`;
    case 1: return `${cm}cm`;
    case 2: return `${CM_TO_IN(cm)}"`;
    case 3: return `${cm * 10} mm`;
    default: return `Ø ${cm} cm`;
  }
}

const TYPOS: Record<string, string> = { terracotta: "terracota", anthracite: "antracite", natural: "natrual", olive: "olvie", cream: "creme" };
const GERMAN_COLORS: Record<string, string> = { blue: "blau", white: "weiß", green: "grün", grey: "grau", black: "schwarz", red: "rot", natural: "natur" };

/** UTF-8 text read as Latin-1, the classic Excel CSV mojibake. */
const mojibake = (s: string) => Buffer.from(s, "utf8").toString("latin1");

const HEADERS = ["SKU", "Product Name", "Brand", "Description", "Price", "Currency", "Size", "Colour", "Material", "Weight", "Category", "Notes", "Image"];
const GERMAN_HEADERS = ["Artikelnummer", "Bezeichnung", "Marke", "Beschreibung", "Preis", "Währung", "Größe", "Farbe", "Material", "Gewicht", "Kategorie", "Hinweise", "Bild"];

type Row = string[];

interface GenOptions { messiness: number; seriesCount: number; maxRows: number }

interface ProductInstance { template: Template; base: string; name: string; series: number }

const SERIES = ["", "Classic ", "Rustic ", "Nordic ", "Urban ", "Heritage ", "Studio ", "Atelier "];

function instances(count: number): ProductInstance[] {
  const out: ProductInstance[] = [];
  for (let s = 0; out.length < count; s++) {
    for (const t of TEMPLATES) {
      if (out.length >= count) break;
      const prefix = SERIES[s % SERIES.length] ?? "";
      const suffix = s >= SERIES.length ? ` ${Math.floor(s / SERIES.length) + 1}` : "";
      out.push({ template: t, base: s === 0 ? t.base : `${t.base}${String.fromCharCode(65 + (s % 26))}${s >= 26 ? s : ""}`, name: `${prefix}${t.name}${suffix}`, series: s });
    }
  }
  return out;
}

function variantRows(p: ProductInstance, m: number): Row[] {
  const t = p.template;
  const sizes = t.sizes.length ? t.sizes : [null];
  const rows: Row[] = [];
  sizes.forEach((size, si) => {
    for (const color of t.colors) {
      const sku = [p.base, size ?? null, t.colors.length > 1 ? colorCode(color) : null].filter((x) => x !== null).join("-");
      const priceCents = t.priceCents + si * t.priceStep;
      let price = formatPrice(priceCents, chance(m) ? Math.floor(rand() * 7) : 1);
      if (chance(m * 0.08)) price = ""; // missing price
      if (chance(m * 0.05)) price = `£${Math.round(priceCents / 117)}`; // supplier quoted in GBP
      const currency = chance(0.6) ? "EUR" : "";
      const sizeStr = size === null ? "" : formatSize(size, chance(m) ? Math.floor(rand() * 5) : 0);
      let colorStr = color;
      if (chance(m * 0.3) && TYPOS[color]) colorStr = TYPOS[color] as string;
      else if (chance(m * 0.15) && GERMAN_COLORS[color]) colorStr = GERMAN_COLORS[color] as string;
      if (chance(m * 0.3)) colorStr = colorStr.charAt(0).toUpperCase() + colorStr.slice(1);
      const weight = formatWeight(t.weightG + si * Math.round(t.weightG * 0.4), chance(m) ? Math.floor(rand() * 4) : 0);
      let description = t.description;
      if (chance(m * 0.1)) description = `${description}<script>alert('x')</script><img src=x onerror="steal()">`;
      if (chance(m * 0.02)) description = `${description} ${"Detailed supplier specification text. ".repeat(250)}`;
      const name = p.name;
      let notes = t.notes;
      if (chance(m * 0.1)) notes = germanNotes(t) ?? notes;
      if (chance(m * 0.08)) notes = mojibake(notes); // "Â°C", "ÃŸ" from a Latin-1 export
      const image = chance(0.3) ? `${sku}.jpg` : "";
      rows.push([sku, name, t.brand, description, price, currency, sizeStr, colorStr, t.material, weight, chance(0.5) ? t.category.split(" > ").pop() ?? "" : "", notes, image]);
    }
  });
  return rows;
}

function germanNotes(t: Template): string | null {
  if (t.base === "TC-PL") return "frostbeständig (nicht frostfest, unter 0 °C ins Haus holen)";
  if (t.base === "BM-BW") return "Nur Handwäsche. Nicht spülmaschinenfest.";
  if (t.base === "CN-SY") return "Brenndauer ca. 40 Stunden. Handgefertigt in Deutschland.";
  return null;
}

/** Applies row-level messiness: duplicates, conflicting duplicates, split rows, shuffling. */
function messUp(rows: Row[], m: number): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    out.push(r);
    if (chance(m * 0.06)) out.push([...r]); // exact duplicate
    if (chance(m * 0.03)) {
      const conflict = [...r];
      conflict[4] = `${Number.parseInt((r[4] ?? "").replace(/\D/g, "") || "1999", 10) / 100 + 5}`; // conflicting price
      out.push(conflict);
    }
    if (chance(m * 0.05)) {
      // split row: second row only carries the notes for the same SKU
      const split = r.map((v, i) => (i === 0 || i === 11 ? v : ""));
      split[11] = `${r[11]} (supplier addendum)`;
      out.push(split);
    }
  }
  // shuffle a fraction so rows of one product end up far apart
  for (let i = out.length - 1; i > 0; i--) {
    if (!chance(m)) continue;
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as Row, out[i] as Row];
  }
  return out;
}

function generate(opts: GenOptions): { rows: Row[]; products: ProductInstance[] } {
  const products = instances(opts.seriesCount);
  let rows: Row[] = [];
  for (const p of products) rows.push(...variantRows(p, opts.messiness));
  rows = messUp(rows, opts.messiness);
  return { rows: rows.slice(0, opts.maxRows), products };
}

/* ---------- writers ---------- */
function csvCell(v: string): string {
  return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
const toCsv = (header: string[], rows: Row[]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

async function main(): Promise<void> {
  mkdirSync(FIX, { recursive: true });
  mkdirSync(EVAL, { recursive: true });

  // small: 20 rows, light messiness, first few templates only
  seed = 0x1234567;
  const small = generate({ messiness: 0.35, seriesCount: 6, maxRows: 20 });
  writeFileSync(join(FIX, "small-20.csv"), toCsv(HEADERS, small.rows));

  // messy 500: German headers, title rows above the header, heavy messiness, XLSX
  seed = 0x7654321;
  const messy = generate({ messiness: 0.9, seriesCount: 190, maxRows: 500 });
  const aoa: string[][] = [["Lieferant: Gartenwelt GmbH — Preisliste 2026"], ["Stand: 01.10.2026"], [], GERMAN_HEADERS, ...messy.rows];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Preisliste");
  XLSX.writeFile(wb, join(FIX, "messy-500.xlsx"));

  // bulk 10k: English headers, moderate messiness
  seed = 0x0badf00;
  const bulk = generate({ messiness: 0.5, seriesCount: 4000, maxRows: 10_000 });
  writeFileSync(join(FIX, "bulk-10000.csv"), toCsv(HEADERS, bulk.rows));

  await photos(small.rows, messy.rows);

  // ground truth + eval set (one labelled entry per template, base SKU series 0)
  const truth = TEMPLATES.map((t) => ({
    productKey: t.base,
    expected: {
      titleKeywords: t.titleKeywords,
      category: t.category,
      attributes: { material: t.material },
      colors: t.colors,
      sizesCm: t.sizes,
      priceCentsFrom: t.priceCents,
      allowedClaims: t.allowedClaims,
      forbiddenClaims: t.forbiddenClaims,
    },
  }));
  writeFileSync(join(FIX, "ground-truth.json"), JSON.stringify(truth, null, 2));

  const labelled = TEMPLATES.flatMap((t, i) => {
    const sizes = t.sizes.length ? t.sizes : [null];
    const base = {
      id: `eval-${String(i + 1).padStart(2, "0")}`,
      expected: {
        titleKeywords: t.titleKeywords,
        category: t.category,
        attributes: { material: t.material },
        allowedClaims: t.allowedClaims,
        forbiddenClaims: t.forbiddenClaims,
      },
    };
    const clean = sizes.flatMap((size, si) => t.colors.map((color) => ({
      SKU: [t.base, size, t.colors.length > 1 ? colorCode(color) : null].filter((x) => x !== null).join("-"),
      "Product Name": t.name, Brand: t.brand, Description: t.description,
      Price: formatPrice(t.priceCents + si * t.priceStep, 1), Currency: "EUR",
      Size: size === null ? "" : `${size} cm`, Colour: color, Material: t.material,
      Weight: `${t.weightG} g`, Category: "", Notes: t.notes, Image: "",
    })));
    // second, messier version of the same product: German notes + typos + inches
    const messyRows = clean.map((r) => ({ ...r, Colour: TYPOS[r.Colour] ?? r.Colour, Notes: germanNotes(t) ?? r.Notes, Size: r.Size ? `${CM_TO_IN(Number.parseInt(r.Size, 10))}"` : "" }));
    return [
      { ...base, variant: "clean", rows: clean },
      { ...base, id: `${base.id}-messy`, variant: "messy", rows: messyRows },
    ];
  });
  writeFileSync(join(EVAL, "labelled.json"), JSON.stringify({ headers: HEADERS, items: labelled }, null, 2));

  console.info(`small-20.csv: ${small.rows.length} rows`);
  console.info(`messy-500.xlsx: ${messy.rows.length} rows (header on line 4, German headers)`);
  console.info(`bulk-10000.csv: ${bulk.rows.length} rows`);
  console.info(`eval/labelled.json: ${labelled.length} labelled products`);
}

const PALETTE: Record<string, [number, number, number]> = {
  terracotta: [200, 90, 60], blue: [60, 90, 180], white: [235, 235, 230], green: [70, 140, 80], grey: [130, 130, 130],
  natural: [200, 170, 120], sage: [150, 170, 140], beige: [215, 200, 170], cream: [240, 230, 205], brown: [120, 80, 50],
  red: [190, 50, 50], black: [30, 30, 30], anthracite: [60, 62, 65], olive: [110, 120, 60], multicolour: [180, 120, 200],
  sand: [210, 190, 150], copper: [184, 115, 51],
};

async function photos(...sheets: Row[][]): Promise<void> {
  const dir = join(FIX, ".photos-tmp");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "photos", "__MACOSX"), { recursive: true });
  const skus = [...new Set(sheets.flat().map((r) => r[0] ?? "").filter((s) => /^[A-Z]{2}-[A-Z]{2}(-|$)/.test(s)))].slice(0, 36);
  let n = 0;
  for (const sku of skus) {
    const colorWord = Object.keys(PALETTE).find((c) => sku.toLowerCase().endsWith(c.slice(0, 3))) ?? "terracotta";
    const [r, g, b] = PALETTE[colorWord] ?? [180, 180, 180];
    const ext = n % 3 === 0 ? "png" : "jpg";
    const img = sharp({ create: { width: 480, height: 480, channels: 3, background: { r, g, b } } })
      .composite([{ input: Buffer.from(`<svg width="480" height="480"><rect x="140" y="160" width="200" height="220" rx="24" fill="rgba(255,255,255,0.35)"/><text x="240" y="440" font-size="36" text-anchor="middle" fill="white" font-family="sans-serif">${sku}</text></svg>`), top: 0, left: 0 }]);
    const buf = ext === "png" ? await img.png().toBuffer() : await img.jpeg({ quality: 80 }).toBuffer();
    // mix naming styles: exact SKU, lower-case with suffix index
    const name = n % 4 === 1 ? `${sku.toLowerCase()}_1.${ext}` : `${sku}.${ext}`;
    writeFileSync(join(dir, "photos", name), buf);
    n++;
  }
  for (let i = 1; i <= 4; i++) {
    const buf = await sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
    writeFileSync(join(dir, "photos", `unknown-item-${i}.jpg`), buf);
  }
  writeFileSync(join(dir, "photos", "corrupt-image.jpg"), "this is not an image");
  writeFileSync(join(dir, "photos", "__MACOSX", "._TC-PL-20.jpg"), "junk resource fork");
  const out = join(FIX, "photos.zip");
  if (existsSync(out)) rmSync(out);
  const res = spawnSync("zip", ["-qr", out, "photos"], { cwd: dir });
  if (res.status !== 0) throw new Error(`zip failed: ${res.stderr?.toString()}`);
  rmSync(dir, { recursive: true, force: true });
  console.info(`photos.zip: ${n} matched photos, 4 orphans, 1 corrupt, __MACOSX junk`);
}

await main();
