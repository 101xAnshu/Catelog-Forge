"use client";

import clsx from "clsx";

export function confidenceBand(v: number | null | undefined): "high" | "medium" | "low" | "none" {
  if (v === null || v === undefined) return "none";
  return v >= 85 ? "high" : v >= 70 ? "medium" : "low";
}

export function ConfidenceChip({ value, label }: { value: number | null | undefined; label?: string }) {
  const band = confidenceBand(value);
  return (
    <span
      title={label ? `${label}: ${value ?? "n/a"}%` : `Confidence ${value ?? "n/a"}%`}
      className={clsx(
        "chip tabular-nums",
        band === "high" && "bg-good/15 text-good",
        band === "medium" && "bg-warn/15 text-warn",
        band === "low" && "bg-bad/15 text-bad",
        band === "none" && "bg-surface-2 text-muted",
      )}
    >
      {label ? `${label} ` : ""}
      {value ?? "–"}
      {value !== null && value !== undefined ? "%" : ""}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  approved: "bg-good/15 text-good",
  done: "bg-good/15 text-good",
  completed: "bg-good/15 text-good",
  fresh: "bg-good/15 text-good",
  needs_review: "bg-warn/15 text-warn",
  out_of_date: "bg-warn/15 text-warn",
  paused: "bg-warn/15 text-warn",
  failed: "bg-bad/15 text-bad",
  rejected: "bg-bad/15 text-bad",
  missing: "bg-bad/15 text-bad",
  invalid: "bg-bad/15 text-bad",
  orphan: "bg-surface-2 text-muted",
  archived: "bg-surface-2 text-muted",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx("chip whitespace-nowrap", STATUS_STYLE[status] ?? "bg-accent/15 text-accent")}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function formatMoney(cents: number | null | undefined, currency: string | null | undefined): string {
  if (cents === null || cents === undefined) return "–";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency ?? "EUR" }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ""}`;
  }
}

export function formatUsd(v: number): string {
  return v < 0.01 && v > 0 ? `$${v.toFixed(5)}` : `$${v.toFixed(v < 10 ? 4 : 2)}`;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted">{children}</div>;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const data = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data as T;
}
