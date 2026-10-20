import { web } from "./db";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** All dashboard metrics in one round of parallel aggregate queries, scoped to the store. */
export async function getMetrics(storeId: string) {
  const sql = web().sql;
  const [statusRows, rowStatus, models, daily, latency, outcomes, perImport, translationRows, productTotals, evals] = await Promise.all([
    sql`select status, count(*)::int as n from products where store_id = ${storeId} and deleted_at is null group by status`,
    sql`select status, count(*)::int as n from import_rows where store_id = ${storeId} group by status`,
    sql`select model, tier, kind, count(*)::int as calls, sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
               sum(cost_micros)::bigint as cost_micros, sum(baseline_cost_micros)::bigint as baseline_micros, round(avg(latency_ms))::int as avg_latency,
               count(*) filter (where batch)::int as batched_calls
        from ai_calls where store_id = ${storeId} group by model, tier, kind order by cost_micros desc nulls last`,
    sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, sum(cost_micros)::bigint as cost_micros,
               sum(baseline_cost_micros)::bigint as baseline_micros, count(*)::int as calls
        from ai_calls where store_id = ${storeId} and created_at > now() - interval '30 days' group by 1 order by 1`,
    sql`select round(avg(latency_ms))::int as avg_ms, percentile_cont(0.95) within group (order by latency_ms)::int as p95_ms,
               max(latency_ms)::int as max_ms, count(*)::int as n
        from ai_calls where store_id = ${storeId} and outcome = 'ok'`,
    sql`select outcome, count(*)::int as n from ai_calls where store_id = ${storeId} group by outcome`,
    sql`select i.id, i.filename, i.status, i.total_rows, i.created_at, i.started_at, i.finished_at,
               (select count(*)::int from import_rows r where r.import_id = i.id and r.status in ('done','needs_review','failed')) as processed,
               (select coalesce(sum(cost_micros),0)::bigint from ai_calls a where a.import_id = i.id) as cost_micros,
               (select count(distinct r.product_id)::int from import_rows r where r.import_id = i.id and r.product_id is not null) as products
        from imports i where i.store_id = ${storeId} order by i.created_at desc limit 20`,
    sql`select locale, state, origin, count(*)::int as n from translations where store_id = ${storeId} group by locale, state, origin`,
    sql`select count(*)::int as n, count(*) filter (where built_input_hash is not null)::int as built from products where store_id = ${storeId} and deleted_at is null`,
    sql`select id, prompt_version, model, provider, sample_size, field_scores, hallucination_rate_bp, cost_micros, created_at
        from eval_runs where store_id = ${storeId} or store_id is null order by created_at desc limit 20`,
  ]);

  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status as string, num(r.n)]));
  const totalProducts = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const rows = Object.fromEntries(rowStatus.map((r) => [r.status as string, num(r.n)]));
  const rowsTotal = Object.values(rows).reduce((a, b) => a + b, 0);
  const rowsFinished = num(rows.done) + num(rows.needs_review) + num(rows.failed);

  const costMicros = models.reduce((a, m) => a + num(m.cost_micros), 0);
  const baselineMicros = models.reduce((a, m) => a + num(m.baseline_micros), 0);
  const built = num(productTotals[0]?.built);

  const coverage: Record<string, { fresh: number; out_of_date: number; missing: number; pending: number; manual: number; total: number }> = {};
  for (const r of translationRows) {
    const loc = r.locale as string;
    coverage[loc] ??= { fresh: 0, out_of_date: 0, missing: 0, pending: 0, manual: 0, total: 0 };
    const c = coverage[loc];
    const n = num(r.n);
    c.total += n;
    if (r.origin === "manual") c.manual += n;
    const state = r.state as "fresh" | "out_of_date" | "missing" | "pending";
    c[state] += n;
  }

  return {
    products: {
      total: totalProducts,
      byStatus,
      approved: num(byStatus.approved),
      needsReview: num(byStatus.needs_review),
      failed: num(byStatus.failed),
    },
    rows: {
      total: rowsTotal,
      byStatus: rows,
      successRate: rowsFinished ? num(rows.done) / rowsFinished : 0,
      reviewRate: rowsFinished ? num(rows.needs_review) / rowsFinished : 0,
      failureRate: rowsFinished ? num(rows.failed) / rowsFinished : 0,
    },
    cost: {
      totalUsd: costMicros / 1e6,
      baselineUsd: baselineMicros / 1e6,
      savedUsd: Math.max(0, baselineMicros - costMicros) / 1e6,
      perProductUsd: built ? costMicros / 1e6 / built : 0,
      per1000ProductsUsd: built ? (costMicros / 1e6 / built) * 1000 : 0,
      daily: daily.map((d) => ({ day: d.day as string, costUsd: num(d.cost_micros) / 1e6, baselineUsd: num(d.baseline_micros) / 1e6, calls: num(d.calls) })),
    },
    models: models.map((m) => ({
      model: m.model as string,
      tier: m.tier as string,
      kind: m.kind as string,
      calls: num(m.calls),
      batchedCalls: num(m.batched_calls),
      inputTokens: num(m.input_tokens),
      outputTokens: num(m.output_tokens),
      costUsd: num(m.cost_micros) / 1e6,
      avgLatencyMs: num(m.avg_latency),
    })),
    latency: {
      avgMs: num(latency[0]?.avg_ms),
      p95Ms: num(latency[0]?.p95_ms),
      maxMs: num(latency[0]?.max_ms),
      calls: num(latency[0]?.n),
    },
    outcomes: Object.fromEntries(outcomes.map((o) => [o.outcome as string, num(o.n)])),
    imports: perImport.map((i) => {
      const start = i.started_at ? new Date(i.started_at as string).getTime() : null;
      const end = i.finished_at ? new Date(i.finished_at as string).getTime() : Date.now();
      const minutes = start ? (end - start) / 60000 : 0;
      return {
        id: i.id as string,
        filename: i.filename as string,
        status: i.status as string,
        totalRows: num(i.total_rows),
        processed: num(i.processed),
        products: num(i.products),
        costUsd: num(i.cost_micros) / 1e6,
        durationSec: start ? Math.round((end - start) / 1000) : null,
        rowsPerMinute: minutes > 0.05 ? Math.round(num(i.processed) / minutes) : null,
      };
    }),
    translations: coverage,
    evals: evals.map((e) => ({
      id: e.id as string,
      promptVersion: e.prompt_version as string,
      model: e.model as string,
      provider: e.provider as string,
      sampleSize: num(e.sample_size),
      fieldScores: e.field_scores as Record<string, number>,
      hallucinationRate: num(e.hallucination_rate_bp) / 10000,
      costUsd: num(e.cost_micros) / 1e6,
      createdAt: new Date(e.created_at as string).toISOString(),
    })),
  };
}

export type Metrics = Awaited<ReturnType<typeof getMetrics>>;
