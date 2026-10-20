import { and, eq, inArray, sql } from "@cf/db/orm";
import { productFields, products, sha256, translations, variants, type ProductStatusDb } from "@cf/db";
import { enqueueTranslate, publishProgress } from "@cf/queue";
import { web } from "./db";
import { HttpError } from "./http";
import { republish } from "./publish";

export interface ProductPatch {
  version: number;
  fields?: Record<string, string>;
  translations?: Array<{ fieldPath: string; locale: "de" | "fr"; value: string }>;
  variants?: Array<{ id: string; priceCents?: number | null; currency?: string | null; sku?: string | null; weightGrams?: number | null }>;
  action?: "approve" | "send_back" | "reject";
  note?: string;
}

function applyFieldToOutput(output: Record<string, unknown>, path: string, value: string): void {
  if (path.startsWith("attributes.")) {
    const attrs = (output.attributes as Record<string, string> | undefined) ?? {};
    attrs[path.slice("attributes.".length)] = value;
    output.attributes = attrs;
  } else if (path === "seo_title" || path === "seo_description") {
    const seo = (output.seo as { title: string; description: string } | undefined) ?? { title: "", description: "" };
    seo[path === "seo_title" ? "title" : "description"] = value;
    output.seo = seo;
  } else if (path === "tags") {
    output.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
  } else {
    output[path] = value;
  }
}

/**
 * Applies a reviewer edit with optimistic locking (EDGE L6). English edits become `origin=manual`
 * and invalidate only that field's translations (EDGE L2); AI translations are re-queued, manual ones
 * are kept and marked out of date (EDGE L3).
 */
