"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, ArrowLeft, Check, Save, ShieldCheck, ShieldX, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, ConfidenceChip, StatusBadge } from "@/components/ui";

interface Detail {
  product: {
    id: string;
    handle: string;
    status: string;
    title: string | null;
    category: string | null;
    reviewReasons: string[];
    reviewNote: string | null;
    version: number;
    model: string | null;
    promptVersion: string | null;
    error: string | null;
    output: { confidence?: Record<string, number>; tags?: string[]; source_rows?: number[] } | null;
    group: { issues?: Array<{ code: string; message: string; severity: string; rows?: number[] }> } | null;
  };
  fields: Array<{ fieldPath: string; value: string; confidence: number | null; origin: "ai" | "manual"; aiSuggestion: string | null }>;
  variants: Array<{ id: string; sku: string | null; options: Record<string, string>; priceCents: number | null; currency: string | null; weightGrams: number | null; sourceRows: number[] }>;
  claims: Array<{ id: string; text: string; sourceRow: number | null; sourceColumn: string | null; sourceQuote: string | null; verified: boolean; rejectedReason: string | null }>;
  translations: Array<{ fieldPath: string; locale: "de" | "fr"; value: string | null; origin: "ai" | "manual"; state: string; error: string | null }>;
  sourceRows: Array<{ importId: string; rowNumber: number; raw: Record<string, string>; issues: Array<{ code: string; message: string; severity: string; field?: string }>; status: string; reason: string | null }>;
  photos: Array<{ id: string; filename: string; thumbKey: string | null; storageKey: string; matchMethod: string | null }>;
  aiUsage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; byModel: Array<{ model: string; calls: number; costUsd: number }> };
}

