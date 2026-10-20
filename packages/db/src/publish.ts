import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Db } from "./client";
import {
  assets, claims, productFields, products, storefrontProducts, translations, variants, type StorefrontPayload,
} from "./schema";

const LOCALES = ["en", "de", "fr"] as const;
const TEXT_FIELDS = ["title", "description_html", "seo_title", "seo_description"] as const;

/**
 * Rebuilds the read-only storefront snapshot for one product (one row per locale).
 * Unapproved, deleted or missing products are removed, so the storefront never shows them (F1).
 * Missing translations fall back to English per field (F2). Called after builds, translations and edits.
 */
export async function publishProduct(db: Db, productId: string): Promise<"published" | "unpublished"> {
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product || product.status !== "approved" || product.deletedAt) {
    await db.delete(storefrontProducts).where(eq(storefrontProducts.productId, productId));
    return "unpublished";
  }

  const [fieldRows, trRows, variantRows, assetRows, claimRows] = await Promise.all([
    db.select().from(productFields).where(eq(productFields.productId, productId)),
    db.select().from(translations).where(and(eq(translations.productId, productId), isNotNull(translations.value))),
    db.select().from(variants).where(eq(variants.productId, productId)).orderBy(variants.position),
    db.select().from(assets).where(and(eq(assets.productId, productId), eq(assets.status, "ok"))).orderBy(assets.filename),
    db.select().from(claims).where(and(eq(claims.productId, productId), eq(claims.verified, true))),
  ]);

  const english = new Map(fieldRows.map((f) => [f.fieldPath, f.value]));
  const images = assetRows.filter((a) => a.thumbKey).map((a) => `/api/files/${a.thumbKey}`);
  const priced = variantRows.filter((v) => v.priceCents !== null);
  const cheapest = priced.sort((a, b) => (a.priceCents ?? 0) - (b.priceCents ?? 0))[0];
  const optionNames = Array.from(new Set(variantRows.flatMap((v) => Object.keys(v.options))));
  const output = product.output;

  await db.transaction(async (tx) => {
    for (const locale of LOCALES) {
      const localized = new Map<string, string>();
      if (locale !== "en") {
        for (const t of trRows) {
          if (t.locale === locale && t.value && t.state !== "missing" && t.state !== "pending") localized.set(t.fieldPath, t.value);
        }
      }
      const pick = (field: string): string => localized.get(field) ?? english.get(field) ?? "";
      const attributes: Record<string, string> = {};
      for (const key of english.keys()) {
        if (key.startsWith("attributes.")) attributes[key.slice(11)] = pick(key);
      }
      const payload: StorefrontPayload = {
        title: pick("title") || product.title || product.handle,
        descriptionHtml: pick("description_html"),
        category: product.category,
        tags: output?.tags ?? [],
        attributes,
        claims: claimRows.map((c) => c.text),
        images,
        seo: { title: pick("seo_title") || pick("title"), description: pick("seo_description") },
        variants: variantRows.map((v) => ({ sku: v.sku, options: v.options, priceCents: v.priceCents, currency: v.currency })),
        optionNames,
        translatedFields: [...TEXT_FIELDS, ...[...english.keys()].filter((k) => k.startsWith("attributes."))].filter((f) => localized.has(f)),
      };
      await tx
        .insert(storefrontProducts)
        .values({
          storeId: product.storeId,
          locale,
          handle: product.handle,
          productId,
          category: product.category,
          title: payload.title,
          priceFromCents: cheapest?.priceCents ?? null,
          currency: cheapest?.currency ?? null,
          thumbUrl: images[0] ?? null,
          payload,
          publishedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [storefrontProducts.storeId, storefrontProducts.locale, storefrontProducts.handle],
          set: {
            productId,
            category: product.category,
            title: payload.title,
            priceFromCents: cheapest?.priceCents ?? null,
            currency: cheapest?.currency ?? null,
            thumbUrl: images[0] ?? null,
            payload,
            publishedAt: new Date(),
          },
        });
    }
    // Handle changed since last publish: drop rows under the old handle.
    await tx
      .delete(storefrontProducts)
      .where(and(eq(storefrontProducts.productId, productId), ne(storefrontProducts.handle, product.handle)));
  });
  return "published";
}

/** Convenience for bulk approve: publish many products sequentially. */
export async function publishProducts(db: Db, productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  const existing = await db.select({ id: products.id }).from(products).where(inArray(products.id, productIds));
  for (const p of existing) await publishProduct(db, p.id);
}
