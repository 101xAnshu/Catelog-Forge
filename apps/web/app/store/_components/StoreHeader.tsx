import Link from "next/link";
import type { StoreContext } from "@/lib/storefront/context";
import { t } from "@/lib/storefront/i18n";
import { CountrySwitcher } from "./CountrySwitcher";

export function StoreHeader({ ctx }: { ctx: StoreContext }) {
  const s = t(ctx.locale);
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href={ctx.href("/store")} className="text-lg font-semibold tracking-tight">
          {ctx.store.name}
        </Link>
        <CountrySwitcher current={ctx.country} label={s.shipTo} />
      </div>
    </header>
  );
}

export function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-2 text-muted" aria-label={label}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    </div>
  );
}
