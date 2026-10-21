import { describe, expect, test } from "bun:test";
import {
  AiProductSchema, applyGuards, buildProductPrompt, claimSupportedByQuote, cleanRow, detectHeaders, groupRows, maskForTranslation, routeModel,
  slugify, toCsv, toShopifyCsvRows, unmask, type ExportProduct,
} from "../src";

const header = detectHeaders([["SKU", "Name", "Price", "Size", "Material", "Notes", "Description"]]);
const rows = [
  cleanRow(["TC-PL-20", "Terracotta Planter", "24,99", "20 cm", "terracotta", "frost-resistant (not frost-proof, bring indoors below 0 °C)", "Hand-thrown terracotta planter with drainage hole."], header, 14, { defaultCurrency: "EUR" }),
  cleanRow(["TC-PL-30", "Terracotta Planter", "34,99", "30 cm", "terracotta", "", ""], header, 15, { defaultCurrency: "EUR" }),
];
const [group] = groupRows(rows, { defaultCurrency: "EUR" });

const ai = AiProductSchema.parse({
  id: "p1",
  title: "Hand-thrown Terracotta Planter",
  description_html: "<p>Hand-thrown terracotta planter with drainage hole. Made from organic clay.</p>",
  category: "Home & Garden > Planters",
  tags: ["terracotta", "planter", "organic"],
  attributes: { material: "terracotta", care: "Bring indoors below 0 °C", certification: "organic" },
  claims: [
    { text: "frost-resistant", quote: "frost-resistant (not frost-proof, bring indoors below 0 °C)", row: 14, column: "Notes" },
    { text: "frost-proof", quote: "frost-resistant (not frost-proof, bring indoors below 0 °C)", row: 14, column: "Notes" },
    { text: "handmade", quote: "lovingly handmade in Italy", row: 14, column: "Notes" },
  ],
  confidence: { title: 97, description_html: 90, category: 81, tags: 85, "attributes.care": 64 },
});

describe("applyGuards", () => {
  if (!group) throw new Error("no group");
  const r = applyGuards(group, ai, { handle: "hand-thrown-terracotta-planter" });

  test("verified claim kept with source", () => {
    expect(r.output.claims).toEqual([
      { text: "frost-resistant", source: "row 14, column Notes", quote: "frost-resistant (not frost-proof, bring indoors below 0 °C)", verified: true },
    ]);
  });
  test("negated claim rejected", () => {
    expect(r.claims.find((c) => c.text === "frost-proof")?.rejectedReason).toBe("Source negates this claim");
  });
  test("supplier category synonyms map to the taxonomy without review", () => {
    for (const [supplier, expected] of [
      ["Home Decor > Cushions", "Home & Garden > Decor > Cushions & Throws"],
      ["Kitchen & Dining > Boards", "Home & Garden > Kitchen & Dining > Cutting Boards"],
      ["Storage > Baskets", "Home & Garden > Storage & Organisation > Baskets"],
      ["Door Mats", "Home & Garden > Decor > Door Mats"],
      ["Lighting > Table Lamps", "Home & Garden > Lighting > Table Lamps"],
      ["Furniture > Chairs", "Home & Garden > Furniture > Chairs"],
    ] as const) {
      const g = applyGuards(group, { ...ai, category: supplier, claims: [], tags: [], attributes: {} }, { handle: "x" });
      expect(g.output.category).toBe(expected);
      expect(g.reviewReasons.some((r) => r.includes("not in the taxonomy"))).toBe(false);
    }
  });
  test("negated claim rejected when the quote omits the negation", () => {
    const narrow = applyGuards(group, {
      ...ai,
      claims: [{ text: "frost-proof", quote: "frost-proof", row: 14, column: "Notes" }],
    }, { handle: "x" });
    expect(narrow.claims[0]?.verified).toBe(false);
    expect(narrow.claims[0]?.rejectedReason).toBe("Source negates this claim");
  });
  test("invented quote rejected", () => {
    expect(r.claims.find((c) => c.text === "handmade")?.rejectedReason).toBe("Quote not found in source");
  });
  test("invented 'organic' removed everywhere", () => {
    expect(r.output.tags).not.toContain("organic");
    expect(r.output.attributes.certification).toBeUndefined();
    expect(r.output.description_html).not.toMatch(/organic/i);
    expect(r.output.description_html).toContain("drainage hole");
    expect(r.reviewReasons.some((x) => x.includes("organic"))).toBe(true);
  });
  test("prices come from cleaning, low confidence flags review", () => {
    expect(r.output.variants.map((v) => v.price_cents)).toEqual([2499, 3499]);
    expect(r.status).toBe("needs_review");
    expect(r.reviewReasons).toContain("Low confidence on attributes.care (64%)");
    expect(r.minConfidence).toBe(64);
  });
  test("unknown category mapped and capped", () => {
    const r2 = applyGuards(group, { ...ai, category: "Garden > Plantrs", claims: [], tags: [], attributes: {} }, { handle: "x" });
    expect(r2.output.category).toBe("Home & Garden > Planters");
    expect(r2.output.confidence.category).toBe(50);
  });
  test("clean result auto-passes", () => {
    const clean = applyGuards(group, {
      ...ai,
      description_html: "<p>Hand-thrown terracotta planter with drainage hole.</p>",
      tags: ["terracotta"],
      attributes: { material: "terracotta" },
      claims: [ai.claims[0]!],
      confidence: { title: 95, description_html: 90, category: 90, tags: 90, "attributes.material": 95 },
    }, { handle: "x" });
    expect(clean.reviewReasons).toEqual([]);
    expect(clean.status).toBe("approved");
  });
});

