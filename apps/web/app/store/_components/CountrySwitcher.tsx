"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { SWITCHER_COUNTRIES } from "@/lib/storefront/countries";

/**
 * Changes only `?country=` on the current URL: the shopper stays on the same product or collection
 * page (store, category and page are kept), with no scroll jump and no extra history entries.
 */
export function CountrySwitcher({ current, label }: { current: string | null; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <span className="hidden sm:inline">{label}</span>
      <select
        aria-label={label}
        aria-busy={pending}
        className="input w-auto py-1.5"
        value={current ?? ""}
        onChange={(e) => {
          const code = e.target.value;
          document.cookie = `cf_country=${code}; path=/; max-age=31536000; samesite=lax`;
          const params = new URLSearchParams(window.location.search);
          params.set("country", code);
          startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
        }}
      >
        {!current && <option value="">🌐 International</option>}
        {SWITCHER_COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.flag} {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
