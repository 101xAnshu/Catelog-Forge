"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api, Empty, formatUsd, Stat } from "@/components/ui";
import type { Metrics } from "@/lib/metrics";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const AXIS = { fontSize: 11, fill: "var(--muted)" };

export default function MetricsPage() {
  const q = useQuery({ queryKey: ["metrics"], queryFn: () => api<Metrics>("/api/metrics"), refetchInterval: 10000 });
  if (q.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (q.error || !q.data) return <p className="text-sm text-bad">{(q.error as Error | null)?.message}</p>;
  const m = q.data;

  const statusData = [
    { name: "Done", value: m.rows.byStatus.done ?? 0, fill: "var(--good)" },
    { name: "Needs review", value: m.rows.byStatus.needs_review ?? 0, fill: "var(--warn)" },
    { name: "Failed", value: m.rows.byStatus.failed ?? 0, fill: "var(--bad)" },
    { name: "Pending", value: (m.rows.byStatus.pending ?? 0) + (m.rows.byStatus.grouped ?? 0), fill: "var(--muted)" },
  ];
  const modelData = Object.values(
    m.models.reduce<Record<string, { model: string; calls: number; costUsd: number; tokens: number }>>((acc, r) => {
      const k = r.model;
      acc[k] ??= { model: k, calls: 0, costUsd: 0, tokens: 0 };
      acc[k].calls += r.calls;
      acc[k].costUsd += r.costUsd;
      acc[k].tokens += r.inputTokens + r.outputTokens;
      return acc;
    }, {}),
  );
  const coverage = Object.entries(m.translations).map(([locale, c]) => ({
    locale: locale.toUpperCase(),
    fresh: c.fresh,
    out_of_date: c.out_of_date,
    missing: c.missing + c.pending,
    coverage: c.total ? c.fresh / c.total : 0,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Metrics</h1>
        <p className="text-sm text-muted">Accuracy, speed and cost across all imports.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Products" value={m.products.total.toLocaleString()} hint={`${m.products.approved} approved · ${m.products.needsReview} in review`} />
        <Stat label="Row success" value={pct(m.rows.successRate)} hint={`review ${pct(m.rows.reviewRate)} · failed ${pct(m.rows.failureRate)}`} />
        <Stat label="AI cost" value={formatUsd(m.cost.totalUsd)} hint={`${formatUsd(m.cost.per1000ProductsUsd)} per 1,000 products`} />
        <Stat label="Saved by routing" value={formatUsd(m.cost.savedUsd)} hint={`vs ${formatUsd(m.cost.baselineUsd)} all-strong baseline`} />
        <Stat label="Avg AI latency" value={`${m.latency.avgMs} ms`} hint={`p95 ${m.latency.p95Ms} ms · slowest ${m.latency.maxMs} ms`} />
        <Stat label="AI calls" value={m.latency.calls.toLocaleString()} hint={Object.entries(m.outcomes).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet"} />
        <Stat label="Rows processed" value={m.rows.total.toLocaleString()} />
        <Stat
          label="Out-of-date translations"
          value={Object.values(m.translations).reduce((a, c) => a + c.out_of_date, 0)}
          hint="manual fixes kept after English changed"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Cost over time (USD)</h2>
          {m.cost.daily.length === 0 ? <Empty>No AI calls yet.</Empty> : (
            <div className="h-64">
              <ResponsiveContainer>
                <LineChart data={m.cost.daily}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" tick={AXIS} />
                  <YAxis tick={AXIS} width={60} />
                  <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }} formatter={(v: number) => formatUsd(v)} />
                  <Legend />
                  <Line type="monotone" dataKey="costUsd" name="Actual" stroke="var(--accent)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="baselineUsd" name="All-strong baseline" stroke="var(--muted)" strokeDasharray="4 4" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Row outcomes</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={statusData}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={AXIS} />
                <YAxis tick={AXIS} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
                <Bar dataKey="value" name="Rows" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Model usage</h2>
          {modelData.length === 0 ? <Empty>No AI calls yet.</Empty> : (
            <>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={modelData} layout="vertical" margin={{ left: 40 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis type="number" tick={AXIS} allowDecimals={false} />
                    <YAxis type="category" dataKey="model" tick={AXIS} width={140} />
                    <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
                    <Bar dataKey="calls" name="Calls" fill="var(--accent)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted"><tr><th className="py-1">Model</th><th>Tier</th><th>Kind</th><th>Calls</th><th>Tokens in/out</th><th>Cost</th><th>Avg ms</th></tr></thead>
                  <tbody>
                    {m.models.map((r) => (
                      <tr key={`${r.model}-${r.tier}-${r.kind}`} className="border-t border-border tabular-nums">
                        <td className="py-1">{r.model}</td><td>{r.tier}</td><td>{r.kind}</td><td>{r.calls}{r.batchedCalls ? ` (${r.batchedCalls} batch)` : ""}</td>
                        <td>{r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}</td><td>{formatUsd(r.costUsd)}</td><td>{r.avgLatencyMs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Translation coverage</h2>
          {coverage.length === 0 ? <Empty>No translations yet.</Empty> : (
            <>
              <div className="h-56">
                <ResponsiveContainer>
                  <BarChart data={coverage}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="locale" tick={AXIS} />
                    <YAxis tick={AXIS} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
                    <Legend />
                    <Bar dataKey="fresh" stackId="t" name="Fresh" fill="var(--good)" />
                    <Bar dataKey="out_of_date" stackId="t" name="Out of date" fill="var(--warn)" />
                    <Bar dataKey="missing" stackId="t" name="Missing / pending" fill="var(--bad)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-sm text-muted">{coverage.map((c) => `${c.locale}: ${pct(c.coverage)} fresh`).join(" · ")}</p>
            </>
          )}
        </section>
      </div>

      <section className="card p-4">
        <h2 className="mb-3 font-semibold">Imports: speed and cost</h2>
        {m.imports.length === 0 ? <Empty>No imports yet.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="py-1">File</th><th>Status</th><th>Rows</th><th>Products</th><th>Duration</th><th>Rows/min</th><th>Cost</th></tr></thead>
              <tbody>
                {m.imports.map((i) => (
                  <tr key={i.id} className="border-t border-border tabular-nums">
                    <td className="max-w-60 truncate py-1.5">{i.filename}</td><td>{i.status}</td><td>{i.processed}/{i.totalRows}</td><td>{i.products}</td>
                    <td>{i.durationSec !== null ? `${Math.floor(i.durationSec / 60)}m ${i.durationSec % 60}s` : "–"}</td>
                    <td>{i.rowsPerMinute ?? "–"}</td><td>{formatUsd(i.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-1 font-semibold">Evaluation &amp; A/B prompts</h2>
        <p className="mb-3 text-sm text-muted">Per-field accuracy against the labelled test set (<code>bun run eval</code>).</p>
        {m.evals.length === 0 ? <Empty>No eval runs yet. Run <code>bun run eval</code>.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">When</th><th>Prompt</th><th>Model</th><th>N</th>
                  {Object.keys(m.evals[0]?.fieldScores ?? {}).map((k) => <th key={k}>{k}</th>)}
                  <th>Invented claims</th><th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {m.evals.map((e) => (
                  <tr key={e.id} className="border-t border-border tabular-nums">
                    <td className="py-1.5 text-xs">{new Date(e.createdAt).toLocaleString()}</td><td>{e.promptVersion}</td><td className="text-xs">{e.model}</td><td>{e.sampleSize}</td>
                    {Object.keys(m.evals[0]?.fieldScores ?? {}).map((k) => <td key={k}>{e.fieldScores[k] !== undefined ? pct(e.fieldScores[k] ?? 0) : "–"}</td>)}
                    <td>{pct(e.hallucinationRate)}</td><td>{formatUsd(e.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
