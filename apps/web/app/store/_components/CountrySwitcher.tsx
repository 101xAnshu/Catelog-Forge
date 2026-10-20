"use client";

import { useRouter } from "next/navigation";
import { SWITCHER_COUNTRIES } from "@/lib/storefront/countries";

export function CountrySwitcher({ current, label, qs }: { current: string | null; label: string; qs: string }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <span className="hidden sm:inline">{label}</span>
      <select
        aria-label={label}
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
        value={current ?? ""}
        onChange={(e) => {
          const code = e.target.value;
          document.cookie = `cf_country=${code}; path=/; max-age=31536000; samesite=lax`;
          router.push(`/store/${code.toLowerCase()}${qs}`);
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
