"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, ImageIcon, Loader2, RotateCcw, UploadCloud, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { api, Empty, StatusBadge } from "@/components/ui";
import { useLiveProgress } from "@/components/use-progress";

interface ImportItem {
  id: string;
  filename: string;
  status: string;
  stage: string | null;
  source: string;
  pausedUntil: string | null;
  pausedReason: string | null;
  error: string | null;
  errorCode: string | null;
  settings: { routing: string; promptVersion: string; useBatch: boolean };
  counts: { total: number; pending: number; done: number; needs_review: number; failed: number; products?: number; orphan_photos?: number };
  rowsPerMinute: number | null;
  createdAt: string;
  finishedAt: string | null;
}

const MB = 1024 * 1024;
const LIMITS = { sheet: 25 * MB, zip: 500 * MB, image: 20 * MB, images: 2000 };

function kindOf(file: File): "sheet" | "zip" | "image" | null {
  const n = file.name.toLowerCase();
  if (/\.(csv|tsv|txt|xlsx)$/.test(n)) return "sheet";
  if (n.endsWith(".zip")) return "zip";
  if (/\.(jpe?g|png|webp)$/.test(n)) return "image";
  return null;
}

export default function UploadPage() {
  const { connected } = useLiveProgress();
  const qc = useQueryClient();
  const [sheet, setSheet] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [routing, setRouting] = useState("auto");
  const [promptVersion, setPromptVersion] = useState("v1");
  const [useBatch, setUseBatch] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const imports = useQuery({
    queryKey: ["imports"],
    queryFn: () => api<{ imports: ImportItem[] }>("/api/imports"),
    refetchInterval: (q) => (connected ? 15000 : q.state.data?.imports.some((i) => !["completed", "failed"].includes(i.status)) ? 3000 : 15000),
  });

  function onDrop(accepted: File[], rejected: FileRejection[]) {
    const errs: string[] = rejected.map((r) => `${r.file.name}: ${r.errors[0]?.message ?? "rejected"}`);
    let nextSheet = sheet;
    const nextPhotos = [...photos];
    for (const f of accepted) {
      const kind = kindOf(f);
      if (!kind) errs.push(`${f.name}: unsupported type. Use CSV/XLSX for the sheet and ZIP/JPG/PNG/WebP for photos.`);
      else if (kind === "sheet") {
        if (f.size > LIMITS.sheet) errs.push(`${f.name}: ${(f.size / MB).toFixed(1)} MB exceeds the 25 MB sheet limit.`);
        else nextSheet = f;
      } else if (kind === "zip" && f.size > LIMITS.zip) errs.push(`${f.name}: exceeds the 500 MB ZIP limit.`);
      else if (kind === "image" && f.size > LIMITS.image) errs.push(`${f.name}: exceeds the 20 MB per-photo limit.`);
      else nextPhotos.push(f);
    }
    if (nextPhotos.filter((p) => kindOf(p) === "zip").length > 1) errs.push("Only one ZIP per import; or drop individual photos.");
    if (nextPhotos.filter((p) => kindOf(p) === "image").length > LIMITS.images) errs.push(`At most ${LIMITS.images} photos per import.`);
    setErrors(errs);
    setSheet(nextSheet);
    setPhotos(nextPhotos);
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, multiple: true });

  const upload = useMutation({
    mutationFn: async () => {
      if (!sheet) throw new Error("Add a CSV or XLSX sheet first.");
      const form = new FormData();
      form.append("sheet", sheet);
      for (const p of photos) form.append("photos", p);
      form.append("routing", routing);
      form.append("promptVersion", promptVersion);
      form.append("useBatch", String(useBatch));
      return api<{ id: string; duplicate: boolean }>("/api/imports", { method: "POST", body: form });
    },
    onSuccess: (res) => {
      setNotice(res.duplicate ? "This exact file was already imported; showing the existing import (no duplicates created)." : "Upload received. Processing in the background.");
      setSheet(null);
      setPhotos([]);
      setErrors([]);
      void qc.invalidateQueries({ queryKey: ["imports"] });
    },
    onError: (e: Error) => setErrors([e.message]),
  });

  const blocked = !sheet || errors.some((e) => e.includes("Only one ZIP") || e.includes("At most"));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Upload</h1>
          <p className="text-sm text-muted">Drop a supplier sheet (CSV/XLSX, up to 10,000 rows) and photos (ZIP or images, up to 2,000).</p>
        </div>
        <span className={clsx("chip", connected ? "bg-good/15 text-good" : "bg-surface-2 text-muted")}>
          {connected ? "● Live" : "○ Polling"}
        </span>
      </div>

      <section className="card space-y-4 p-4">
        <div
          {...getRootProps()}
          className={clsx(
            "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-10 text-center transition",
            isDragActive ? "border-accent bg-accent/5" : "border-border hover:border-accent/60",
          )}
        >
          <input {...getInputProps()} aria-label="Upload files" />
          <UploadCloud className="mb-2 text-muted" size={32} aria-hidden />
          <p className="font-medium">Drag & drop your sheet and photos here</p>
          <p className="text-sm text-muted">or click to choose files · CSV, XLSX · ZIP, JPG, PNG, WebP</p>
        </div>

        {(sheet || photos.length > 0) && (
          <ul className="space-y-1 text-sm">
            {sheet && (
              <li className="flex items-center gap-2">
                <FileSpreadsheet size={16} className="text-accent" /> {sheet.name}
                <span className="text-muted">({(sheet.size / 1024).toFixed(0)} KB)</span>
                <button className="ml-auto text-muted hover:text-bad" aria-label="Remove sheet" onClick={() => setSheet(null)}><X size={14} /></button>
              </li>
            )}
            {photos.length > 0 && (
              <li className="flex items-center gap-2">
                <ImageIcon size={16} className="text-accent" />
                {photos.length === 1 ? photos[0]?.name : `${photos.length} photo files`}
                <span className="text-muted">({(photos.reduce((a, p) => a + p.size, 0) / MB).toFixed(1)} MB)</span>
                <button className="ml-auto text-muted hover:text-bad" aria-label="Remove photos" onClick={() => setPhotos([])}><X size={14} /></button>
              </li>
            )}
          </ul>
        )}

        {errors.length > 0 && (
          <div role="alert" className="rounded-md border border-bad/30 bg-bad/5 p-3 text-sm text-bad">
            {errors.map((e) => <p key={e}>{e}</p>)}
          </div>
        )}
        {notice && <p className="text-sm text-good">{notice}</p>}

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Model routing
            <select className="input mt-1 w-44" value={routing} onChange={(e) => setRouting(e.target.value)}>
              <option value="auto">Auto (cheap → strong)</option>
              <option value="cheap">Always cheap</option>
              <option value="strong">Always strong</option>
            </select>
          </label>
          <label className="text-sm">
            Prompt version
            <select className="input mt-1 w-28" value={promptVersion} onChange={(e) => setPromptVersion(e.target.value)}>
              <option value="v1">v1</option>
              <option value="v2">v2</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={useBatch} onChange={(e) => setUseBatch(e.target.checked)} />
            Use batch API for large imports
          </label>
          <button className="btn-primary ml-auto" disabled={blocked || upload.isPending} onClick={() => upload.mutate()}>
            {upload.isPending ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />} Start import
          </button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Imports</h2>
        {imports.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : imports.error ? (
          <p className="text-sm text-bad">{(imports.error as Error).message}</p>
        ) : !imports.data?.imports.length ? (
          <Empty>No imports yet. Try <code>fixtures/small.csv</code> from the repo.</Empty>
        ) : (
          imports.data.imports.map((imp) => <ImportCard key={imp.id} imp={imp} />)
        )}
      </section>
    </div>
  );
}

