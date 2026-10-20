import type { Issue } from "./cleaning/issues";
import type { Lang } from "./cleaning/language";

/** Canonical columns we understand; anything else is kept in `extra`. */
export type CanonicalField =
  | "sku" | "parent_sku" | "name" | "brand" | "description" | "price" | "currency" | "size" | "color"
  | "material" | "weight" | "weight_unit" | "dimensions" | "category" | "notes" | "image" | "tags";

/** column index → canonical field (or null when unknown), plus the original header text. */
export interface HeaderMap {
  headerRowIndex: number;
  columns: Array<{ index: number; header: string; field: CanonicalField | null }>;
}

/** One sheet row after deterministic cleaning. Every value keeps its source column for claim citations. */
export interface CleanedRow {
  rowNumber: number; // 1-based row number as the merchant sees it in the sheet
  sku: string | null;
  parentSku: string | null;
  name: string | null;
  brand: string | null;
  descriptionHtml: string | null; // sanitized
  descriptionText: string | null;
  priceCents: number | null;
  currency: string | null;
  size: string | null; // normalised, e.g. "20 cm" or "M"
  color: string | null; // canonical colour
  material: string | null;
  weightGrams: number | null;
  dimensions: string | null;
  category: string | null;
  notes: string | null;
  imageRef: string | null;
  tags: string[];
  extra: Record<string, string>; // unknown columns, header → value
  /** header → cleaned text value for every non-empty cell; used to verify claim quotes */
  cells: Record<string, string>;
  language: Lang;
  issues: Issue[];
  rowHash: string; // stable hash of cleaned values (duplicate detection, change detection)
}

export interface VariantDraft {
  sku: string | null;
  options: Record<string, string>; // { size: "20 cm", color: "terracotta" }
  priceCents: number | null;
  currency: string | null;
  weightGrams: number | null;
  sourceRows: number[];
}

/** A product assembled from one or more rows, before AI enrichment. */
export interface ProductGroup {
  productKey: string; // stable across re-uploads: "sku:TC-PL" or "name:<brand>|<name>"
  rows: CleanedRow[];
  variants: VariantDraft[];
  optionNames: string[];
  issues: Issue[]; // group-level: conflicts, missing price per variant, mixed currency...
  /** sha256 over the cleaned rows + matched photo hashes; unchanged → skip AI on re-upload */
  inputHash: string;
  photoKeys: string[];
  messiness: number; // 0..100, drives model routing
}

export interface AssetRef {
  id: string;
  filename: string;
  sha256: string;
}

export interface PhotoMatch {
  assetId: string;
  productKey: string | null;
  method: "sku" | "image_column" | "name" | null;
  reason?: string; // when unmatched/ambiguous
}

export type ProductStatus = "processing" | "needs_review" | "approved" | "rejected" | "failed" | "archived";
export type RowStatus = "pending" | "grouped" | "done" | "needs_review" | "failed";
export type Locale = "en" | "de" | "fr";
export const LOCALES: Locale[] = ["en", "de", "fr"];
export const TARGET_LOCALES: Exclude<Locale, "en">[] = ["de", "fr"];
