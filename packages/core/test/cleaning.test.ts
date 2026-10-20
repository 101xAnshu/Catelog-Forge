import { describe, expect, test } from "bun:test";
import {
  cleanText, decodeText, detectHeaders, detectLanguage, normalizeColor, normalizeSize, parseLength, parsePrice,
  parseWeight, sanitizeDescription, cleanRow, fixMojibake,
} from "../src";

describe("parsePrice", () => {
  const cases: Array<[string | number | null, number | null, string | null]> = [
    ["1.299,00 €", 129900, "EUR"],
    ["1,299.00", 129900, "EUR"],
    ["12.5", 1250, "EUR"],
    ["£8", 800, "GBP"],
    ["EUR 12", 1200, "EUR"],
    ["12,-", 1200, "EUR"],
    ["24,99", 2499, "EUR"],
    ["1 299,00 €", 129900, "EUR"],
    ["1'299.50 CHF", 129950, "CHF"],
    ["USD 19.99", 1999, "USD"],
    [19.99, 1999, "EUR"],
    ["20.990000000000002", 2099, "EUR"],
    ["6.1899999999999995", 619, "EUR"],
    [33.989999999999995, 3399, "EUR"],
    ["$5", 500, "EUR"],
    ["", null, null],
    [null, null, null],
    ["-5", null, null],
    ["0,00", null, null],
    ["abc", null, null],
    ["99999999", null, null],
  ];
  for (const [input, cents, currency] of cases) {
    test(`${JSON.stringify(input)} → ${cents} ${currency}`, () => {
      const r = parsePrice(input, { defaultCurrency: "EUR" });
      expect(r.money?.cents ?? null).toBe(cents);
      expect(r.money?.currency ?? null).toBe(currency);
      if (cents === null) expect(r.issues.some((i) => i.severity === "error")).toBe(true);
    });
  }
  test("ambiguous $ is flagged", () => {
    expect(parsePrice("$5", { defaultCurrency: "EUR" }).issues[0]?.code).toBe("CURRENCY_AMBIGUOUS");
  });
  test("currency column wins", () => {
    expect(parsePrice("12,50", { defaultCurrency: "EUR", currencyHint: "GBP" }).money).toEqual({ cents: 1250, currency: "GBP" });
  });
  test("integer cents, never floats", () => {
    expect(Number.isInteger(parsePrice("0.29", { defaultCurrency: "EUR" }).money?.cents)).toBe(true);
    expect(parsePrice("0.29", { defaultCurrency: "EUR" }).money?.cents).toBe(29);
  });
});

describe("units", () => {
  test.each([
    ["20cm", "20 cm"], ["8\"", "20.3 cm"], ["8 in", "20.3 cm"], ["200 mm", "20 cm"], ["Ø 25 cm", "25 cm"], ["M", "M"], ["large", "Large"],
  ])("size %s → %s", (input, expected) => {
    expect(normalizeSize(input).value).toBe(expected);
  });
  test.each([
    ["1.8 kg", 1800], ["1,8kg", 1800], ["4 lbs", 1814], ["500 g", 500], ["10 oz", 283],
  ])("weight %s → %d g", (input, grams) => {
    expect(parseWeight(input).grams).toBe(grams);
  });
  test("weight unit from hint", () => expect(parseWeight("2", "kg").grams).toBe(2000));
  test("implausible weight flagged", () => expect(parseWeight("5000 kg").issues.some((i) => i.code === "WEIGHT_IMPLAUSIBLE")).toBe(true));
  test("bare length with default unit", () => expect(parseLength("12", "size", "in").display).toBe("30.5 cm"));
});