const usd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`);

const FIELD_ORDER = ["title", "description_html", "category", "tags", "seo_title", "seo_description"];
const LONG = new Set(["description_html", "seo_description"]);

function centsToInput(c: number | null): string {
  if (c === null) return "";
  const s = String(c).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Decimal string → integer cents without floats ("12.5" → 1250, "1299" → 129900). */
function inputToCents(v: string): number | null {
  const m = v.trim().replace(",", ".").match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

export default function ProductReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["product", id], queryFn: () => api<Detail>(`/api/products/${id}`) });
  const [tab, setTab] = useState<"en" | "de" | "fr">("en");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [trEdits, setTrEdits] = useState<Record<string, string>>({});
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    setEdits({});
    setTrEdits({});
    setPriceEdits({});
  }, [q.data?.product.version]);

  const save = useMutation({
    mutationFn: (action?: "approve" | "send_back" | "reject") => {
      const d = q.data;
      if (!d) throw new Error("Not loaded");
      const variants = Object.entries(priceEdits).map(([vid, v]) => {
        const cents = v.trim() === "" ? null : inputToCents(v);
        if (v.trim() !== "" && cents === null) throw new Error(`Invalid price "${v}"`);
        return { id: vid, priceCents: cents };
      });
      const translations = Object.entries(trEdits).map(([k, value]) => {
        const [locale, fieldPath] = k.split("|") as ["de" | "fr", string];
        return { locale, fieldPath, value };
      });
      return api<{ version: number; status: string }>(`/api/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: d.product.version,
          fields: Object.keys(edits).length ? edits : undefined,
          translations: translations.length ? translations : undefined,
          variants: variants.length ? variants : undefined,
          action,
          note: note || undefined,
        }),
      });
    },
    onSuccess: (r, action) => {
      setConflict(false);
      setMsg({ kind: "ok", text: action === "approve" ? "Approved and published." : action === "send_back" ? "Sent back for review." : "Saved." });
      void qc.invalidateQueries({ queryKey: ["product", id] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void r;
    },
    onError: (e: Error & { status?: number }) => {
      if (e.status === 409) setConflict(true);
      setMsg({ kind: "err", text: e.message });
    },
  });

  const del = useMutation({
    mutationFn: () => api(`/api/products/${id}`, { method: "DELETE" }),
    onSuccess: () => router.push("/products"),
  });

  const d = q.data;
  const cited = useMemo(() => new Set((d?.claims ?? []).map((c) => `${c.sourceRow}|${c.sourceColumn}`)), [d?.claims]);
  const columns = useMemo(() => {
    const set: string[] = [];
    for (const r of d?.sourceRows ?? []) for (const k of Object.keys(r.raw)) if (!set.includes(k)) set.push(k);
    return set;
  }, [d?.sourceRows]);

  if (q.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (q.error || !d) return <p className="text-sm text-bad">{(q.error as Error | null)?.message ?? "Not found"}</p>;

  const fields = [...d.fields].sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a.fieldPath);
    const ib = FIELD_ORDER.indexOf(b.fieldPath);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.fieldPath.localeCompare(b.fieldPath);
  });
  const conf = d.product.output?.confidence ?? {};
  const dirty = Object.keys(edits).length + Object.keys(trEdits).length + Object.keys(priceEdits).length > 0;
  const groupIssues = d.product.group?.issues ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/products" className="btn"><ArrowLeft size={14} /> Products</Link>
        <h1 className="mr-auto min-w-0 truncate text-xl font-semibold">{d.product.title ?? d.product.handle}</h1>
        <StatusBadge status={d.product.status} />
        {d.product.model && <span className="chip bg-surface-2 text-muted">{d.product.model}{d.product.promptVersion ? ` · ${d.product.promptVersion}` : ""}</span>}
      </div>

      {(d.product.reviewReasons.length > 0 || d.product.reviewNote || d.product.error) && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
          <div className="flex items-center gap-1.5 font-medium text-warn"><AlertTriangle size={14} /> Needs attention</div>
          <ul className="mt-1 list-disc pl-5">
            {d.product.reviewReasons.map((r) => <li key={r}>{r}</li>)}
            {d.product.reviewNote && <li>Reviewer note: {d.product.reviewNote}</li>}
            {d.product.error && <li className="text-bad">{d.product.error}</li>}
          </ul>
        </div>
      )}
      {conflict && (
        <div className="rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm text-bad">
          Someone else changed this product.{" "}
          <button className="underline" onClick={() => { setConflict(false); void q.refetch(); }}>Reload latest</button> (your unsaved edits will be discarded).
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Source side */}
        <section className="space-y-4">
          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Source rows</h2>
            {d.sourceRows.length === 0 ? (
              <p className="text-sm text-muted">No source rows linked.</p>
            ) : (
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface text-left text-muted">
                    <tr>
                      <th className="px-2 py-1">Row</th>
                      {columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {d.sourceRows.map((r) => (
                      <tr key={`${r.importId}-${r.rowNumber}`} className="border-t border-border align-top">
                        <td className="px-2 py-1 tabular-nums">{r.rowNumber}</td>
                        {columns.map((c) => (
                          <td
                            key={c}
                            className={clsx("max-w-64 px-2 py-1", cited.has(`${r.rowNumber}|${c}`) && "bg-accent/15 ring-1 ring-accent/40")}
                            title={r.raw[c]}
                          >
                            <div className="line-clamp-3 break-words">{r.raw[c]}</div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-muted">Highlighted cells are cited as the source of a claim.</p>
          </div>

          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Photos</h2>
            {d.photos.length === 0 ? (
              <p className="text-sm text-muted">No photos matched this product.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {d.photos.map((p) => (
                  <a key={p.id} href={`/api/files/${p.storageKey}`} target="_blank" rel="noreferrer" title={`${p.filename} (matched by ${p.matchMethod ?? "?"})`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/files/${p.thumbKey ?? p.storageKey}`} alt={p.filename} className="aspect-square w-full rounded object-cover" loading="lazy" />
                    <span className="block truncate text-[11px] text-muted">{p.filename}</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Cleaning issues</h2>
            {groupIssues.length === 0 && d.sourceRows.every((r) => r.issues.length === 0) ? (
              <p className="text-sm text-muted">None.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {groupIssues.map((i, k) => (
                  <li key={`g${k}`} className={clsx(i.severity === "error" ? "text-bad" : i.severity === "warn" ? "text-warn" : "text-muted")}>
                    {i.message}{i.rows?.length ? ` (rows ${i.rows.join(", ")})` : ""}
                  </li>
                ))}
                {d.sourceRows.flatMap((r) =>
                  r.issues.map((i, k) => (
                    <li key={`${r.rowNumber}-${k}`} className={clsx(i.severity === "error" ? "text-bad" : i.severity === "warn" ? "text-warn" : "text-muted")}>
                      Row {r.rowNumber}: {i.message}
                    </li>
                  )),
                )}
              </ul>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-2 font-semibold">AI usage</h2>
            {d.aiUsage.calls === 0 ? (
              <p className="text-sm text-muted">No AI calls recorded for this product.</p>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
                  <div><dt className="text-muted">Calls</dt><dd>{d.aiUsage.calls}</dd></div>
                  <div><dt className="text-muted">Tokens in</dt><dd>{d.aiUsage.inputTokens.toLocaleString()}</dd></div>
                  <div><dt className="text-muted">Tokens out</dt><dd>{d.aiUsage.outputTokens.toLocaleString()}</dd></div>
                  <div><dt className="text-muted">Cost</dt><dd>{usd(d.aiUsage.costUsd)}</dd></div>
                </dl>
                <ul className="mt-2 space-y-0.5 text-xs text-muted">
                  {d.aiUsage.byModel.map((m) => (
                    <li key={m.model}>
                      <code>{m.model}</code> · {m.calls} call{m.calls === 1 ? "" : "s"} · {usd(m.costUsd)}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">Batch calls count once per product they include.</p>
              </>
            )}
          </div>
        </section>

        {/* AI result side */}
        <section className="space-y-4">
          <div className="card p-4">
            <div className="mb-3 flex items-center gap-1">
              {(["en", "de", "fr"] as const).map((l) => (
                <button key={l} className={clsx("btn", tab === l && "bg-surface-2")} onClick={() => setTab(l)}>{l.toUpperCase()}</button>
              ))}
            </div>

            {tab === "en" ? (
              <div className="space-y-3">
                {fields.map((f) => {
                  const value = edits[f.fieldPath] ?? f.value;
                  const Input = LONG.has(f.fieldPath) ? "textarea" : "input";
                  return (
                    <label key={f.fieldPath} className="block text-sm">
                      <span className="mb-1 flex items-center gap-2">
                        <span className="font-medium">{f.fieldPath}</span>
                        <ConfidenceChip value={conf[f.fieldPath] ?? f.confidence} />
                        {f.origin === "manual" && <span className="chip bg-accent/15 text-accent">manual</span>}
                        {f.origin === "manual" && f.aiSuggestion && f.aiSuggestion !== f.value && (
                          <span className="chip bg-surface-2 text-muted" title={f.aiSuggestion}>AI has a newer suggestion</span>
                        )}
                      </span>
                      <Input
                        className={clsx("input", Input === "textarea" && "min-h-28 font-mono text-xs")}
                        value={value}
                        onChange={(e) => setEdits((s) => ({ ...s, [f.fieldPath]: e.target.value }))}
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3">
                {fields
                  .filter((f) => f.fieldPath !== "category" && f.fieldPath !== "tags")
                  .map((f) => {
                    const t = d.translations.find((x) => x.locale === tab && x.fieldPath === f.fieldPath);
                    const key = `${tab}|${f.fieldPath}`;
                    const Input = LONG.has(f.fieldPath) ? "textarea" : "input";
                    return (
                      <label key={key} className="block text-sm">
                        <span className="mb-1 flex items-center gap-2">
                          <span className="font-medium">{f.fieldPath}</span>
                          <StatusBadge status={t?.state ?? "missing"} />
                          {t?.origin === "manual" && <span className="chip bg-accent/15 text-accent">manual</span>}
                        </span>
                        <Input
                          className={clsx("input", Input === "textarea" && "min-h-28 font-mono text-xs")}
                          value={trEdits[key] ?? t?.value ?? ""}
                          placeholder="Not translated yet; the storefront falls back to English."
                          onChange={(e) => setTrEdits((s) => ({ ...s, [key]: e.target.value }))}
                        />
                        {t?.state === "out_of_date" && (
                          <span className="mt-0.5 block text-xs text-warn">English changed after this manual translation. Your text is kept; review it.</span>
                        )}
                        {t?.error && <span className="mt-0.5 block text-xs text-bad">{t.error}</span>}
                      </label>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Claims</h2>
            {d.claims.length === 0 ? (
              <p className="text-sm text-muted">No product claims.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.claims.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    {c.verified ? <ShieldCheck size={16} className="mt-0.5 flex-none text-good" /> : <ShieldX size={16} className="mt-0.5 flex-none text-bad" />}
                    <div>
                      <span className={clsx("font-medium", !c.verified && "text-muted line-through")}>{c.text}</span>
                      <div className="text-xs text-muted">
                        {c.sourceRow ? `row ${c.sourceRow}, column ${c.sourceColumn ?? "?"}` : "no source"}
                        {c.sourceQuote ? ` · "${c.sourceQuote}"` : ""}
                      </div>
                      {c.rejectedReason && <div className="text-xs text-bad">Removed: {c.rejectedReason}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-2 font-semibold">Variants</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr><th className="py-1 pr-2">SKU</th><th className="pr-2">Options</th><th className="pr-2">Price</th><th className="pr-2">Weight</th><th>Rows</th></tr>
                </thead>
                <tbody>
                  {d.variants.map((v) => (
                    <tr key={v.id} className="border-t border-border">
                      <td className="py-1.5 pr-2 font-mono text-xs">{v.sku ?? <span className="text-bad">missing</span>}</td>
                      <td className="pr-2 text-xs">{Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(", ") || "–"}</td>
                      <td className="pr-2">
                        <div className="flex items-center gap-1">
                          <input
                            aria-label={`Price for ${v.sku ?? "variant"}`}
                            className={clsx("input w-24 py-1 tabular-nums", v.priceCents === null && !priceEdits[v.id] && "border-bad")}
                            value={priceEdits[v.id] ?? centsToInput(v.priceCents)}
                            placeholder="missing"
                            inputMode="decimal"
                            onChange={(e) => setPriceEdits((s) => ({ ...s, [v.id]: e.target.value }))}
                          />
                          <span className="text-xs text-muted">{v.currency ?? ""}</span>
                        </div>
                      </td>
                      <td className="pr-2 tabular-nums text-xs">{v.weightGrams !== null ? `${v.weightGrams} g` : "–"}</td>
                      <td className="text-xs text-muted">{v.sourceRows.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card space-y-3 p-4">
            <label className="block text-sm">
              Note for send back / reject
              <input className="input mt-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. confirm the 30 cm price with supplier" />
            </label>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate("approve")}><Check size={14} /> {dirty ? "Save & approve" : "Approve"}</button>
              <button className="btn" disabled={save.isPending || !dirty} onClick={() => save.mutate(undefined)}><Save size={14} /> Save</button>
              <button className="btn" disabled={save.isPending} onClick={() => save.mutate("send_back")}><Undo2 size={14} /> Send back</button>
              <button
                className="btn-danger ml-auto"
                disabled={del.isPending}
                onClick={() => { if (confirm("Delete this product? It is removed from the storefront and exports.")) del.mutate(); }}
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
            {msg && <p role="status" className={clsx("text-sm", msg.kind === "ok" ? "text-good" : "text-bad")}>{msg.text}</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