describe("routing and prompts", () => {
  test("clean → cheap, forced tier respected, vision needs photos", () => {
    if (!group) throw new Error("no group");
    expect(routeModel({ ...group, messiness: 5 }, { hasPhotos: false })).toBe("cheap");
    expect(routeModel({ ...group, messiness: 80 }, { hasPhotos: false })).toBe("strong");
    expect(routeModel(group, { hasPhotos: true, needVision: true })).toBe("vision");
    expect(routeModel(group, { hasPhotos: false, forceTier: "vision" })).toBe("strong");
  });
  test("prompt includes ids and source cells", () => {
    if (!group) throw new Error("no group");
    const p = buildProductPrompt([{ id: "p1", group }], "v2");
    expect(p.user).toContain('"id":"p1"');
    expect(p.user).toContain("frost-resistant");
    expect(p.system).toContain("Home & Garden > Planters");
  });
});

describe("translation masking", () => {
  test("round trip protects html, placeholders, brands, numbers", () => {
    const text = "<p>The Fiskars planter holds {{count}} plants, 20 cm wide, 1.8 kg.</p>";
    const { masked, tokens } = maskForTranslation(text, { brands: ["Fiskars"] });
    expect(masked).not.toMatch(/<p>|Fiskars|\{\{count\}\}|20 cm|1\.8 kg/);
    expect(unmask(masked, tokens)).toEqual({ ok: true, text });
    const translated = masked.replace("The", "Der").replace("planter holds", "Pflanzgefäß fasst");
    expect(unmask(translated, tokens).ok).toBe(true);
  });
  test("dropped or duplicated token fails", () => {
    const { masked, tokens } = maskForTranslation("<b>20 cm</b>", { brands: [] });
    expect(unmask(masked.replace("⟦N1⟧", ""), tokens).ok).toBe(false);
    expect(unmask(masked + "⟦N1⟧", tokens).ok).toBe(false);
  });
});

describe("exports", () => {
  test("csv escapes and blocks formula injection", () => {
    expect(toCsv([{ a: 'x,"y"', b: "=SUM(A1)" }])).toBe('a,b\r\n"x,""y""",\'=SUM(A1)\r\n');
  });
  test("shopify rows", () => {
    const p: ExportProduct = {
      id: "1", images: ["https://x/a.jpg", "https://x/b.jpg"], brand: "Acme", title: "Planter", handle: "planter",
      description_html: "<p>x</p>", category: "Home & Garden > Planters", tags: ["a"], attributes: {},
      variants: [
        { sku: "A-20", options: { size: "20 cm" }, price_cents: 2499, currency: "EUR", weight_grams: 1800 },
        { sku: "A-30", options: { size: "30 cm" }, price_cents: 3499, currency: "EUR", weight_grams: 2500 },
      ],
      claims: [], confidence: {}, status: "approved", review_reason: null, source_rows: [1], seo: { title: "t", description: "d" },
    };
    const rows = toShopifyCsvRows([p]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.["Option1 Name"]).toBe("Size");
    expect(rows[1]?.["Variant Price"]).toBe("34.99");
    expect(rows[1]?.Title).toBe("");
    expect(rows[2]?.["Image Position"]).toBe(2);
  });
  test("slugify", () => {
    expect(slugify("Größe Übertopf – Terracotta 20cm!")).toBe("grosse-ubertopf-terracotta-20cm");
    expect(slugify("!!!")).toBe("product");
  });
});

describe("claim support", () => {
  test("a hyphenated negation word is part of the claim, not a negation of it", () => {
    expect(claimSupportedByQuote("non-slip backing", "Non-slip PVC backing.").ok).toBe(true);
    expect(claimSupportedByQuote("non-toxic", "Non-toxic paint.").ok).toBe(true);
  });
  test("standalone negations still reject the claim", () => {
    expect(claimSupportedByQuote("drainage hole", "No drainage hole").reason).toBe("Source negates this claim");
    expect(claimSupportedByQuote("frost-proof", "not frost-proof").reason).toBe("Source negates this claim");
    expect(claimSupportedByQuote("frost-proof", "frost-resistant (not frost-proof)").reason).toBe("Source negates this claim");
  });
});
