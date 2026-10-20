import { cookies, headers } from "next/headers";
import { COUNTRY_COOKIE, intlLocale, resolveLocale, resolveStore, type StoreLocale, type StoreRef } from "./locale";

export interface StoreContext {
  store: StoreRef;
  country: string | null;
  /** URL segment to use in links (`auto` stays `auto` so geo detection keeps working). */
  countrySegment: string;
  locale: StoreLocale;
  intl: string;
  /** query string carrying `?store=` through links */
  qs: string;
}

export async function getStoreContext(countryParam: string, storeSlug: string | undefined): Promise<StoreContext | null> {
  const store = await resolveStore(storeSlug);
  if (!store) return null;
  const [h, c] = await Promise.all([headers(), cookies()]);
  const geo = h.get("x-vercel-ip-country") ?? h.get("cf-ipcountry");
  const { country, locale } = await resolveLocale(store.id, countryParam, { geoHeader: geo, cookie: c.get(COUNTRY_COOKIE)?.value });
  return {
    store,
    country,
    countrySegment: countryParam.toLowerCase() === "auto" ? "auto" : (country ?? "intl").toLowerCase(),
    locale,
    intl: intlLocale(locale, country),
    qs: storeSlug ? `?store=${encodeURIComponent(storeSlug)}` : "",
  };
}

export const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
