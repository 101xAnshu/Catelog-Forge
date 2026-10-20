import { z } from "zod";

/** What we ask the model to return per product (numbers for prices/weights come from cleaning, not AI). */
export const AiClaimSchema = z.object({
  text: z.string().min(1),
  /** verbatim substring of the cited cell */
  quote: z.string().min(1),
  row: z.number().int(),
  column: z.string().min(1),
});

export const AiProductSchema = z.object({
  id: z.string(), // echoes the product id we sent, guards against batch mix-ups
  title: z.string().min(1).max(200),
  description_html: z.string().max(10000),
  category: z.string().min(1),
  tags: z.array(z.string()).max(20),
  attributes: z.record(z.string(), z.string()),
  seo_title: z.string().max(120).optional().default(""),
  seo_description: z.string().max(320).optional().default(""),
  claims: z.array(AiClaimSchema).default([]),
  confidence: z.record(z.string(), z.number().min(0).max(100)),
  needs_review: z.boolean().default(false),
  review_reason: z.string().nullable().optional(),
});

export const AiBatchResponseSchema = z.object({ products: z.array(AiProductSchema) });

export type AiClaim = z.infer<typeof AiClaimSchema>;
export type AiProduct = z.infer<typeof AiProductSchema>;

/** Final product shape (matches the brief's format) stored on the product and used for exports. */
export interface ProductOutput {
  title: string;
  handle: string;
  description_html: string;
  category: string;
  tags: string[];
  attributes: Record<string, string>;
  variants: Array<{
    sku: string | null;
    options: Record<string, string>;
    price_cents: number | null;
    currency: string | null;
    weight_grams: number | null;
  }>;
  claims: Array<{ text: string; source: string; quote: string; verified: boolean }>;
  confidence: Record<string, number>;
  status: "needs_review" | "approved" | "processing" | "failed" | "rejected";
  review_reason: string | null;
  source_rows: number[];
  seo: { title: string; description: string };
}

/** Translation request/response: masked text keyed by field path. */
export const AiTranslationResponseSchema = z.object({
  items: z.array(z.object({ key: z.string(), text: z.string() })),
});
