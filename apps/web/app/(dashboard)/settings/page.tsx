"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, Empty } from "@/components/ui";

interface Settings {
  store: { id: string; name: string; slug: string; baseCurrency: string; webhookUrl: string | null; webhookSecret: string; settings: { routingThreshold?: number; reviewThreshold?: number; promptVersion?: string; useBatch?: boolean } };
  countryLocales: Array<{ countryCode: string; locale: "en" | "de" | "fr" }>;
  apiKeys: Array<{ id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }>;
  demoMode: boolean;
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/api/settings") });
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [reviewThreshold, setReviewThreshold] = useState(70);
  const [routingThreshold, setRoutingThreshold] = useState(35);
  const [locales, setLocales] = useState<Settings["countryLocales"]>([]);
  const [newCountry, setNewCountry] = useState("");
  const [newLocale, setNewLocale] = useState<"en" | "de" | "fr">("de");
  const [keyName, setKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setName(q.data.store.name);
    setCurrency(q.data.store.baseCurrency);
    setWebhookUrl(q.data.store.webhookUrl ?? "");
    setReviewThreshold(q.data.store.settings.reviewThreshold ?? 70);
    setRoutingThreshold(q.data.store.settings.routingThreshold ?? 35);
    setLocales(q.data.countryLocales);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () =>
      api("/api/settings", {
        method: "POST",
        body: JSON.stringify({ name, baseCurrency: currency, webhookUrl, settings: { reviewThreshold, routingThreshold }, countryLocales: locales }),
      }),
    onSuccess: () => { setMsg("Saved."); void qc.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (e: Error) => setMsg(e.message),
  });
  const createKey = useMutation({
    mutationFn: () => api<{ key: string }>("/api/api-keys", { method: "POST", body: JSON.stringify({ name: keyName || "API key" }) }),
    onSuccess: (r) => { setCreatedKey(r.key); setKeyName(""); void qc.invalidateQueries({ queryKey: ["settings"] }); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  if (q.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-bad">{(q.error as Error | null)?.message}</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Store</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Name<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="text-sm">Default currency (used when a sheet has none)
            <select className="input mt-1" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {["EUR", "GBP", "USD", "CHF"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-sm">Needs-review threshold (min field confidence): {reviewThreshold}
            <input type="range" min={40} max={95} value={reviewThreshold} onChange={(e) => setReviewThreshold(Number(e.target.value))} className="mt-2 w-full" />
          </label>
          <label className="text-sm">Routing threshold (messiness score that switches to the strong model): {routingThreshold}
            <input type="range" min={0} max={100} value={routingThreshold} onChange={(e) => setRoutingThreshold(Number(e.target.value))} className="mt-2 w-full" />
          </label>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Webhook</h2>
        <p className="text-sm text-muted">We POST <code>import.completed</code> / <code>import.failed</code> here, signed with HMAC-SHA256 in <code>X-CatalogForge-Signature</code>.</p>
        <label className="block text-sm">URL<input className="input mt-1" placeholder="https://example.com/hooks/catalogforge" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} /></label>
        <div className="text-sm">Signing secret: <code className="break-all rounded bg-surface-2 px-1">{q.data.store.webhookSecret}</code></div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-semibold">Storefront languages by country</h2>
        <p className="text-sm text-muted">Countries not listed see English.</p>
        <div className="flex flex-wrap gap-2">
          {locales.map((l) => (
            <span key={l.countryCode} className="chip gap-1 bg-surface-2 py-1">
              {l.countryCode} → {l.locale.toUpperCase()}
              <button aria-label={`Remove ${l.countryCode}`} onClick={() => setLocales((s) => s.filter((x) => x.countryCode !== l.countryCode))}><Trash2 size={12} /></button>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <input className="input w-24 uppercase" maxLength={2} placeholder="IT" value={newCountry} onChange={(e) => setNewCountry(e.target.value.toUpperCase())} aria-label="Country code" />
          <select className="input w-auto" value={newLocale} onChange={(e) => setNewLocale(e.target.value as "en" | "de" | "fr")} aria-label="Language">
            <option value="de">German</option><option value="fr">French</option><option value="en">English</option>
          </select>
          <button className="btn" disabled={!/^[A-Z]{2}$/.test(newCountry)} onClick={() => {
            setLocales((s) => [...s.filter((x) => x.countryCode !== newCountry), { countryCode: newCountry, locale: newLocale }].sort((a, b) => a.countryCode.localeCompare(b.countryCode)));
            setNewCountry("");
          }}><Plus size={14} /> Add</button>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save settings</button>
        {msg && <span className="text-sm text-muted" role="status">{msg}</span>}
      </div>

      <section className="card space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><KeyRound size={16} /> API keys</h2>
        <p className="text-sm text-muted">For the public API (<code>POST /api/v1/imports</code>). See <code>apps/web/API.md</code>.</p>
        {createdKey && (
          <div className="rounded-md border border-good/40 bg-good/10 p-3 text-sm">
            Copy this key now; it will not be shown again:
            <div className="mt-1 flex items-center gap-2">
              <code className="break-all">{createdKey}</code>
              <button className="btn" onClick={() => void navigator.clipboard.writeText(createdKey)} aria-label="Copy key"><Copy size={14} /></button>
            </div>
          </div>
        )}
        {q.data.apiKeys.length === 0 ? <Empty>No API keys.</Empty> : (
          <ul className="divide-y divide-border text-sm">
            {q.data.apiKeys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">{k.name}</span>
                <code className="text-muted">{k.prefix}…</code>
                <span className="text-xs text-muted">{k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}</span>
                {k.revokedAt ? <span className="chip bg-bad/15 text-bad ml-auto">revoked</span> : (
                  <button className="btn-danger ml-auto" onClick={() => revoke.mutate(k.id)}>Revoke</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input className="input max-w-xs" placeholder="Key name" value={keyName} onChange={(e) => setKeyName(e.target.value)} aria-label="Key name" />
          <button className="btn" disabled={createKey.isPending} onClick={() => createKey.mutate()}><Plus size={14} /> Create key</button>
        </div>
      </section>
    </div>
  );
}
