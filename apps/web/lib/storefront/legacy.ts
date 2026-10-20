/** Old country-in-path URLs (/store/de/...) become /store/...?country=DE; `auto` just drops the segment. */
export function legacyStoreUrl(path: string, country: string, sp: Record<string, string | string[] | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") u.set(k, v);
  }
  if (/^[a-z]{2}$/i.test(country)) u.set("country", country.toUpperCase());
  const s = u.toString();
  return s ? `${path}?${s}` : path;
}
