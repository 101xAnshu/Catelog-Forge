/* eslint-disable @next/next/no-img-element */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sanitizeDescription } from "@cf/core";
import { formatPrice, getProduct } from "@/lib/storefront/data";
import { first, getStoreContext } from "@/lib/storefront/context";
import { optionLabel, t } from "@/lib/storefront/i18n";
import { Placeholder, StoreHeader } from "../../_components/StoreHeader";
import { VariantPicker } from "../../_components/VariantPicker";

type Params = Promise<{ handle: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const HANDLE = /^[a-z0-9][a-z0-9-]{0,200}$/;
// One representative country per locale for hreflang alternates.
const LOCALE_COUNTRY = { de: "DE", fr: "FR", en: "US" } as const;

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const [{ handle }, sp] = await Promise.all([params, searchParams]);
  if (!HANDLE.test(handle)) return {};
  const ctx = await getStoreContext(first(sp.country), first(sp.store));
  if (!ctx) return {};
  const product = await getProduct(ctx.store.id, ctx.locale, handle);
  if (!product) return {};
  const p = product.payload;
  return {
    title: p.seo.title || `${p.title} · ${ctx.store.name}`,
    description: p.seo.description || undefined,
    alternates: {
      languages: Object.fromEntries(product.alternates.map((l) => [l, ctx.href(`/store/products/${handle}`, { country: LOCALE_COUNTRY[l] })])),
    },
    openGraph: { title: p.seo.title || p.title, description: p.seo.description || undefined, images: p.images.slice(0, 1), locale: ctx.intl },
  };
}

export default async function ProductPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ handle }, sp] = await Promise.all([params, searchParams]);
  if (!HANDLE.test(handle)) notFound();
  const ctx = await getStoreContext(first(sp.country), first(sp.store));
  if (!ctx) notFound();
  // Only approved products are ever written to the snapshot; anything else is a 404.
  const product = await getProduct(ctx.store.id, ctx.locale, handle);
  if (!product) notFound();

  const s = t(ctx.locale);
  const p = product.payload;
  const variants = p.variants.map((v) => ({ sku: v.sku, options: v.options, price: formatPrice(v.priceCents, v.currency, ctx.intl) }));
  const optionNames = p.optionNames.length ? p.optionNames : [...new Set(p.variants.flatMap((v) => Object.keys(v.options)))];
  const optionLabels = Object.fromEntries(optionNames.map((n) => [n, optionLabel(ctx.locale, n)]));
  const attributes = Object.entries(p.attributes).filter(([, v]) => v);
  const partiallyEnglish = ctx.locale !== "en" && p.translatedFields.length > 0 && !["title", "description_html"].every((f) => p.translatedFields.includes(f));

  return (
    <div lang={ctx.locale} className="min-h-screen">
      <StoreHeader ctx={ctx} />
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-4">
        <Link href={ctx.href("/store")} className="mb-4 inline-block text-sm text-muted hover:text-text">
          ← {s.back}
        </Link>
        <div className="grid gap-8 md:grid-cols-2 md:gap-12">
          <section aria-label="Images" className="space-y-3">
            <div className="aspect-square overflow-hidden rounded-xl bg-surface-2">
              {p.images[0] ? <img src={p.images[0]} alt={p.title} className="h-full w-full object-cover" /> : <Placeholder label={p.title} />}
            </div>
            {p.images.length > 1 && (
              <div className="grid grid-cols-4 gap-3">
                {p.images.slice(1, 9).map((src) => (
                  <img key={src} src={src} alt="" loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-6">
            <div>
              {p.category && <p className="mb-1 text-xs uppercase tracking-wide text-muted">{p.category.split(" > ").join(" / ")}</p>}
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{p.title}</h1>
            </div>

            <VariantPicker optionNames={optionNames} optionLabels={optionLabels} variants={variants} labels={{ addToCart: s.addToCart, unavailable: s.unavailable }} />

            {p.descriptionHtml && (
              <div
                className="max-w-none space-y-3 text-[15px] leading-relaxed [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
                // Sanitised on import, by the worker on AI output, and again here at render.
                dangerouslySetInnerHTML={{ __html: sanitizeDescription(p.descriptionHtml) }}
              />
            )}

            {p.claims.length > 0 && (
              <div>
                <h2 className="mb-2 text-sm font-semibold">{s.claims}</h2>
                <ul className="flex flex-wrap gap-2">
                  {p.claims.map((c) => (
                    <li key={c} className="rounded-full bg-surface-2 px-3 py-1 text-sm">✓ {c}</li>
                  ))}
                </ul>
              </div>
            )}

            {attributes.length > 0 && (
              <div>
                <h2 className="mb-2 text-sm font-semibold">{s.details}</h2>
                <dl className="divide-y divide-border rounded-lg border border-border bg-surface text-sm">
                  {attributes.map(([k, v]) => (
                    <div key={k} className="grid grid-cols-3 gap-4 px-4 py-2.5">
                      <dt className="text-muted">{optionLabel(ctx.locale, k.replace(/_/g, " "))}</dt>
                      <dd className="col-span-2">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {partiallyEnglish && <p className="text-xs text-muted">{s.notTranslated}</p>}
          </section>
        </div>
      </main>
    </div>
  );
}
