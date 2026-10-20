/** Subset of a Google-style product taxonomy the model must choose from. */
export const CATEGORY_TAXONOMY: string[] = [
  "Home & Garden > Planters",
  "Home & Garden > Plant Pots & Saucers",
  "Home & Garden > Garden Tools",
  "Home & Garden > Watering Cans",
  "Home & Garden > Garden Furniture",
  "Home & Garden > Outdoor Lighting",
  "Home & Garden > Bird Feeders & Houses",
  "Home & Garden > Garden Decor",
  "Home & Garden > Seeds & Bulbs",
  "Home & Garden > Plant Care & Fertilizer",
  "Home & Garden > Decor > Vases",
  "Home & Garden > Decor > Candles & Holders",
  "Home & Garden > Decor > Picture Frames",
  "Home & Garden > Decor > Cushions & Throws",
  "Home & Garden > Decor > Wall Art",
  "Home & Garden > Decor > Baskets & Storage",
  "Home & Garden > Decor > Mirrors",
  "Home & Garden > Decor > Clocks",
  "Home & Garden > Lighting > Lamps",
  "Home & Garden > Lighting > String Lights",
  "Home & Garden > Lighting > Table Lamps",
  "Home & Garden > Furniture > Chairs",
  "Home & Garden > Furniture > Tables",
  "Home & Garden > Outdoor Living",
  "Home & Garden > Kitchen & Dining > Tableware",
  "Home & Garden > Kitchen & Dining > Drinkware",
  "Home & Garden > Kitchen & Dining > Mugs",
  "Home & Garden > Kitchen & Dining > Cutting & Serving Boards",
  "Home & Garden > Kitchen & Dining > Cookware",
  "Home & Garden > Kitchen & Dining > Serveware",
  "Home & Garden > Kitchen & Dining > Kitchen Utensils",
  "Home & Garden > Kitchen & Dining > Food Storage",
  "Home & Garden > Kitchen & Dining > Table Linen",
  "Home & Garden > Bathroom > Bath Accessories",
  "Home & Garden > Bathroom > Towels",
  "Home & Garden > Bedding > Bed Linen",
  "Home & Garden > Bedding > Blankets",
  "Home & Garden > Household Supplies > Cleaning",
  "Home & Garden > Pet Supplies",
  "Apparel & Accessories > Bags",
  "Apparel & Accessories > Hats",
  "Apparel & Accessories > Gloves",
  "Apparel & Accessories > Aprons",
  "Health & Beauty > Personal Care > Soap",
  "Health & Beauty > Personal Care > Skin Care",
  "Toys & Games > Outdoor Toys",
  "Arts & Crafts > Craft Supplies",
  "Office Supplies > Stationery",
  "Uncategorized",
];

/**
 * Supplier/AI category names that mean an existing taxonomy path. Matching is on the lower-cased full path
 * or its last segment, so "Home Decor > Cushions" and "Cushions" both land on the same node without review.
 */
export const CATEGORY_ALIASES: Record<string, string> = {
  "cushions": "Home & Garden > Decor > Cushions & Throws",
  "throws": "Home & Garden > Decor > Cushions & Throws",
  "pillows": "Home & Garden > Decor > Cushions & Throws",
  "candles": "Home & Garden > Decor > Candles & Holders",
  "candle holders": "Home & Garden > Decor > Candles & Holders",
  "vases": "Home & Garden > Decor > Vases",
  "mirrors": "Home & Garden > Decor > Mirrors",
  "baskets": "Home & Garden > Decor > Baskets & Storage",
  "storage": "Home & Garden > Decor > Baskets & Storage",
  "boards": "Home & Garden > Kitchen & Dining > Cutting & Serving Boards",
  "cutting boards": "Home & Garden > Kitchen & Dining > Cutting & Serving Boards",
  "serving boards": "Home & Garden > Kitchen & Dining > Cutting & Serving Boards",
  "mugs": "Home & Garden > Kitchen & Dining > Mugs",
  "cups": "Home & Garden > Kitchen & Dining > Drinkware",
  "table lamps": "Home & Garden > Lighting > Table Lamps",
  "lamps": "Home & Garden > Lighting > Lamps",
  "chairs": "Home & Garden > Furniture > Chairs",
  "tables": "Home & Garden > Furniture > Tables",
  "garden > outdoor": "Home & Garden > Outdoor Living",
  "outdoor": "Home & Garden > Outdoor Living",
  "planters": "Home & Garden > Planters",
  "plant pots": "Home & Garden > Plant Pots & Saucers",
  "pflanztöpfe": "Home & Garden > Planters",
};

/** Canonical taxonomy path for a known alias (full path or last segment), else null. */
export function categoryAlias(category: string): string | null {
  const lc = category.toLowerCase().replace(/\s+/g, " ").trim();
  const leaf = lc.split(">").pop()?.trim() ?? lc;
  return CATEGORY_ALIASES[lc] ?? CATEGORY_ALIASES[leaf] ?? null;
}