describe("encoding", () => {
  test("mojibake repaired", () => {
    expect(fixMojibake("GrÃ¶ÃŸe")).toBe("Größe");
    expect(cleanText("TerrakottatÃ¶pfe").value).toBe("Terrakottatöpfe");
  });
  test("clean text untouched", () => expect(fixMojibake("Größe")).toBeNull());
  test("windows-1252 buffer decoded", () => {
    const buf = new Uint8Array([0x47, 0x72, 0xf6, 0xdf, 0x65]); // "Größe" in cp1252
    expect(decodeText(buf)).toEqual({ text: "Größe", encoding: "windows-1252" });
  });
  test("BOM stripped", () => expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])).text).toBe("a"));
});

describe("html", () => {
  test("strips script, handlers, iframes, styles", () => {
    const out = sanitizeDescription(`<p onclick="x()">Hi<script>alert(1)</script></p><img src=x onerror=alert(1)><iframe src="e"></iframe><a href="javascript:x">l</a><b style="color:red">b</b>`);
    expect(out).not.toMatch(/script|onerror|onclick|iframe|javascript|style|<img|<a/);
    expect(out).toContain("<p>Hi</p>");
    expect(out).toContain("<b>b</b>");
  });
});

describe("colour", () => {
  test.each([
    ["terracota", "terracotta"], ["Terracotta", "terracotta"], ["rot", "red"], ["Anthrazit", "anthracite"], ["gray", "grey"], ["noir", "black"],
  ])("%s → %s", (input, expected) => expect(normalizeColor(input).value).toBe(expected));
  test("typo fix recorded", () => expect(normalizeColor("terracota").issues[0]?.code).toBe("COLOR_TYPO_FIXED"));
});

describe("language", () => {
  test("german", () => expect(detectLanguage("Handgefertigter Topf aus Terrakotta, nicht frostfest")).toBe("de"));
  test("french", () => expect(detectLanguage("Pot en terre cuite fait main avec trou de drainage")).toBe("fr"));
  test("english", () => expect(detectLanguage("Hand-thrown terracotta planter with a drainage hole")).toBe("en"));
});

describe("headers + cleanRow", () => {
  const rows = [
    ["Supplier export 2026", "", "", ""],
    ["Artikelnummer", "Bezeichnung", "Preis", "Größe (in)", "Farbe", "Gewicht (lbs)", "Notes", "Lieferant Code"],
    ["TC-PL-8", "Terracotta Planter", "1.299,00 €", "8", "terracota", "4", "frost-resistant (not frost-proof, bring indoors below 0 °C)", "X1"],
  ];
  const header = detectHeaders(rows);
  test("finds header row below title row, maps DE synonyms", () => {
    expect(header.headerRowIndex).toBe(1);
    expect(header.columns.map((c) => c.field)).toEqual(["sku", "name", "price", "size", "color", "weight", "notes", null]);
  });
  test("cleanRow normalises everything", () => {
    const r = cleanRow(rows[2] as string[], header, 3, { defaultCurrency: "EUR" });
    expect(r.sku).toBe("TC-PL-8");
    expect(r.priceCents).toBe(129900);
    expect(r.currency).toBe("EUR");
    expect(r.size).toBe("20.3 cm");
    expect(r.color).toBe("terracotta");
    expect(r.weightGrams).toBe(1814);
    expect(r.extra["Lieferant Code"]).toBe("X1");
    expect(r.cells.Notes).toContain("not frost-proof");
    expect(r.rowHash).toHaveLength(64);
  });
  test("missing fields are error issues", () => {
    const r = cleanRow(["", "", "", "", "", "", "", ""], header, 4, { defaultCurrency: "EUR" });
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain("SKU_MISSING");
    expect(codes).toContain("NAME_MISSING");
    expect(codes).toContain("PRICE_MISSING");
  });
  test("huge description is truncated", () => {
    const h = detectHeaders([["sku", "name", "description", "price"]]);
    const r = cleanRow(["A1", "Thing", "x ".repeat(6000), "5"], h, 2, { defaultCurrency: "EUR" });
    expect((r.descriptionText ?? "").length).toBeLessThanOrEqual(5000);
    expect(r.issues.some((i) => i.code === "DESCRIPTION_TRUNCATED")).toBe(true);
  });
});
