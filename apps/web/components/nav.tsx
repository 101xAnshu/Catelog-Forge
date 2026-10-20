"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, ExternalLink, LogOut, Package, Settings, Upload } from "lucide-react";

const TABS = [
  { href: "/upload", label: "Upload", icon: Upload },
  { href: "/products", label: "Products", icon: Package },
  { href: "/metrics", label: "Metrics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav({ stores, storeId, email }: { stores: Array<{ id: string; name: string }>; storeId: string; email: string | null }) {
  const path = usePathname();
  const router = useRouter();

  async function switchStore(id: string) {
    await fetch("/api/auth/store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storeId: id }) });
    router.refresh();
  }
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <Link href="/upload" className="font-semibold tracking-tight">CatalogForge</Link>
        <nav className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
          {TABS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm",
                path.startsWith(href) ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text",
              )}
            >
              <Icon size={15} aria-hidden /> {label}
            </Link>
          ))}
          <a href="/store?country=DE" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted hover:text-text">
            <ExternalLink size={15} aria-hidden /> Storefront
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {stores.length > 1 ? (
            <select aria-label="Store" className="input w-auto py-1" value={storeId} onChange={(e) => void switchStore(e.target.value)}>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : (
            <span className="hidden text-sm text-muted sm:inline">{stores[0]?.name}</span>
          )}
          <span className="hidden text-xs text-muted md:inline">{email}</span>
          <button onClick={() => void logout()} className="btn" aria-label="Sign out"><LogOut size={14} /></button>
        </div>
      </div>
    </header>
  );
}