function useCountdown(until: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return "any moment";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m} min ${s}s` : `${s}s`;
}

function ImportCard({ imp }: { imp: ImportItem }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const countdown = useCountdown(imp.status === "paused" ? imp.pausedUntil : null);
  const c = imp.counts;
  const processed = c.done + c.needs_review + c.failed;
  const pct = c.total ? Math.round((processed / c.total) * 100) : 0;
  const active = !["completed", "failed"].includes(imp.status);

  const retry = useMutation({
    mutationFn: () => api<{ retried: number | string; message?: string }>(`/api/imports/${imp.id}/retry`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["imports"] }),
  });

  const seg = useMemo(
    () =>
      c.total
        ? [
            { w: (c.done / c.total) * 100, cls: "bg-good" },
            { w: (c.needs_review / c.total) * 100, cls: "bg-warn" },
            { w: (c.failed / c.total) * 100, cls: "bg-bad" },
          ]
        : [],
    [c.done, c.needs_review, c.failed, c.total],
  );

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <FileSpreadsheet size={16} className="text-muted" aria-hidden />
        <span className="font-medium">{imp.filename}</span>
        <StatusBadge status={imp.status} />
        {active && imp.status !== "paused" && <Loader2 size={14} className="animate-spin text-muted" aria-label="processing" />}
        {imp.stage && active && <span className="text-xs text-muted">stage: {imp.stage}</span>}
        {imp.source === "api" && <span className="chip bg-surface-2 text-muted">API</span>}
        <span className="ml-auto text-xs text-muted">{new Date(imp.createdAt).toLocaleString()}</span>
      </div>

      {imp.status === "paused" && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-warn">
          <AlertTriangle size={14} /> Paused — resuming in {countdown ?? "a moment"}
          {imp.pausedReason ? ` (${imp.pausedReason})` : ""}
        </p>
      )}
      {imp.error && (
        <p className="mt-2 text-sm text-bad">
          {imp.errorCode ? <code className="mr-1">{imp.errorCode}</code> : null}
          {imp.error}
        </p>
      )}

      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        {seg.map((s, i) => <div key={i} className={s.cls} style={{ width: `${s.w}%` }} />)}
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
        <div><dt className="inline text-muted">Rows </dt><dd className="inline">{c.total.toLocaleString()}</dd></div>
        <div><dt className="inline text-good">Done </dt><dd className="inline">{c.done.toLocaleString()}</dd></div>
        <div><dt className="inline text-warn">Needs review </dt><dd className="inline">{c.needs_review.toLocaleString()}</dd></div>
        <div><dt className="inline text-bad">Failed </dt><dd className="inline">{c.failed.toLocaleString()}</dd></div>
        <div><dt className="inline text-muted">Pending </dt><dd className="inline">{c.pending.toLocaleString()}</dd></div>
        {c.total > 0 && <div className="text-muted">{pct}%</div>}
        {imp.rowsPerMinute !== null && <div className="text-muted">{imp.rowsPerMinute.toLocaleString()} rows/min</div>}
        {!active && c.total > 0 && processed === c.total && (
          <div className="flex items-center gap-1 text-good"><CheckCircle2 size={14} /> counts add up</div>
        )}
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" onClick={() => setOpen((o) => !o)}>{open ? "Hide details" : "Rows & errors"}</button>
        <Link className="btn" href={`/products?importId=${imp.id}`}>View products</Link>
        {(c.failed > 0 || imp.status === "failed") && (
          <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
            <RotateCcw size={14} /> Retry failed
          </button>
        )}
        {retry.data && <span className="self-center text-sm text-muted">{retry.data.message ?? `Retrying ${retry.data.retried}`}</span>}
        {retry.error && <span className="self-center text-sm text-bad">{(retry.error as Error).message}</span>}
      </div>
      {open && <ImportDetail id={imp.id} />}
    </article>
  );
}

interface ImportDetailData {
  rows: Array<{ rowNumber: number; status: string; reason: string | null; issues: Array<{ code: string; message: string; severity: string }>; productId: string | null }>;
  totalRows: number;
  page: number;
  pageSize: number;
  orphanPhotos: Array<{ id: string; filename: string; status: string; reason: string | null }>;
}

function ImportDetail({ id }: { id: string }) {
  const [status, setStatus] = useState("failed");
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["imports", id, status, page],
    queryFn: () => api<ImportDetailData>(`/api/imports/${id}?status=${status}&page=${page}&pageSize=50`),
  });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.totalRows / q.data.pageSize)) : 1;
  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-1">
        {["failed", "needs_review", "done", "pending", ""].map((s) => (
          <button key={s || "all"} className={clsx("btn", status === s && "bg-surface-2")} onClick={() => { setStatus(s); setPage(1); }}>
            {s ? s.replace("_", " ") : "all"}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <p className="text-sm text-muted">Loading rows…</p>
      ) : !q.data?.rows.length ? (
        <p className="text-sm text-muted">No rows with this status.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr><th className="py-1 pr-3">Row</th><th className="pr-3">Status</th><th>Reason / issues</th></tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.rowNumber} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3 tabular-nums">{r.rowNumber}</td>
                  <td className="pr-3"><StatusBadge status={r.status} /></td>
                  <td className="py-1.5">
                    {r.reason && <div>{r.reason}</div>}
                    {r.issues.filter((i) => i.severity !== "info").slice(0, 4).map((i, k) => (
                      <div key={k} className="text-xs text-muted">{i.message}</div>
                    ))}
                    {r.productId && <Link className="text-xs text-accent underline" href={`/products/${r.productId}`}>open product</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span className="text-muted">Page {page} / {pages}</span>
          <button className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
      {q.data && q.data.orphanPhotos.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Photos not attached ({q.data.orphanPhotos.length})</h3>
          <ul className="mt-1 max-h-40 overflow-y-auto text-xs text-muted">
            {q.data.orphanPhotos.map((p) => (
              <li key={p.id}>{p.filename}: {p.reason ?? (p.status === "orphan" ? "no matching row" : "invalid image")}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
