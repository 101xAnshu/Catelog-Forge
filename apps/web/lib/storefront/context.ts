import { cookies, headers } from "next/headers";
import { COUNTRY_COOKIE, intlLocale, normalizeCountry, resolveLocale, resolveStore, type StoreLocale, type StoreRef } from "./locale";

export interface StoreContext {
  store: StoreRef;
  country: string | null;
  locale: StoreLocale;
  intl: string;
  /** query string carrying `?store=` and an explicit `?country=` through links ("" or "?…") */
  qs: string;
  /** builds a storefront URL that keeps store + country and adds `extra` params */
  href: (path: string, extra?: Record<string, string | number | null | undefined>) => string;
}

/**
 * The country comes from `?country=XX` (the switcher), then the cookie it sets, then the CDN geo header;
 * countries without a translation see English. The path never encodes the country, so switching it keeps
 * the shopper on the same page.
 */
export async function getStoreContext(countryParam: string | undefined, storeSlug: string | undefined): Promise<StoreContext | null> {
  const store = await resolveStore(storeSlug);
  if (!store) return null;
  const [h, c] = await Promise.all([headers(), cookies()]);
  const geo = h.get("x-vercel-ip-country") ?? h.get("cf-ipcountry");
  const explicit = normalizeCountry(countryParam);
  const { country, locale } = await resolveLocale(store.id, explicit ?? "auto", { geoHeader: geo, cookie: c.get(COUNTRY_COOKIE)?.value });

  const keep = new URLSearchParams();
  if (storeSlug) keep.set("store", storeSlug);
  if (explicit) keep.set("country", explicit);
  const href = (path: string, extra: Record<string, string | number | null | undefined> = {}) => {
    const u = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined || v === "") u.delete(k);
      else u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `${path}?${s}` : path;
  };
  return { store, country, locale, intl: intlLocale(locale, country), qs: keep.size ? `?${keep.toString()}` : "", href };
}

export const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
