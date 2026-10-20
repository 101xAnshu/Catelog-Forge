import { unstable_cache } from "next/cache";
import { getDb } from "@cf/db";

export type StoreLocale = "en" | "de" | "fr";

export { SWITCHER_COUNTRIES } from "./countries";

export const COUNTRY_COOKIE = "cf_country";

export interface StoreRef {
  id: string;
  name: string;
  slug: string;
  baseCurrency: string;
}

const findStore = unstable_cache(
  async (slug: string | null): Promise<StoreRef | null> => {
    const { sql } = getDb("storefront");
    // Requested slug first, then the demo store, then the oldest store.
    const rows = await sql<StoreRef[]>`
      select id, name, slug, base_currency as "baseCurrency" from stores
      order by (slug = ${slug ?? ""}) desc, (slug = 'demo') desc, created_at asc
      limit 1`;
    return rows[0] ?? null;
  },
  ["storefront-store"],
  { revalidate: 300 },
);

/** `?store=<slug>` selects a store; otherwise the demo store (or the oldest one). */
export async function resolveStore(slug: string | undefined | null): Promise<StoreRef | null> {
  const clean = slug && /^[a-z0-9-]{1,64}$/.test(slug) ? slug : null;
  return findStore(clean);
}

const localeMap = unstable_cache(
  async (storeId: string): Promise<Record<string, StoreLocale>> => {
    const { sql } = getDb("storefront");
    const rows = await sql<Array<{ country: string; locale: StoreLocale }>>`
      select country_code as country, locale from country_locales where store_id = ${storeId}`;
    return Object.fromEntries(rows.map((r) => [r.country.toUpperCase(), r.locale]));
  },
  ["storefront-country-locales"],
  { revalidate: 300 },
);

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/**
 * Country → locale. The URL segment wins; `auto` falls back to the CDN geo header, then the
 * switcher cookie. Countries without a translation (or unknown codes) see English.
 */
export async function resolveLocale(
  storeId: string,
  countryParam: string,
  ctx: { geoHeader?: string | null; cookie?: string | null },
): Promise<{ country: string | null; locale: StoreLocale }> {
  const country =
    countryParam.toLowerCase() === "auto"
      ? normalizeCountry(ctx.geoHeader) ?? normalizeCountry(ctx.cookie)
      : normalizeCountry(countryParam);
  if (!country) return { country: null, locale: "en" };
  const map = await localeMap(storeId);
  return { country, locale: map[country] ?? "en" };
}

/** BCP-47 tag for number/currency formatting, e.g. de-AT, fr-BE, en-US. */
export function intlLocale(locale: StoreLocale, country: string | null): string {
  if (!country) return locale === "en" ? "en-GB" : locale;
  try {
    const tag = `${locale}-${country}`;
    return Intl.NumberFormat.supportedLocalesOf([tag]).length ? tag : locale;
  } catch {
    return locale;
  }
}
