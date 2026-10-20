import { describe, expect, test } from "bun:test";
import { cleanRow, detectHeaders, groupRows, matchPhotos, type CleanedRow } from "../src";

const H = ["SKU", "Name", "Price", "Size", "Colour", "Description", "Notes", "Image"];
const header = detectHeaders([H]);
const row = (n: number, cells: string[]): CleanedRow => cleanRow(cells, header, n, { defaultCurrency: "EUR" });

describe("groupRows", () => {
  const rows = [
    row(14, ["TC-PL-20", "Terracotta Planter 20cm", "24,99 €", "20 cm", "terracota", "<p>Hand-thrown planter.</p>", "frost-resistant (not frost-proof, bring indoors below 0 °C)", ""]),
    row(15, ["TC-PL-30", "Terracotta Planter 30cm", "", "30 cm", "terracotta", "", "", ""]),
    row(16, ["ST-BW-01", "Stone Bird Bath", "49.00", "", "grey", "Cast stone bird bath", "", "birdbath.jpg"]),
    row(212, ["TC-PL-20", "Terracotta Planter 20cm", "24,99 €", "20 cm", "terracota", "<p>Hand-thrown planter.</p>", "frost-resistant (not frost-proof, bring indoors below 0 °C)", ""]),
    row(300, ["ST-BW-01", "Stone Bird Bath", "59.00", "", "grey", "", "", ""]),
  ];
  const groups = groupRows(rows, { defaultCurrency: "EUR" });
  const planter = groups.find((g) => g.productKey === "sku:TC-PL");
  const bath = groups.find((g) => g.productKey === "sku:ST-BW-01");

  test("split and out-of-order rows grouped into products with variants", () => {
    expect(groups).toHaveLength(2);
    expect(planter?.rows.map((r) => r.rowNumber)).toEqual([14, 15, 212]);
    expect(planter?.variants.map((v) => v.options.size)).toEqual(["20 cm", "30 cm"]);
    expect(planter?.optionNames).toEqual(["size"]);
  });
  test("exact duplicate merged and reported", () => {
    expect(planter?.issues.some((i) => i.code === "DUPLICATE_ROW")).toBe(true);
    expect(planter?.variants[0]?.sourceRows).toEqual([14, 212]);
  });
  test("missing variant price is an error", () => {
    const missing = planter?.issues.find((i) => i.code === "PRICE_MISSING");
    expect(missing?.message).toBe("No price for size 30 cm");
    expect(missing?.severity).toBe("error");
  });
  test("conflicting price on same SKU is an error with both rows", () => {
    const c = bath?.issues.find((i) => i.code === "PRICE_CONFLICT");
    expect(c?.rows).toEqual([16, 300]);
  });
  test("deterministic keys and hashes", () => {
    const again = groupRows([...rows].reverse(), { defaultCurrency: "EUR" });
    expect(again.map((g) => [g.productKey, g.inputHash]).sort()).toEqual(groups.map((g) => [g.productKey, g.inputHash]).sort());
  });
  test("split row without SKU joins by name", () => {
    const g = groupRows(
      [row(1, ["OAK-CB-1", "Oak Cutting Board", "30", "", "", "", "", ""]), row(2, ["", "Oak Cutting Board", "", "", "", "Solid oak board", "", ""])],
      { defaultCurrency: "EUR" },
    );
    expect(g).toHaveLength(1);
    expect(g[0]?.variants).toHaveLength(1);
    expect(g[0]?.issues.some((i) => i.code === "SKU_MISSING")).toBe(false);
  });
  test("different products with different SKU bases stay separate", () => {
    const g = groupRows(
      [row(1, ["AA-PL-20", "Planter", "10", "20 cm", "", "", "", ""]), row(2, ["BB-PL-20", "Planter", "12", "20 cm", "", "", "", ""])],
      { defaultCurrency: "EUR" },
    );
    expect(g).toHaveLength(2);
  });

  test("photo matching", () => {
    const matches = matchPhotos(
      [
        { id: "a", filename: "photos/TC-PL-20_1.jpg", sha256: "1" },
        { id: "b", filename: "birdbath.jpg", sha256: "2" },
        { id: "c", filename: "random-cat.png", sha256: "3" },
        { id: "d", filename: "__MACOSX/._TC-PL-20.jpg", sha256: "4" },
        { id: "e", filename: "stone bird bath.jpg", sha256: "5" },
      ],
      groups,
    );
    const by = Object.fromEntries(matches.map((m) => [m.assetId, m]));
    expect(by.a?.productKey).toBe("sku:TC-PL");
    expect(by.a?.method).toBe("sku");
    expect(by.b?.method).toBe("image_column");
    expect(by.c?.productKey).toBeNull();
    expect(by.d?.reason).toBe("System file ignored");
    expect(by.e?.method).toBe("name");
  });
});
