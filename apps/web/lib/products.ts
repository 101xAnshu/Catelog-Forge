import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "@cf/db/orm";
import { assets, claims, importRows, productFields, products, translations, variants } from "@cf/db";
import { web } from "./db";

export const PAGE_SIZES = [10, 25, 50, 100] as const;
const SORTS = {
  title: products.title,
  status: products.status,
  min_confidence: products.minConfidence,
  updated_at: products.updatedAt,
  category: products.category,
} as const;

export interface ProductQuery {
  page: number;
  pageSize: number;
  sort: keyof typeof SORTS;
  dir: "asc" | "desc";
  q?: string;
  status?: string[];
  confidence?: "high" | "medium" | "low";
  importId?: string;
  category?: string;
  translation?: "out_of_date" | "missing" | "manual";
}

export function parseProductQuery(url: URL): ProductQuery {
  const p = url.searchParams;
  const size = Number(p.get("pageSize") ?? 25);
  const sort = (p.get("sort") ?? "updated_at") as keyof typeof SORTS;
  return {
    page: Math.max(1, Number(p.get("page") ?? 1) || 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : 25,
    sort: sort in SORTS ? sort : "updated_at",
    dir: p.get("dir") === "asc" ? "asc" : "desc",
    q: p.get("q")?.trim() || undefined,
    status: p.get("status")?.split(",").filter(Boolean),
    confidence: (["high", "medium", "low"] as const).find((c) => c === p.get("confidence")),
    importId: p.get("importId") || undefined,
    category: p.get("category") || undefined,
    translation: (["out_of_date", "missing", "manual"] as const).find((t) => t === p.get("translation")),
  };
}

export function productWhere(storeId: string, q: Omit<ProductQuery, "page" | "pageSize" | "sort" | "dir">): SQL {
  const conds: Array<SQL | undefined> = [eq(products.storeId, storeId), isNull(products.deletedAt)];
  if (q.status?.length) conds.push(inArray(products.status, q.status as Array<typeof products.$inferSelect.status>));
  if (q.confidence === "high") conds.push(sql`${products.minConfidence} >= 85`);
  if (q.confidence === "medium") conds.push(sql`${products.minConfidence} >= 70 and ${products.minConfidence} < 85`);
  if (q.confidence === "low") conds.push(sql`${products.minConfidence} < 70`);
  if (q.category) conds.push(ilike(products.category, `${q.category}%`));
  if (q.importId) {
    conds.push(sql`exists (select 1 from ${importRows} ir where ir.product_id = ${products.id} and ir.import_id = ${q.importId})`);
  }
  if (q.translation === "manual") {
    conds.push(sql`exists (select 1 from ${translations} t where t.product_id = ${products.id} and t.origin = 'manual')`);
  } else if (q.translation) {
    conds.push(sql`exists (select 1 from ${translations} t where t.product_id = ${products.id} and t.state = ${q.translation})`);
  }
  if (q.q) {
    const like = `%${q.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(
      or(
        ilike(products.title, like),
        ilike(products.handle, like),
        sql`exists (select 1 from ${variants} v where v.product_id = ${products.id} and v.sku ilike ${like})`,
      ),
    );
  }
  return and(...conds) as SQL;
}

export async function listProducts(storeId: string, q: ProductQuery) {
  const db = web().db;
  const where = productWhere(storeId, q);
  const col = SORTS[q.sort];
  const order = q.dir === "asc" ? asc(col) : desc(col);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: products.id,
        handle: products.handle,
        title: products.title,
        status: products.status,
        category: products.category,
        minConfidence: products.minConfidence,
        reviewReasons: products.reviewReasons,
        updatedAt: products.updatedAt,
        model: products.model,
        version: products.version,
        variantCount: sql<number>`(select count(*)::int from ${variants} v where v.product_id = ${products.id})`,
        firstSku: sql<string | null>`(select v.sku from ${variants} v where v.product_id = ${products.id} order by v.position limit 1)`,
        priceFrom: sql<number | null>`(select min(v.price_cents)::int from ${variants} v where v.product_id = ${products.id})`,
        currency: sql<string | null>`(select v.currency from ${variants} v where v.product_id = ${products.id} and v.currency is not null limit 1)`,
        thumbKey: sql<string | null>`(select a.thumb_key from ${assets} a where a.product_id = ${products.id} and a.status = 'ok' order by a.filename limit 1)`,
        staleTranslations: sql<number>`(select count(*)::int from ${translations} t where t.product_id = ${products.id} and t.state in ('out_of_date','missing'))`,
      })
      .from(products)
      .where(where)
      .orderBy(order, desc(products.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(products).where(where),
  ]);
  return { rows, total: count?.n ?? 0 };
}

export async function getProductDetail(storeId: string, id: string) {
  const db = web().db;
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.storeId, storeId), eq(products.id, id)))
    .limit(1);
  if (!product) return null;
  const [fields, vars, cls, trs, rows, photos] = await Promise.all([
    db.select().from(productFields).where(eq(productFields.productId, id)).orderBy(productFields.fieldPath),
    db.select().from(variants).where(eq(variants.productId, id)).orderBy(variants.position),
    db.select().from(claims).where(eq(claims.productId, id)),
    db.select().from(translations).where(eq(translations.productId, id)),
    db
      .select({
        importId: importRows.importId,
        rowNumber: importRows.rowNumber,
        raw: importRows.raw,
        issues: importRows.issues,
        status: importRows.status,
        reason: importRows.reason,
      })
      .from(importRows)
      .where(and(eq(importRows.storeId, storeId), eq(importRows.productId, id)))
      .orderBy(desc(importRows.updatedAt), importRows.rowNumber)
      .limit(200),
    db
      .select({ id: assets.id, filename: assets.filename, thumbKey: assets.thumbKey, storageKey: assets.storageKey, matchMethod: assets.matchMethod })
      .from(assets)
      .where(and(eq(assets.storeId, storeId), eq(assets.productId, id), eq(assets.status, "ok")))
      .orderBy(assets.filename),
  ]);
  return { product, fields, variants: vars, claims: cls, translations: trs, sourceRows: rows, photos };
}
