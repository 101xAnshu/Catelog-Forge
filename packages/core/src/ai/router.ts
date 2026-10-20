import type { ProductGroup } from "../types";

export type ModelTier = "cheap" | "strong" | "vision";

export const DEFAULT_ROUTING_THRESHOLD = 35;

/**
 * Cheap model for clean rows; strong model for messy ones; vision model only when the text
 * alone cannot describe the product and photos are available.
 */
export function routeModel(
  group: ProductGroup,
  opts: { threshold?: number; forceTier?: ModelTier; hasPhotos: boolean; needVision?: boolean },
): ModelTier {
  if (opts.forceTier) return opts.forceTier === "vision" && !opts.hasPhotos ? "strong" : opts.forceTier;
  const hasText = group.rows.some((r) => (r.descriptionText?.length ?? 0) > 20 || (r.notes?.length ?? 0) > 20);
  if (opts.hasPhotos && (opts.needVision || (!hasText && !group.rows.some((r) => r.material || r.color)))) return "vision";
  return group.messiness >= (opts.threshold ?? DEFAULT_ROUTING_THRESHOLD) ? "strong" : "cheap";
}
