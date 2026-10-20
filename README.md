# CatalogForge — AI Product Catalog Builder

> Drop in a supplier sheet, get a store-ready catalog in three languages.

CatalogForge turns a merchant's messy supplier spreadsheet and photo folder into a clean, reviewed, multi-language catalog with a live storefront preview. It is built so that a 10,000-row import:
- runs in the background,
- survives AI failures and server restarts,
- never creates duplicates,
- never slows the storefront down.

- **Edge cases first:** [`EDGE-CASES.md`](EDGE-CASES.md), the first commit in the history.
- **Deploy guide:** [`docs/DEPLOY.md`](docs/DEPLOY.md)
- **Sample data:** [`fixtures/`](fixtures/README.md)

---

## Contents
1. [Architecture](#architecture)
2. [Setup](#setup)
3. [Tech stack & design decisions](#tech-stack--design-decisions)
4. [Scale strategy](#scale-strategy)
5. [Accuracy strategy](#accuracy-strategy)
6. [Cost optimisation](#cost-optimisation)
7. [Features (core + bonus)](#features)
8. [Testing, evaluation & load testing](#testing-evaluation--load-testing)
9. [Technical write-up](#technical-write-up)
10. [Screenshots](#screenshots)

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    D[Dashboard<br/>upload · review · metrics]
    S[Storefront<br/>/store/:country]
  end
  subgraph Web["apps/web (Next.js)"]
    API[API routes<br/>+ public API v1]
    SSE[SSE /api/events]
    SF[Storefront pages<br/>own DB pool · cache]
  end
  subgraph Worker["apps/worker (Bun, ×N replicas)"]
    P[parse] --> C[clean] --> G[group + photo match] --> B[AI build<br/>batches of 10] --> T[translate<br/>DE · FR] --> F[finalize<br/>counts invariant]
    R[reconciler<br/>on boot]
    W[webhook outbox]
  end
  PG[(Postgres<br/>source of truth)]
  RD[(Redis + BullMQ<br/>schedules work)]
  AI[[Groq<br/>gpt-oss-20b · gpt-oss-120b · qwen vision]]

  D --> API --> PG
  API -->|enqueue, deterministic job ids| RD
  RD --> P
  B & T --> AI
  P & C & G & B & T & F --> PG
  R -->|re-enqueue unfinished stages| RD
  F --> W
  Worker -->|progress pub/sub| RD --> SSE --> D
  S --> SF -->|storefront_products only| PG
```

**Core rule: Postgres is the source of truth, and Redis only schedules work.**
- Every row, product, field, translation and AI call is a Postgres row with a status.
- Every queue job is idempotent and can be re-derived from those statuses.

So a crash, a retry, a duplicate job or even a flushed Redis can delay an import, but it cannot lose or double anything.

### Monorepo layout (Bun workspaces + Turborepo)

```
apps/web/          Next.js: dashboard, review, storefront, REST + public API, SSE
apps/worker/       BullMQ workers: parse → clean → group → build → translate → finalize, reconciler, webhooks
packages/core/     Pure domain logic with no I/O: cleaning, grouping, photo matching, prompts, AI guards, masking, exports
packages/db/       Drizzle schema, SQL migrations, store-scoped pools
packages/queue/    Queue names, job contracts, enqueue helpers (deterministic job ids)
packages/ai/       Provider interface, Groq provider, deterministic fake provider, cost table
fixtures/          Generated messy sheets + photos (bun run fixtures)
eval/              Labelled test set + evaluation runner
load/              k6 + autocannon storefront load tests
```

## Setup

Requirements: [Bun](https://bun.sh) ≥ 1.3 and Docker.

```bash
docker compose up -d                 # Postgres 16 (:5433) + Redis 7 with AOF (:6380)
bun install
cp .env.example .env                 # add GROQ_API_KEY, or leave it empty for demo mode
bun run db:migrate && bun run db:seed
bun run fixtures                     # generates fixtures/*.csv|xlsx|zip
bun run dev                          # web on http://localhost:3000
bun run worker                       # in a second terminal (run it twice for 2 workers)
```

Log in at `http://localhost:3000/login` with **`demo@catalogforge.dev` / `demo1234`**. Upload `fixtures/small-20.csv` + `fixtures/photos.zip`, then open the storefront at `http://localhost:3000/store/de`.

**Demo mode:** with no `GROQ_API_KEY` (or `AI_PROVIDER=fake`), the app uses a deterministic fake provider and shows a banner. It can also inject failures (`FAKE_AI_FAILURES=rate_limit:0.1,invalid_json:0.1,timeout:0.05`) to demonstrate retries and rate-limit pauses.

**Public API:** the demo key is `cf_demo_0123456789abcdef0123456789abcdef` (see [Public API](#public-api)).

## Tech stack & design decisions

| Layer | Choice | Why |
|---|---|---|
| Runtime / package manager | **Bun** workspaces + Turborepo | Fast installs. The worker runs TypeScript directly. One `bun install` for the whole monorepo. |
| Web | Next.js 15 (App Router), React 19, Tailwind v4, TanStack Table/Query | One app for dashboard, storefront and API. Server components keep storefront pages lean. |
| DB | PostgreSQL 16 + Drizzle ORM | Typed schema. Real unique constraints do the duplicate protection. `ON CONFLICT` upserts make jobs idempotent. |
| Queue | Redis (AOF) + BullMQ | Durable jobs, exponential backoff, stalled-job recovery, global rate limiting. |
| AI | **Groq** (OpenAI-compatible) | Very low latency and cheap open-weight models. Tiers: `openai/gpt-oss-20b` for clean rows, `openai/gpt-oss-120b` for messy ones, `qwen/qwen3.8-27b` for vision. JSON mode. |
| Parsing | SheetJS, papaparse, yauzl (streaming zip), sharp | Streaming where it matters. sharp validates and thumbnails photos. |
| Auth | Built-in: email + password (Bun.password/argon2), hashed session tokens, store membership | Keeps the app runnable with nothing but docker-compose. Every query is scoped by `store_id`. |

Decisions worth calling out:
- **The AI never produces numbers.** Prices, currencies, weights and SKUs come only from deterministic cleaning; the AI writes text. A model cannot corrupt money.
- **Claims need receipts.** The model must return each claim with a verbatim quote and its row/column. The server verifies the quote against that cell, and a quote it can't find drops the claim.
- **The storefront reads a snapshot.** The `storefront_products` table is a denormalised, per-locale snapshot written only when a product is approved or a translation changes. Storefront pages use their own small connection pool with a 2 s statement timeout.
- **Groq Batch API:** it returns `403` on the free tier, so batch mode is behind a setting (`useBatch`). Without it, we batch at the request level instead (10 products per request).

## Scale strategy

| Concern | How it works |
|---|---|
| **Upload returns immediately** | The API streams files to storage, hashes them, inserts the import row and enqueues `parse`. It responds `202` with the import id. All work happens in workers. |
| **Batches, not per-field calls** | One AI request builds ~10 products (all fields at once). One translation request handles many fields for one locale. |
| **Durable queue** | BullMQ on Redis with AOF persistence. Stages: `parse → clean → group → build×N → translate×N → finalize`. |
| **No duplicates (re-upload)** | `UNIQUE(store_id, file_sha256)` on imports: the same file returns the same import. |
| **No duplicates (products)** | `UNIQUE(store_id, product_key)`, `UNIQUE(store_id, sku)`, `UNIQUE(product_id, variant_key)` and `UNIQUE(import_id, row_number)`. Every write is an `INSERT … ON CONFLICT` upsert. |
| **Changed rows update products** | A modified file regroups to the same `product_key` and updates in place. A product whose `input_hash` is unchanged **skips the AI entirely**. |
| **Deterministic job ids** | e.g. `<importId>:group`, `build:<importId>:<batch>`. Enqueueing twice (double-click, retry, reconciler) is a no-op. |
| **Restart mid-import** | Workers trap `SIGTERM`. Jobs from a crashed worker are recovered by BullMQ stalled-job detection. On boot, a **reconciler** reads non-terminal imports from Postgres and re-enqueues whatever is unfinished, even if Redis was wiped. Upserts make replays harmless. |
| **Every row ends somewhere** | Rows finish as `done`, `needs_review` or `failed` (with a reason). `finalize` asserts `done + needs_review + failed = total_rows` before completing the import. |
| **Retries** | Exponential backoff with jitter on 5xx, timeouts (60 s) and invalid JSON. Invalid JSON gets one "repair" re-ask with the validation error first. |
| **Rate limits** | A 429 reads `retry-after` and pauses the queue globally (`worker.rateLimit`); the job is *not* counted as a failed attempt. The import shows **"Paused — resuming in X min"** and resumes automatically. |
| **Provider down** | A circuit breaker opens after consecutive failures and pauses work instead of burning every job's attempts. |
| **Two imports at once** | Shared worker pool with per-stage concurrency. Products from both imports upsert on the same unique keys. |
| **Storefront stays fast** | Snapshot table, its own DB pool, `unstable_cache` with per-store tags (invalidated on publish), and no AI or translation at request time. |

## Accuracy strategy

1. **Cleaning before AI** (`packages/core/src/cleaning`):
   - Prices: locale-aware parsing to integer cents + ISO currency (`1.299,00 €` → 129900 EUR, `£8` → 800 GBP).
   - Units: cm/inch/mm → cm, g/kg/lb/oz → grams.
   - Text: mojibake repair, colour typo correction (`terracota` → terracotta), German/French colour names.
   - HTML sanitising.
   - Header detection with EN/DE/FR synonyms, even when the header isn't on line 1.
   - Language detection.
   - Every correction is recorded as an issue the reviewer can see.
2. **Grouping:** rows are grouped by base SKU, parent SKU or brand + normalised name, whatever the row order. Exact duplicates are merged; conflicting duplicates are flagged, not guessed.
3. **Prompting:** the source rows are passed as data with row numbers and column names, with these rules:
   - copy hedges ("frost-resistant, not frost-proof")
   - never upgrade a claim
   - leave unknown fields empty
   - pick categories from a fixed taxonomy
   - give a per-field confidence
4. **Deterministic guards** (`packages/core/src/ai/guards.ts`):
   - Claim quotes are verified against the cited cell.
   - A risky-term lexicon (frost-proof, waterproof, organic, handmade, dishwasher-safe, BPA-free, …) is checked against all generated text, with negation awareness.
   - Category must come from the taxonomy.
   - SKU, price and weight are validated.
   - Unique handles.
5. **Gating:** a product goes to **Needs review** with a human-readable reason if any of these hold:
   - a field's confidence is below the threshold (default 70)
   - a dropped claim, conflict or missing price
6. **Evaluation:** a labelled set and `bun run eval` (see below) track per-field accuracy and the hallucinated-claim rate.

## Cost optimisation

- **Smart routing:** each product group gets a messiness score from:
  - cleaning issues
  - missing fields
  - non-English text
  - conflicts
  - description length

  Clean groups go to `gpt-oss-20b`, messy ones to `gpt-oss-120b`. The vision model is used only when photos exist and the text can't describe the product.
- **Skip unchanged:** re-imports skip products whose input hash didn't change ($0).
- **Batching:** 10 products per request amortises the system prompt; translations are batched per locale.
- **Batch API:** supported behind `useBatch` where the provider allows it (Groq free tier: not available).
- **Tracking:** every AI call is stored in `ai_calls` with model, tier, tokens, latency, outcome, cost, and a **baseline cost** (the same tokens on the strong model). The Metrics tab shows cost per product, per model and per import, plus **money saved** = baseline − actual.

## Features

Core:
- Drag-and-drop upload of CSV/XLSX + photos (files or ZIP), with type/size limits and clear errors.
- Live per-import progress, per-row status, and retry for failed rows.
- Data cleaning, grouping into variants, duplicate detection, photo matching (orphans listed), HTML sanitising.
- AI builder with structured JSON, per-field confidence, claims with sources, and Needs-review reasons.
- DE/FR translation. Brands, `{{placeholders}}`, HTML, numbers and units are protected by token masking and verified on the way back. Only changed fields are re-translated. Manual fixes always win and are marked **Out of date** when the English changes.
- Products table: pagination 10/25/50/100, sorting, search, filters, colour-coded confidence. Side-by-side review (source rows + photos ↔ AI result), edit, approve, send back, bulk approve.
- Export as CSV, JSON and **Shopify product CSV**.
- Storefront: collection and product pages in the visitor's language by country (DE/AT/CH → German, FR/BE → French, everyone else English), a country switcher, mobile-first.
- Metrics: processed, success/review/failure rates, model usage, cost over time, speed (avg/slowest), translation coverage and the out-of-date count.

Bonus — all levels:

| Level | Feature | Where |
|---|---|---|
| L1 | Real-time progress via **SSE** (Redis pub/sub) | `apps/web/app/api/events` |
| L1 | **Re-run AI** on selected products with a different model tier, prompt version or temperature | Products tab → Re-run |
| L1 | **SEO fields** (meta title/description) per language | AI output + translations + storefront `<head>` |
| L2 | **Evaluation framework**: labelled set, per-field accuracy, hallucination rate | `eval/` |
| L2 | **A/B testing** of prompt versions/models (`--prompt v1,v2`; prompt version per import) | `eval/run.ts`, Metrics |
| L2 | **Parallel processing** with worker queues (run N worker replicas) | `apps/worker` |
| L3 | **Auth + multiple stores** with complete data separation (every query scoped by `store_id`) | `apps/web/lib/auth.ts` |
| L3 | **Webhook** on import finish (HMAC-signed, outbox + retries) | Settings → Webhook |
| L3 | **Public API** for programmatic imports (`Authorization: Bearer cf_…`) | `/api/v1/imports` |
| L3 | **Shopify product CSV** export | Products → Export |

### Public API

```bash
curl -X POST http://localhost:3000/api/v1/imports \
  -H "Authorization: Bearer cf_demo_0123456789abcdef0123456789abcdef" \
  -F sheet=@fixtures/small-20.csv -F photos=@fixtures/photos.zip
# → 202 {"id":"…","status":"queued"}

curl http://localhost:3000/api/v1/imports/<id> -H "Authorization: Bearer cf_demo_…"
```

## Testing, evaluation & load testing

```bash
bun test packages            # unit tests: cleaning, grouping, guards, masking, exports
bun run test:int             # integration: restart mid-import, re-upload, rate limits, invented claims, isolation
bun run eval -- --prompt v1,v2 --verbose     # accuracy on the labelled set
k6 run -e BASE_URL=http://localhost:3000 -e HANDLE=<handle> load/storefront.js
load/autocannon.sh http://localhost:3000 <handle>                # if k6 isn't installed
```

The restart demo:
1. Start a 10k import (`fixtures/bulk-10000.csv`).
2. `kill -9` the worker at ~40%, then start it again.
3. The import resumes, and the final counts add up to exactly 10,000 with no duplicate SKUs or handles.

## Technical write-up

**What was the hardest part?**
Making "nothing lost, nothing doubled" hold under every failure: crash mid-stage, Redis loss, duplicate jobs, two imports touching the same product. The answer was to stop trusting the queue. Postgres row statuses are the truth, the queue is a scheduler, and every write is a keyed upsert. After that, the restart story is "run the reconciler", and the counts invariant is a SQL query.

**How did you make extraction accurate, and how did you stop invented claims?**
Most of the accuracy comes before and after the model, not from it:
- Deterministic cleaning handles prices, units, colours, encoding and grouping.
- The model never writes numbers.
- Every claim needs a verbatim quote that the server finds in the cited cell.
- A negation-aware risky-term lexicon catches claims smuggled into titles, descriptions or tags.
- Low confidence or any guard intervention routes the product to review instead of the storefront.

The eval harness found one real gap during development: a claim like "frost-proof" could pass quote verification when quoted from "not frost-proof". That's exactly the failure the hallucination metric exists to catch, so the negation check has to apply to verified claims as well.

**Measured numbers** <!-- MEASURED: fill in from runs -->

| Metric | Value | How measured |
|---|---|---|
| Throughput (fake provider) | <!-- MEASURED --> rows/min | `bulk-10000.csv`, 2 workers, local |
| Throughput (Groq free tier) | <!-- MEASURED --> rows/min | `messy-500.xlsx`; bound by the 8k tokens/min free-tier limit |
| Storefront p95, idle | <!-- MEASURED --> ms | autocannon, 100 connections, product page |
| Storefront p95, during 10k import | <!-- MEASURED --> ms | same, while the import runs |
| Cost per 1,000 products | $<!-- MEASURED --> | `ai_calls` sum ÷ products |
| Savings from routing + skip-unchanged | <!-- MEASURED -->% | baseline vs actual on the Metrics tab |
| Eval: category / material / hallucinated claims | <!-- MEASURED --> | `bun run eval` |

**What breaks first at 1,000,000 products in 8 languages, and how would you fix it?**
1. **Translation volume.** 1M products × ~6 fields × 8 locales ≈ 48M strings.
   - Synchronous calls and rate limits break first.
   - Fix: provider batch APIs (≈50% cheaper, no rate-limit pressure).
   - Fix: translation memory keyed by `hash(source text, locale)`. Supplier catalogs repeat a lot.
   - Fix: keep per-field hashing so edits only re-translate what changed.
2. **The `storefront_products` snapshot** grows to 9M rows (1M × 9 locales).
   - Fix: partition by `store_id`/locale.
   - Fix: serve product pages from a CDN with tag-based purge on publish. Product pages are effectively static.
3. **`import_rows` growth.** Every import keeps its raw rows.
   - Fix: partition by month and expire raw rows after N days, keeping only the outcome.
4. **Postgres write throughput during big imports.** Row-by-row upserts become the bottleneck.
   - Fix: `COPY` into an unlogged staging table, then set-based `INSERT … SELECT … ON CONFLICT`.
   - Fix: a read replica for the dashboard and storefront.
5. **Redis memory / job fan-out.**
   - Fix: keep jobs chunked (ids, not payloads) and cap retained completed jobs.
   - Fix: move to per-tenant queues for fairness.

**What did you learn?**
Reliability work is mostly designing what's stored, not adding retries. Once every unit of work has a durable status and a natural key, retries, restarts and duplicates stop being special cases. On accuracy: a small labelled set paid for itself immediately. It found a negation bug that would have shipped "frost-proof" to a storefront.

**How did you use AI while building this?**
AI coding agents as pair programmers:
- The plan and EDGE-CASES.md first.
- Then parallel agents on separate packages (core logic, worker pipeline, dashboard, storefront/eval/docs) against shared contracts: DB schema, queue job types, core types.

Every module was reviewed, typechecked and tested. The eval harness and fixtures were also used to check the AI-written code's own claims.

## Screenshots

<!-- Add screenshots / GIFs: upload queue with live progress, paused-for-rate-limit banner, review side-by-side, storefront DE/FR, metrics dashboard. -->

| Upload & progress | Review | Storefront (DE) | Metrics |
|---|---|---|---|
| _todo_ | _todo_ | _todo_ | _todo_ |
