import type { AssetRef, PhotoMatch, ProductGroup } from "../types";

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const tokens = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

function baseName(path: string): string {
  const b = path.split(/[\\/]/).pop() ?? path;
  return b.replace(/\.[a-z0-9]{2,5}$/i, "");
}

export function isSystemFile(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some((p) => p === "__MACOSX" || p.startsWith(".")) || /thumbs\.db$/i.test(path);
}

/**
 * Matches photos to products: SKU in filename (longest wins) → image column → unique name match.
 * Ambiguous or unmatched photos are returned with productKey null and a reason; never guessed.
 */
export function matchPhotos(assets: AssetRef[], groups: ProductGroup[]): PhotoMatch[] {
  const skuIndex: Array<{ key: string; productKey: string }> = [];
  // "PLN-1066" → products whose variant SKUs start with "PLN-1066-" (photo named after the product, not a variant)
  const prefixIndex = new Map<string, Set<string>>();
  const segs = (s: string) => s.toUpperCase().split(/[-_/. ]+/).filter(Boolean);
  const imageIndex = new Map<string, Set<string>>();
  const nameIndex: Array<{ tokens: string[]; productKey: string }> = [];
  for (const g of groups) {
    const skus = new Set<string>();
    for (const v of g.variants) if (v.sku) skus.add(norm(v.sku));
    if (g.productKey.startsWith("sku:")) skus.add(norm(g.productKey.slice(4)));
    for (const s of skus) if (s.length >= 3) skuIndex.push({ key: s, productKey: g.productKey });
    for (const v of g.variants) {
      if (!v.sku) continue;
      const p = segs(v.sku);
      for (let n = 2; n < p.length; n++) {
        const key = p.slice(0, n).join("-");
        const set = prefixIndex.get(key) ?? new Set<string>();
        set.add(g.productKey);
        prefixIndex.set(key, set);
      }
    }
    for (const r of g.rows) {
      if (r.imageRef) {
        for (const ref of r.imageRef.split(/[,;|\s]+/).filter(Boolean)) {
          const k = norm(baseName(ref));
          if (!k) continue;
          const set = imageIndex.get(k) ?? new Set();
          set.add(g.productKey);
          imageIndex.set(k, set);
        }
      }
    }
    const name = g.rows.find((r) => r.name)?.name;
    if (name) {
      const t = tokens(name);
      if (t.length >= 2) nameIndex.push({ tokens: t, productKey: g.productKey });
    }
  }

  return assets.map((a): PhotoMatch => {
    if (isSystemFile(a.filename)) return { assetId: a.id, productKey: null, method: null, reason: "System file ignored" };
    // "planter_2.jpg", "planter (1).jpg" → "planter"
    const fn = norm(baseName(a.filename).replace(/(?:[-_ ]\d{1,2}|\s?\(\d{1,2}\))$/, ""));
    const fnFull = norm(baseName(a.filename));

    // 1. SKU in filename
    const skuHits = skuIndex.filter((s) => fnFull.includes(s.key));
    if (skuHits.length) {
      const maxLen = Math.max(...skuHits.map((s) => s.key.length));
      const best = new Set(skuHits.filter((s) => s.key.length === maxLen).map((s) => s.productKey));
      if (best.size === 1) return { assetId: a.id, productKey: [...best][0] as string, method: "sku" };
      return { assetId: a.id, productKey: null, method: null, reason: `Filename matches several products (${[...best].join(", ")})` };
    }

    // 1b. filename is a SKU prefix of exactly one product ("PLN-1066.jpg", "PLN-1066-2.jpg")
    const base = baseName(a.filename);
    for (const candidate of [segs(base).join("-"), segs(base.replace(/(?:[-_ ]\d{1,2}|\s?\(\d{1,2}\))$/, "")).join("-")]) {
      const owners = prefixIndex.get(candidate);
      if (owners?.size === 1) return { assetId: a.id, productKey: [...owners][0] as string, method: "sku" };
    }

    // 2. image column
    const img = imageIndex.get(fnFull) ?? imageIndex.get(fn);
    if (img) {
      if (img.size === 1) return { assetId: a.id, productKey: [...img][0] as string, method: "image_column" };
      return { assetId: a.id, productKey: null, method: null, reason: "Image is referenced by several products" };
    }

    // 3. unique name match
    const fileTokens = new Set(tokens(baseName(a.filename)));
    const nameHits = [...new Set(nameIndex.filter((n) => n.tokens.every((t) => fileTokens.has(t))).map((n) => n.productKey))];
    if (nameHits.length === 1) return { assetId: a.id, productKey: nameHits[0] as string, method: "name" };
    if (nameHits.length > 1) return { assetId: a.id, productKey: null, method: null, reason: "Filename matches several product names" };

    return { assetId: a.id, productKey: null, method: null, reason: "No product matches this filename" };
  });
}