export async function patchProduct(storeId: string, id: string, patch: ProductPatch) {
  const db = web().db;
  const changedEnglish: string[] = [];
  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(products)
      .where(and(eq(products.storeId, storeId), eq(products.id, id)))
      .for("update")
      .limit(1);
    if (!current || current.deletedAt) throw new HttpError(404, "NOT_FOUND", "Product not found.");
    if (current.version !== patch.version) {
      throw new HttpError(409, "VERSION_CONFLICT", "This product was changed by someone else (or by a re-import). Reload to see the latest version.");
    }

    const output = structuredClone((current.output ?? {}) as Record<string, unknown>);
    let title = current.title;
    let category = current.category;

    for (const [fieldPath, rawValue] of Object.entries(patch.fields ?? {})) {
      const value = rawValue.trim();
      const hash = sha256(value);
      const [existing] = await tx
        .select({ sourceHash: productFields.sourceHash, value: productFields.value })
        .from(productFields)
        .where(and(eq(productFields.productId, id), eq(productFields.fieldPath, fieldPath)))
        .limit(1);
      if (existing && existing.sourceHash === hash) continue;
      await tx
        .insert(productFields)
        .values({ productId: id, storeId, fieldPath, value, origin: "manual", sourceHash: hash, confidence: 100 })
        .onConflictDoUpdate({
          target: [productFields.productId, productFields.fieldPath],
          set: { value, origin: "manual", sourceHash: hash, confidence: 100, updatedAt: new Date() },
        });
      applyFieldToOutput(output, fieldPath, value);
      if (fieldPath === "title") title = value;
      if (fieldPath === "category") category = value;
      if (fieldPath !== "category" && fieldPath !== "tags") changedEnglish.push(fieldPath);
    }

    if (changedEnglish.length) {
      await tx
        .update(translations)
        .set({ state: sql`case when ${translations.origin} = 'manual' then 'out_of_date' else 'pending' end`, updatedAt: new Date() })
        .where(and(eq(translations.productId, id), inArray(translations.fieldPath, changedEnglish)));
    }

    for (const t of patch.translations ?? []) {
      const [src] = await tx
        .select({ sourceHash: productFields.sourceHash })
        .from(productFields)
        .where(and(eq(productFields.productId, id), eq(productFields.fieldPath, t.fieldPath)))
        .limit(1);
      await tx
        .insert(translations)
        .values({ productId: id, storeId, fieldPath: t.fieldPath, locale: t.locale, value: t.value, origin: "manual", state: "fresh", sourceHash: src?.sourceHash ?? null })
        .onConflictDoUpdate({
          target: [translations.productId, translations.fieldPath, translations.locale],
          set: { value: t.value, origin: "manual", state: "fresh", sourceHash: src?.sourceHash ?? null, error: null, updatedAt: new Date() },
        });
    }

    for (const v of patch.variants ?? []) {
      if (v.priceCents !== undefined && v.priceCents !== null && (!Number.isInteger(v.priceCents) || v.priceCents <= 0)) {
        throw new HttpError(400, "INVALID_PRICE", "Prices must be positive whole cents.");
      }
      if (v.currency && !/^[A-Z]{3}$/.test(v.currency)) throw new HttpError(400, "INVALID_CURRENCY", "Currency must be a 3-letter ISO code.");
      const set: Partial<typeof variants.$inferInsert> = {};
      if (v.priceCents !== undefined) set.priceCents = v.priceCents;
      if (v.currency !== undefined) set.currency = v.currency;
      if (v.sku !== undefined) set.sku = v.sku?.trim() || null;
      if (v.weightGrams !== undefined) set.weightGrams = v.weightGrams;
      if (Object.keys(set).length) {
        try {
          await tx.update(variants).set(set).where(and(eq(variants.id, v.id), eq(variants.productId, id)));
        } catch (e) {
          if (String(e).includes("variants_store_sku_uq")) throw new HttpError(409, "DUPLICATE_SKU", `SKU ${v.sku} is already used by another product.`);
          throw e;
        }
      }
    }
    if (patch.variants?.length) {
      const vs = await tx.select().from(variants).where(eq(variants.productId, id)).orderBy(variants.position);
      output.variants = vs.map((v) => ({ sku: v.sku, options: v.options, price_cents: v.priceCents, currency: v.currency, weight_grams: v.weightGrams }));
    }

    let status: ProductStatusDb = current.status;
    let reviewNote = current.reviewNote;
    let approvedAt = current.approvedAt;
    if (patch.action === "approve") {
      const vs = await tx.select({ priceCents: variants.priceCents }).from(variants).where(eq(variants.productId, id));
      if (vs.length === 0 || vs.some((v) => v.priceCents === null)) {
        throw new HttpError(422, "CANNOT_APPROVE", "Every variant needs a price before approval.");
      }
      status = "approved";
      approvedAt = new Date();
    } else if (patch.action === "send_back") {
      status = "needs_review";
      reviewNote = patch.note?.slice(0, 1000) ?? null;
      approvedAt = null;
    } else if (patch.action === "reject") {
      status = "rejected";
      reviewNote = patch.note?.slice(0, 1000) ?? null;
      approvedAt = null;
    }
    output.status = status;
    output.title = title ?? output.title;

    const [updated] = await tx
      .update(products)
      .set({ status, reviewNote, approvedAt, title, category, output: output as never, version: current.version + 1, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning({ version: products.version, status: products.status });
    return updated;
  });

  if (changedEnglish.length) {
    await enqueueTranslate({ storeId, importId: null, productIds: [id] }, `edit:${id}:${result?.version ?? Date.now()}`);
  }
  await republish(storeId, [id]);
  await publishProgress(storeId, { type: "product", productId: id, status: result?.status }).catch(() => undefined);
  return result;
}

export async function softDeleteProduct(storeId: string, id: string): Promise<void> {
  const db = web().db;
  const [row] = await db
    .update(products)
    .set({ deletedAt: new Date(), status: "archived", version: sql`${products.version} + 1`, updatedAt: new Date() })
    .where(and(eq(products.storeId, storeId), eq(products.id, id)))
    .returning({ id: products.id });
  if (!row) throw new HttpError(404, "NOT_FOUND", "Product not found.");
  await republish(storeId, [id]);
}
