"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Check, Download, RefreshCw, Search, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { api, ConfidenceChip, Empty, formatMoney, StatusBadge } from "@/components/ui";
import { useLiveProgress } from "@/components/use-progress";

interface ProductRow {
  id: string;
  handle: string;
  title: string | null;
  status: string;
  category: string | null;
  minConfidence: number | null;
  reviewReasons: string[];
  updatedAt: string;
  model: string | null;
  variantCount: number;
  firstSku: string | null;
  priceFrom: number | null;
  currency: string | null;
  thumbKey: string | null;
  staleTranslations: number;
}

const PAGE_SIZES = [10, 25, 50, 100];
const SORTABLE = new Set(["title", "status", "min_confidence", "updated_at", "category"]);

export default function ProductsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <ProductsInner />
    </Suspense>
  );
}

function ProductsInner() {
  useLiveProgress();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated_at", desc: true }]);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [confidence, setConfidence] = useState("");
  const [translation, setTranslation] = useState("");
  const [category, setCategory] = useState("");
  const importId = params.get("importId") ?? "";
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [rerunOpen, setRerunOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const filterQs = useMemo(() => {
    const s = new URLSearchParams();
    if (q) s.set("q", q);
    if (status) s.set("status", status);
    if (confidence) s.set("confidence", confidence);
    if (translation) s.set("translation", translation);
    if (category) s.set("category", category);
    if (importId) s.set("importId", importId);
    return s;
  }, [q, status, confidence, translation, category, importId]);

  const sort = sorting[0];
  const listQs = new URLSearchParams(filterQs);
  listQs.set("page", String(page));
  listQs.set("pageSize", String(pageSize));
  if (sort) {
    listQs.set("sort", sort.id);
    listQs.set("dir", sort.desc ? "desc" : "asc");
  }

  const data = useQuery({
    queryKey: ["products", listQs.toString()],
    queryFn: () => api<{ rows: ProductRow[]; total: number }>(`/api/products?${listQs.toString()}`),
    placeholderData: keepPreviousData,
  });

  const bulk = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ approved?: number; blocked?: Array<{ title: string | null }>; updated?: number; queued?: number }>("/api/products/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: Object.keys(selection), ...body }),
      }),
    onSuccess: (r) => {
      setSelection({});
      setRerunOpen(false);
      if (r.approved !== undefined) {
        setMessage(`Approved ${r.approved}.${r.blocked?.length ? ` ${r.blocked.length} blocked (missing price).` : ""}`);
      } else if (r.queued !== undefined) setMessage(`Re-running AI on ${r.queued} products.`);
      else setMessage(`Sent back ${r.updated ?? 0} products for review.`);
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const columns = useMemo<ColumnDef<ProductRow>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select page"
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input type="checkbox" aria-label="Select row" checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} />
        ),
      },
      {
        id: "title",
        header: "Product",
        cell: ({ row: { original: p } }) => (
          <Link href={`/products/${p.id}`} className="flex min-w-56 items-center gap-3">
            {p.thumbKey ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/files/${p.thumbKey}`} alt="" className="h-10 w-10 flex-none rounded object-cover" loading="lazy" />
            ) : (
              <div className="h-10 w-10 flex-none rounded bg-surface-2" />
            )}
            <div className="min-w-0">
              <div className="truncate font-medium hover:underline">{p.title ?? p.handle}</div>
              <div className="truncate text-xs text-muted">
                {p.firstSku ?? "no SKU"} · {p.variantCount} variant{p.variantCount === 1 ? "" : "s"}
              </div>
            </div>
          </Link>
        ),
      },
      { id: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      {
        id: "min_confidence",
        header: "Confidence",
        cell: ({ row }) => <ConfidenceChip value={row.original.minConfidence} />,
      },
      {
        id: "category",
        header: "Category",
        cell: ({ row }) => <span className="block max-w-56 truncate text-muted">{row.original.category ?? "–"}</span>,
      },
      {
        id: "price",
        header: "Price from",
        cell: ({ row }) => <span className="tabular-nums">{formatMoney(row.original.priceFrom, row.original.currency)}</span>,
      },
      {
        id: "review",
        header: "Review reason",
        cell: ({ row: { original: p } }) => (
          <div className="max-w-72 text-xs">
            {p.reviewReasons[0] && <div className="truncate text-warn" title={p.reviewReasons.join("\n")}>{p.reviewReasons[0]}{p.reviewReasons.length > 1 ? ` (+${p.reviewReasons.length - 1})` : ""}</div>}
            {p.staleTranslations > 0 && <div className="text-muted">{p.staleTranslations} translation(s) stale/missing</div>}
          </div>
        ),
      },
      {
        id: "updated_at",
        header: "Updated",
        cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted">{new Date(row.original.updatedAt).toLocaleString()}</span>,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: data.data?.rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
    manualPagination: true,
    manualSorting: true,
    enableRowSelection: true,
    state: { sorting, rowSelection: selection },
    onSortingChange: (u) => {
      setSorting(u);
      setPage(1);
    },
    onRowSelectionChange: setSelection,
  });

  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const selected = Object.keys(selection).length;

  function toggleSort(id: string) {
    if (!SORTABLE.has(id)) return;
    setSorting((s) => (s[0]?.id === id ? [{ id, desc: !s[0].desc }] : [{ id, desc: id !== "title" && id !== "category" }]));
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-sm text-muted">{total.toLocaleString()} products{importId ? " in this import" : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["csv", "json", "shopify"] as const).map((f) => (
            <a key={f} className="btn" href={`/api/exports?format=${f}&${filterQs.toString()}`}>
              <Download size={14} /> {f === "shopify" ? "Shopify CSV" : f.toUpperCase()}
            </a>
          ))}
        </div>
      </div>

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <label className="relative min-w-52 flex-1">
          <Search size={14} className="absolute left-2.5 top-2.5 text-muted" aria-hidden />
          <input className="input pl-8" placeholder="Search title, handle or SKU" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        </label>
        <select aria-label="Status" className="input w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="needs_review">Needs review</option>
          <option value="approved">Approved</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
          <option value="rejected">Rejected</option>
        </select>
        <select aria-label="Confidence" className="input w-auto" value={confidence} onChange={(e) => { setConfidence(e.target.value); setPage(1); }}>
          <option value="">Any confidence</option>
          <option value="high">High (≥85)</option>
          <option value="medium">Medium (70–84)</option>
          <option value="low">Low (&lt;70)</option>
        </select>
        <select aria-label="Translations" className="input w-auto" value={translation} onChange={(e) => { setTranslation(e.target.value); setPage(1); }}>
          <option value="">Any translation state</option>
          <option value="out_of_date">Out of date</option>
          <option value="missing">Missing</option>
          <option value="manual">Manually edited</option>
        </select>
        <input aria-label="Category" className="input w-44" placeholder="Category prefix" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} />
        {importId && (
          <button className="btn" onClick={() => router.replace("/products")}>Clear import filter</button>
        )}
      </div>

      {selected > 0 && (
        <div className="card flex flex-wrap items-center gap-2 border-accent/40 p-3 text-sm">
          <span className="font-medium">{selected} selected</span>
          <button className="btn" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: "approve" })}><Check size={14} /> Approve</button>
          <button className="btn" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: "send_back" })}><Undo2 size={14} /> Send back</button>
          <button className="btn" disabled={bulk.isPending} onClick={() => setRerunOpen(true)}><RefreshCw size={14} /> Re-run AI…</button>
          <button className="btn ml-auto" onClick={() => setSelection({})}>Clear</button>
        </div>
      )}
      {message && <p className="text-sm text-muted" role="status">{message}</p>}
      {rerunOpen && <RerunDialog count={selected} pending={bulk.isPending} onCancel={() => setRerunOpen(false)} onRun={(overrides) => bulk.mutate({ action: "rerun", overrides })} />}

      {data.error ? (
        <p className="text-sm text-bad">{(data.error as Error).message}</p>
      ) : !data.isLoading && total === 0 ? (
        <Empty>No products match. Upload a sheet on the Upload tab.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const sortable = SORTABLE.has(h.column.id);
                    const active = sort?.id === h.column.id;
                    return (
                      <th key={h.id} className="whitespace-nowrap px-3 py-2 font-medium">
                        {sortable ? (
                          <button className="inline-flex items-center gap-1 hover:text-text" onClick={() => toggleSort(h.column.id)}>
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {active && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className={clsx(data.isFetching && "opacity-70")}>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className={clsx("border-t border-border", row.getIsSelected() && "bg-accent/5")}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-middle">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          Rows per page
          <select className="input w-auto py-1" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn" disabled={page <= 1} onClick={() => setPage(1)}>«</button>
          <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span className="tabular-nums text-muted">Page {page} of {pages}</span>
          <button className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          <button className="btn" disabled={page >= pages} onClick={() => setPage(pages)}>»</button>
        </div>
      </div>
    </div>
  );
}

function RerunDialog({
  count,
  pending,
  onCancel,
  onRun,
}: {
  count: number;
  pending: boolean;
  onCancel: () => void;
  onRun: (o: { tier?: string; promptVersion?: string; temperature?: number; overwriteManual?: boolean }) => void;
}) {
  const [tier, setTier] = useState("strong");
  const [promptVersion, setPromptVersion] = useState("v2");
  const [temperature, setTemperature] = useState(0.2);
  const [overwriteManual, setOverwriteManual] = useState(false);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true" aria-label="Re-run AI">
      <div className="card w-full max-w-md space-y-4 p-5">
        <h2 className="text-lg font-semibold">Re-run AI on {count} product{count === 1 ? "" : "s"}</h2>
        <label className="block text-sm">
          Model tier
          <select className="input mt-1" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="cheap">Cheap (fast)</option>
            <option value="strong">Strong</option>
            <option value="vision">Vision (uses photos)</option>
          </select>
        </label>
        <label className="block text-sm">
          Prompt version
          <select className="input mt-1" value={promptVersion} onChange={(e) => setPromptVersion(e.target.value)}>
            <option value="v1">v1</option>
            <option value="v2">v2</option>
          </select>
        </label>
        <label className="block text-sm">
          Temperature: {temperature.toFixed(1)}
          <input type="range" min={0} max={1} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="mt-1 w-full" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={overwriteManual} onChange={(e) => setOverwriteManual(e.target.checked)} />
          Overwrite manual edits
        </label>
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" disabled={pending} onClick={() => onRun({ tier, promptVersion, temperature, overwriteManual })}>Re-run</button>
        </div>
      </div>
    </div>
  );
}
