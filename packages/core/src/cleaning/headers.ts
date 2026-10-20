import type { CanonicalField, HeaderMap } from "../types";

const SYNONYMS: Record<CanonicalField, string[]> = {
  sku: ["sku", "variant sku", "sku variant", "article number", "article no", "artikelnummer", "art nr", "artnr", "art no",
    "item number", "item no", "item code", "product code", "code", "ref", "reference", "référence", "numéro d'article", "supplier sku"],
  parent_sku: ["parent sku", "parent", "product group", "group", "handle", "model", "style", "master sku", "parent id", "modell"],
  name: ["name", "product name", "title", "product title", "produktname", "bezeichnung", "artikelbezeichnung", "artikelname",
    "nom", "nom du produit", "produit", "item", "item name", "product", "designation", "désignation", "titel"],
  brand: ["brand", "marke", "marque", "vendor", "manufacturer", "hersteller", "fabricant"],
  description: ["description", "beschreibung", "desc", "long description", "body", "body html", "details",
    "produktbeschreibung", "description longue", "short description"],
  price: ["price", "preis", "prix", "retail price", "rrp", "unit price", "vk", "vk preis", "verkaufspreis", "msrp", "sale price",
    "price eur", "prix de vente", "uvp"],
  currency: ["currency", "währung", "waehrung", "devise", "curr", "monnaie"],
  size: ["size", "größe", "groesse", "grösse", "grosse", "taille", "diameter", "durchmesser", "diamètre", "dimension"],
  color: ["color", "colour", "farbe", "couleur", "colors", "colours"],
  material: ["material", "matériau", "materiau", "werkstoff", "matière", "matiere"],
  weight: ["weight", "gewicht", "poids", "net weight", "gross weight", "shipping weight", "nettogewicht"],
  weight_unit: ["weight unit", "gewichtseinheit", "unité de poids", "unit"],
  dimensions: ["dimensions", "maße", "masse", "abmessungen", "measurements", "size dimensions"],
  category: ["category", "kategorie", "catégorie", "categorie", "type", "product type", "produkttyp", "warengruppe"],
  notes: ["notes", "note", "hinweise", "hinweis", "remarks", "bemerkung", "bemerkungen", "comments", "supplier notes",
    "care", "pflege", "remarques", "entretien", "care instructions"],
  image: ["image", "image url", "image file", "images", "photo", "photos", "picture", "bild", "bilder", "img", "image src", "filename"],
  tags: ["tags", "keywords", "schlagwörter", "schlagworte", "mots clés", "mots-clés"],
};

const LOOKUP = new Map<string, CanonicalField>();
for (const [field, names] of Object.entries(SYNONYMS) as Array<[CanonicalField, string[]]>) {
  for (const n of names) LOOKUP.set(normalizeHeader(n), field);
}

/** Lower-case, drop "(unit)" suffixes and punctuation: "Weight (lbs)" → "weight". */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[_\-./:#*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Unit written inside a header, e.g. "Weight (kg)" → "kg", "Size [in]" → "in". */
export function headerUnit(h: string): string | null {
  const m = h.match(/[([]\s*([a-zA-Z"″]+)\s*[)\]]/);
  return m ? (m[1] as string).toLowerCase() : null;
}

export function fieldForHeader(h: string): CanonicalField | null {
  const n = normalizeHeader(h);
  if (!n) return null;
  const direct = LOOKUP.get(n);
  if (direct) return direct;
  // "price eur", "preis brutto": first word decides when it is a known synonym
  const first = n.split(" ")[0] ?? "";
  return LOOKUP.get(first) ?? null;
}

/** Finds the header row (title rows above it are skipped) within the first 10 rows. */
export function detectHeaders(rows: string[][]): HeaderMap {
  let best = { index: 0, score: -1 };
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i] ?? [];
    const seen = new Set<CanonicalField>();
    for (const cell of row) {
      const f = fieldForHeader(String(cell ?? ""));
      if (f) seen.add(f);
    }
    if (seen.size > best.score) best = { index: i, score: seen.size };
  }
  const headerRow = rows[best.index] ?? [];
  const used = new Map<string, number>();
  const columns = headerRow.map((raw, index) => {
    let header = String(raw ?? "").trim() || `column_${index + 1}`;
    const count = used.get(header) ?? 0;
    used.set(header, count + 1);
    if (count > 0) header = `${header}_${count + 1}`;
    return { index, header, field: fieldForHeader(header) };
  });
  return { headerRowIndex: best.index, columns };
}
