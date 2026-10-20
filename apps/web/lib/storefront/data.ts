import { unstable_cache } from "next/cache";
import { getDb, type StorefrontPayload } from "@cf/db";
import type { StoreLocale } from "./locale";

/**
 * The storefront reads only the denormalised `storefront_products` snapshot through its own
 * small connection pool (2 s statement timeout). It never calls the AI and never touches the
 * import tables, so a running 10k-row import cannot slow these queries down. Every query is
 * served by the (store_id, locale, ...) primary key / list index.
 */

export const PAGE_SIZE = 24;
export const storefrontTag = (storeId: string) => `storefront:${storeId}`;

export interface CollectionItem {
  handle: string;
  title: string;
  category: string | null;
  priceFromCents: number | null;
  currency: string | null;
  thumbUrl: string | null;
}

export interface CollectionPage {
  items: CollectionItem[];
  total: number;
  categories: string[];
}

export function getCollection(storeId: string, locale: StoreLocale, category: string | null, page: number): Promise<CollectionPage> {
  return unstable_cache(
    async (): Promise<CollectionPage> => {
      const { sql } = getDb("storefront");
      const byCategory = category ? sql`and category = ${category}` : sql``;
      const [items, totals, categories] = await Promise.all([
        sql<CollectionItem[]>`
          select handle, title, category, price_from_cents::int as "priceFromCents", currency, thumb_url as "thumbUrl"
          from storefront_products
          where store_id = ${storeId} and locale = ${locale} ${byCategory}
          order by published_at desc, handle asc
          limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`,
        sql<Array<{ n: number }>>`
          select count(*)::int as n from storefront_products
          where store_id = ${storeId} and locale = ${locale} ${byCategory}`,
        sql<Array<{ category: string }>>`
          select distinct category from storefront_products
          where store_id = ${storeId} and locale = ${locale} and category is not null
          order by category limit 50`,
      ]);
      return { items: [...items], total: totals[0]?.n ?? 0, categories: categories.map((c) => c.category) };
    },
    ["storefront-collection", storeId, locale, category ?? "", String(page)],
    { tags: [storefrontTag(storeId)], revalidate: 30 },
  )();
}

export interface ProductPage {
  handle: string;
  payload: StorefrontPayload;
  alternates: StoreLocale[];
}

export function getProduct(storeId: string, locale: StoreLocale, handle: string): Promise<ProductPage | null> {
  return unstable_cache(
    async (): Promise<ProductPage | null> => {
      const { sql } = getDb("storefront");
      // One query returns the requested locale plus which other locales exist (for hreflang).
      const rows = await sql<Array<{ locale: StoreLocale; payload: StorefrontPayload | null }>>`
        select locale, case when locale = ${locale} then payload end as payload
        from storefront_products where store_id = ${storeId} and handle = ${handle}`;
      const own = rows.find((r) => r.locale === locale);
      if (!own?.payload) return null;
      return { handle, payload: own.payload, alternates: rows.map((r) => r.locale) };
    },
    ["storefront-product", storeId, locale, handle],
    { tags: [storefrontTag(storeId)], revalidate: 30 },
  )();
}

export function formatPrice(cents: number | null, currency: string | null, intlLocale: string): string | null {
  if (cents === null || !currency) return null;
  try {
    return new Intl.NumberFormat(intlLocale, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
