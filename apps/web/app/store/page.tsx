/* eslint-disable @next/next/no-img-element */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPrice, getCollection, PAGE_SIZE } from "@/lib/storefront/data";
import { first, getStoreContext } from "@/lib/storefront/context";
import { t } from "@/lib/storefront/i18n";
import { Placeholder, StoreHeader } from "./_components/StoreHeader";

type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const sp = await searchParams;
  const ctx = await getStoreContext(first(sp.country), first(sp.store));
  if (!ctx) return {};
  return { title: `${t(ctx.locale).shopAll} · ${ctx.store.name}`, other: { "content-language": ctx.locale } };
}

export default async function CollectionPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await getStoreContext(first(sp.country), first(sp.store));
  if (!ctx) notFound();
  const s = t(ctx.locale);
  const category = first(sp.category)?.slice(0, 200) || null;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(first(sp.page) ?? "1", 10) || 1));
  const data = await getCollection(ctx.store.id, ctx.locale, category, page);
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const link = (q: Record<string, string | number | null>) => ctx.href("/store", { category, ...q });

  return (
    <div lang={ctx.locale} className="min-h-screen">
      <StoreHeader ctx={ctx} />
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-6">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight sm:text-3xl">{category ?? s.shopAll}</h1>

        {data.categories.length > 0 && (
          <nav className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Categories">
            <Link
              href={link({ category: null })}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${!category ? "border-text bg-text text-bg" : "border-border bg-surface"}`}
            >
              {s.allCategories}
            </Link>
            {data.categories.map((c) => (
              <Link
                key={c}
                href={link({ category: c })}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${category === c ? "border-text bg-text text-bg" : "border-border bg-surface"}`}
              >
                {c.split(" > ").pop()}
              </Link>
            ))}
          </nav>
        )}

        {data.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-10 text-center text-muted">{s.noProducts}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {data.items.map((p) => {
              const price = formatPrice(p.priceFromCents, p.currency, ctx.intl);
              return (
                <li key={p.handle}>
                  <Link href={ctx.href(`/store/products/${p.handle}`)} className="group block">
                    <div className="aspect-square overflow-hidden rounded-lg bg-surface-2">
                      {p.thumbUrl ? (
                        <img src={p.thumbUrl} alt={p.title} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.03]" />
                      ) : (
                        <Placeholder label={p.title} />
                      )}
                    </div>
                    <h2 className="mt-3 line-clamp-2 text-sm font-medium">{p.title}</h2>
                    <p className="mt-1 text-sm text-muted">{price ? `${s.from} ${price}` : s.unavailable}</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {pages > 1 && (
          <nav className="mt-10 flex items-center justify-center gap-4 text-sm" aria-label="Pagination">
            {page > 1 ? <Link className="rounded-md border border-border px-3 py-2" href={link({ category, page: page - 1 })}>← {s.previous}</Link> : <span />}
            <span className="text-muted">
              {s.page} {page} {s.of} {pages}
            </span>
            {page < pages ? <Link className="rounded-md border border-border px-3 py-2" href={link({ category, page: page + 1 })}>{s.next} →</Link> : <span />}
          </nav>
        )}
      </main>
    </div>
  );
}
