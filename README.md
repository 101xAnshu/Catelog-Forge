# CatalogForge — AI Product Catalog Builder

> Drop in a supplier sheet, get a store-ready catalog in three languages.

CatalogForge turns a merchant's messy supplier spreadsheet and photo folder into a clean, reviewed, multi-language catalog with a live storefront preview. It is built so that a 10,000-row import:
- runs in the background,
- survives AI failures and server restarts,
- never creates duplicates,
- never takes the storefront down: reads come from a denormalized snapshot on their own pool, so an import competes for CPU but never for locks, AI capacity or the read path.

- **Edge cases first:** [`EDGE-CASES.md`](EDGE-CASES.md), the first commit in the history.
- **Live demo:** [`https://15-135-152-250.sslip.io`](https://15-135-152-250.sslip.io). The demo is private: the proxy asks for HTTP basic auth (reviewer credentials are shared with the submission, not committed here). Then log in with the prefilled demo account **`demo@catalogforge.dev` / `demo1234`**, upload `fixtures/small-20.csv` + `fixtures/photos.zip`, or call the [public API](#public-api) with the demo key. Hosted on a 2 GB AWS Lightsail instance — see [`deploy/aws/README.md`](deploy/aws/README.md) for why (Postgres + Redis + a long-running worker don't fit serverless free tiers). It runs the real provider at ≈26 rows/min end-to-end, so a 500-row sheet is minutes, not seconds; the instant 10,000-row scale demo is `AI_PROVIDER=fake` locally (see below).
- **Deploy guide:** [`docs/DEPLOY.md`](docs/DEPLOY.md). One Docker image (migrations, demo seed, worker and web), so you only set `DATABASE_URL`, `REDIS_URL`, `OPENCODE_API_KEY` and `APP_URL`. Railway: `railway.json`. Any VPS: `docker compose -f docker-compose.prod.yml up -d`.
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
    P[parse] --> C[clean] --> G[group + photo match] --> B[AI build<br/>5 products / call] --> T[translate<br/>DE · FR] --> F[finalize<br/>counts invariant]
    R[reconciler<br/>on boot + every 30 s]
    W[webhook outbox]
  end
  PG[(Postgres<br/>source of truth)]
  RD[(Redis + BullMQ<br/>schedules work)]
  AI[[OpenCode Go<br/>mimo-v2.6-flash · mimo-v2.5 · qwen3.8-flash vision<br/>→ free-model fallback]]

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
packages/ai/       Provider interface, OpenCode Go provider (default), Groq provider, deterministic fake provider, cost table
fixtures/          Sample sheets + photos (slices of a real supplier export)
eval/              Labelled test set + evaluation runner
load/              k6 + autocannon storefront load tests
```

## Setup

Requirements: [Bun](https://bun.sh) ≥ 1.3 and Docker.

```bash
docker compose up -d                 # Postgres 16 (:5433) + Redis 7 with AOF (:6380)
bun install
cp .env.example .env                 # add OPENCODE_API_KEY (or GROQ_API_KEY), or leave both empty for demo mode
bun run db:migrate && bun run db:seed
bun run dev                          # web on http://localhost:3000
bun run worker                       # in a second terminal (run it twice for 2 workers)
```

Log in at `http://localhost:3000/login` with **`demo@catalogforge.dev` / `demo1234`**. Upload `fixtures/small-20.csv` **together with** `fixtures/photos.zip` (photos only match products from the same upload), approve a few products, then open the storefront at `http://localhost:3000/store?country=DE`.

**AI keys (`.env`):**

| Variable | Purpose |
|---|---|
| `OPENCODE_API_KEY` | OpenCode Go subscription key. Used by default when set. |
| `GROQ_API_KEY` | Optional. Used when no OpenCode key is set (free tier is heavily rate limited, see below). |
| `AI_PROVIDER` | Optional override: `opencode`, `groq` or `fake`. |
| `OPENCODE_MODELS_CHEAP` / `_STRONG` / `_VISION` | Optional comma-separated model chains, e.g. `deepseek-v4.1-flash,mimo-v2.6-flash`. |
| `WORKER_BUILD_CONCURRENCY` / `WORKER_TRANSLATE_CONCURRENCY` | Parallel AI calls per worker (defaults 4 / 2; we run 8 / 8 on OpenCode Go, which has no per-minute limit). |

Provider selection: `AI_PROVIDER` if set, otherwise **OpenCode Go → Groq → fake**.

**Demo mode:** with no AI key (or `AI_PROVIDER=fake`), the app uses a deterministic fake provider and shows a banner. It can also inject failures (`FAKE_AI_FAILURES=rate_limit:0.1,invalid_json:0.1,timeout:0.05`) to demonstrate retries and rate-limit pauses. Use it for the 10k-row scale demo: it finishes in about a minute.

**Sample data:** `fixtures/` holds three sheets cut from the same real supplier export plus that supplier's photo folder, so every sheet works with the same zip: `small-20.csv` (20 rows → 7 products, all with photos), `messy-500.xlsx` (500 real rows, German headers on line 4, 365 products), `bulk-10000.csv` (10,000 rows → 3,447 products, 1,409 photos attach) and `photos.zip` (1,437 real photos: SKU-named, plus 15 `OLD-*`/5 `MISC-*` orphans, a text file named `.jpg`, a PDF named `.jpg` and three 4,200×3,000 photos). See [`fixtures/README.md`](fixtures/README.md) for the slice rules and the full list of real-world mess. The 11,576-row export itself is not tracked (supplier data); any sheet over **10,000 rows** is rejected by design with `TOO_MANY_ROWS`.

**Public API:** the demo key is `cf_demo_0123456789abcdef0123456789abcdef` (see [Public API](#public-api)).

## Tech stack & design decisions

| Layer | Choice | Why |
|---|---|---|
| Runtime / package manager | **Bun** workspaces + Turborepo | Fast installs. The worker runs TypeScript directly. One `bun install` for the whole monorepo. |
| Web | Next.js 15 (App Router), React 19, Tailwind v4, TanStack Table/Query | One app for dashboard, storefront and API. Server components keep storefront pages lean. |
| DB | PostgreSQL 16 + Drizzle ORM | Typed schema. Real unique constraints do the duplicate protection. `ON CONFLICT` upserts make jobs idempotent. |
| Queue | Redis (AOF) + BullMQ | Durable jobs, exponential backoff, stalled-job recovery, global rate limiting. |
| AI | **OpenCode Go** (OpenAI-compatible, default) · Groq (fallback) | OpenCode Go limits are per model and in dollars, not tokens/minute, so spreading work across models removes rate-limit pauses. Tiers: `mimo-v2.6-flash` (clean rows), `mimo-v2.5` (messy rows), `qwen3.8-flash` (vision), each falling back to free models. JSON mode. |
| Parsing | SheetJS, papaparse, yauzl (streaming zip), sharp | Streaming where it matters. sharp validates and thumbnails photos. |
| Auth | Built-in: email + password (scrypt), hashed session tokens, store membership | Keeps the app runnable with nothing but docker-compose. Every query is scoped by `store_id`. |

Decisions worth calling out:
- **The AI never produces numbers.** Prices, currencies, weights and SKUs come only from deterministic cleaning; the AI writes text. A model cannot corrupt money.
- **Claims need receipts.** The model must return each claim with a verbatim quote and its row/column. The server verifies the quote against that cell, and a quote it can't find drops the claim.
- **The storefront reads a snapshot.** The `storefront_products` table is a denormalised, per-locale snapshot written only when a product is approved or a translation changes. Storefront pages use their own small connection pool with a 2 s statement timeout.
- **Why OpenCode Go instead of Groq.** We started on Groq's free tier and measured its limits: about **8,000 tokens/minute** and **~1,000 requests/day per model**, and its Batch API returns `403`. At ~2,075 tokens per product, a 10k-row sheet (~3,400 products) needs ~7M tokens: 14+ hours of pauses, and the daily cap stops it first. OpenCode Go (`https://opencode.ai/inference/go/openai/v1`) bills against per-model dollar allowances with no documented per-minute limit, so we moved there and kept Groq as a fallback provider.
- **OpenCode Go specifics** (`packages/ai/src/opencode.ts`): every request carries a stable `x-opencode-session` header (required). Each tier is a **chain of models**; a model that hits its quota or a rate limit is cooled down and the next model takes the call, ending with the free models `minimax-m3.1-flash-free` and `longcat-2.5-preview-free`. The queue only pauses when **every** model in a chain is limited at once. A model the workspace can't use (e.g. `deepseek-v4.1-flash` needs the workspace's **Global** region in Privacy settings) is skipped for an hour. Override chains with `OPENCODE_MODELS_<TIER>`.
- **No batch API.** Neither provider offers a usable batch API for this account (Groq: `403`; OpenCode Go: none documented), so `useBatch` stays a setting and we batch at the request level instead: 5 products per build call, up to 15 fields per translation call.

## Scale strategy

| Concern | How it works |
|---|---|
| **Upload returns immediately** | The API streams files to storage, hashes them, inserts the import row and enqueues `parse`. It responds `202` with the import id. All work happens in workers. |
| **Batches, not per-field calls** | One AI request builds 5 products (all fields at once). One translation request handles up to 15 fields for one locale. |
| **Durable queue** | BullMQ on Redis with AOF persistence. Stages: `parse → clean → group → build×N → translate×N → finalize`. |
| **No duplicates (re-upload)** | `UNIQUE(store_id, file_sha256)` on imports: the same file returns the same import. |
| **No duplicates (products)** | `UNIQUE(store_id, product_key)`, `UNIQUE(store_id, sku)`, `UNIQUE(product_id, variant_key)` and `UNIQUE(import_id, row_number)`. Every write is an `INSERT … ON CONFLICT` upsert. |
| **Changed rows update products** | A modified file regroups to the same `product_key` and updates in place. A product whose `input_hash` is unchanged **skips the AI entirely**. |
| **Deterministic job ids** | e.g. `<importId>:group`, `build:<importId>:<batch>`. Enqueueing twice (double-click, retry, reconciler) is a no-op. |
| **Restart mid-import** | Workers trap `SIGTERM`. Jobs from a crashed worker are recovered by BullMQ stalled-job detection. On boot and every 30 s, a **reconciler** reads non-terminal imports from Postgres and re-enqueues whatever is unfinished, even if Redis was wiped. Upserts make replays harmless. A finished (completed/failed) job that still holds the same deterministic id is cleared first, so a deliberate re-queue is never silently swallowed (a bug we hit in testing). Stale queue-wide rate limits from a previous worker session are cleared on boot. |
| **Every row ends somewhere** | Rows finish as `done`, `needs_review` or `failed` (with a reason). `finalize` asserts `done + needs_review + failed = total_rows` before completing the import. |
| **Retries** | Exponential backoff with jitter on 5xx, timeouts (60 s) and invalid JSON. Invalid JSON gets one "repair" re-ask with the validation error first. |
| **Rate limits** | On OpenCode Go a limited model is skipped in favour of the next model in its chain. Only when a whole chain is limited does a 429 pause the queue globally (`worker.rateLimit`, honouring `retry-after`); the job is *not* counted as a failed attempt. The import shows **"Paused — resuming in X min"** and resumes automatically. |
| **Provider down** | A circuit breaker opens after consecutive failures and pauses work instead of burning every job's attempts. |
| **Two imports at once** | Shared worker pool with per-stage concurrency. Products from both imports upsert on the same unique keys. |
| **Cancel** | `POST /api/imports/:id/cancel` marks unfinished rows `failed` ("Import cancelled") so the counts still add up, fails products the AI hadn't built yet, removes queued jobs, and workers skip jobs already picked up. The reconciler and finalize treat `cancelled` as terminal. |
| **Delete a past run** | `DELETE /api/imports/:id` (finished, failed or cancelled runs only) undoes the run: rows, photos, uploaded files and the products it last touched (plus their storefront entries). Products a later import updated, and AI cost history, are kept. |
| **Re-upload after cancel/fail** | The old import gives up its file hash (renamed `…:superseded:<id>`, history kept), so the same file can run again. Completed or running imports still dedupe. |
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
2. **Grouping:** rows are grouped by base SKU, parent SKU, **SKU family** (`PLN-1066-16-A` and `PLN-1066-30-T` → `PLN-1066`, so an English and a German row of the same product join) or brand + normalised name, whatever the row order. Bare model numbers keep products apart ("Planter 1" ≠ "Planter 2"). Exact duplicates are merged; conflicting duplicates are flagged, not guessed.
   - Photos match by SKU in the filename, by **SKU prefix** (`PLN-1066.jpg`, `PLN-1066-2.jpg` → product `PLN-1066`), or by the sheet's image column. Ambiguous or unmatched photos are listed as orphans, never guessed.
   - On a real 11.5k-row supplier sheet with 1,437 photos, these fixes took photo matches from **1,043 → 1,409** (the remaining 28 are genuine orphans such as `MISC-*`/`OLD-*`) and merged split variants from **5,051 → 3,547** products.
3. **Prompting:** the source rows are passed as data with row numbers and column names, with these rules:
   - copy hedges ("frost-resistant, not frost-proof")
   - never upgrade a claim
   - leave unknown fields empty
   - pick categories from a fixed taxonomy
   - give a per-field confidence
4. **Deterministic guards** (`packages/core/src/ai/guards.ts`):
   - Claim quotes are verified against the cited cell.
   - A risky-term lexicon (frost-proof, waterproof, organic, handmade, dishwasher-safe, BPA-free, …) is checked against all generated text, with negation awareness.
   - Category must come from the taxonomy. Known supplier synonyms (`Home Decor > Cushions`, `Storage > Baskets`, `Kitchen & Dining > Boards`, `Lighting > Table Lamps`, …) map to their node **without** a review flag; real misses map to the nearest node (or `Uncategorized`) and go to review. On a real-data run this cut category review flags from **15 → 0** and needs-review products from **16 → 10** of 22 (the rest are genuine: missing prices, conflicting prices, mixed-language names).
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

  Clean groups go to the cheap tier (`mimo-v2.6-flash`), messy ones to the strong tier (`mimo-v2.5`). The vision tier (`qwen3.8-flash`) is used only when photos exist and the text can't describe the product.
- **Spread across quotas:** OpenCode Go limits are per model, so tiers use different models and each chain ends in **free models** (`minimax-m3.1-flash-free`, `longcat-2.5-preview-free`) that keep working after a paid model's allowance runs out.
- **Skip unchanged:** re-imports skip products whose input hash didn't change ($0).
- **Batching:** 5 products per build request amortises the system prompt; up to 15 fields per translation request, per locale.
- **Batch API:** not available on either provider for this account (Groq free tier returns `403`; OpenCode Go documents none). `useBatch` is kept as a setting for providers that offer one.
- **Measured token usage** on real models: ≈ **1,275 input + 800 output tokens per product** with 5-product build batches (build ≈ 600 / 245, DE + FR translation ≈ 675 / 555). On the live 2 GB host builds run one product per call, which measures ≈ **2,933 input + 2,124 output per product** — build batching is the single biggest input-token lever.
- **Cost note:** OpenCode Go bills against a monthly allowance and doesn't publish per-token prices for these models, so `packages/ai/src/cost.ts` uses estimated prices (free models at $0). Cost figures for OpenCode Go runs are therefore estimates; Groq figures use its list prices.
- **Tracking:** every AI call is stored in `ai_calls` with model, tier, tokens, latency, outcome, cost, and a **baseline cost** (the same tokens on the strong model). The Metrics tab shows cost per product, per model and per import, plus **money saved** = baseline − actual.

## Features

Core:
- Drag-and-drop upload of CSV/XLSX + photos (files or ZIP), with type/size limits and clear errors.
- Live per-import progress, per-row status, retry for failed rows, **cancel** for running imports and a **delete** (trash) icon for past runs.
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

The labelled set was written before the code and doubles as a spec, which is how it caught a real drift on the live deployment: only 3 of the 19 labelled categories (`Home & Garden > Decor > Door Mats`, `… > Lawn & Garden > Bird Feeders`, …) were exact paths in the shipped taxonomy, so a correct model answer was nearest-mapped, flagged for review and scored wrong. The taxonomy now uses the same Google-style paths as the labels and the fixture generator, so the category metric measures the model rather than the list it was given.

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

The eval harness found one real gap during development: a claim like "frost-proof" could pass quote verification when quoted from "not frost-proof". That's exactly the failure the hallucination metric exists to catch, so the negation check has to apply to verified claims as well. Live supplier data surfaced the mirror image: "non-slip backing" was *rejected* as negated, because dash-splitting turned the compound "non-slip" into "non slip". A hyphen directly after a negation word now forms one token, with regression tests for both directions.

**Measured numbers**

| Metric | Value | How measured |
|---|---|---|
| Throughput (fake provider) | **10,000 rows in 69 s ≈ 8,660 rows/min** (3,368 products, 0 duplicate SKUs/handles) | `bulk-10000.csv`, local, `AI_PROVIDER=fake` |
| Real AI run (OpenCode Go) | **500 rows → 233 products: build ≈ 7.5 min, DE+FR translation ≈ 12 min (19.5 min end-to-end), 0 failed rows, 60 of 233 products flagged for review, 3,162/3,168 translations fresh** (on one product both German attempts failed the mask guard → English fallback, case A13) | `messy-500.xlsx` + photos, live 2 GB Lightsail, concurrency 8 / 4 |
| Throughput (OpenCode Go, larger run) | **≈ 26 rows/min end-to-end (≈ 67 rows/min while building); 233 products from 500 rows** | same run, `messy-500.xlsx` |
| Groq free tier | 20 rows took 384 s, almost all of it rate-limit pauses | `small-20.csv`; 8k tokens/min |
| Tokens per product (real models) | ≈ **2,933 input + 2,124 output** (build + repair + DE & FR) at build batch size 1; ≈ **1,275 / 800** with 5-product build batches | `ai_calls` on the `messy-500` run (live host) |
| Storefront p97.5, idle | **457 ms** product page / 759 ms collection, 75 / 42 req/s, 0 errors | autocannon 25 connections, 60 s, live 2 vCPU host |
| Storefront p97.5, during 10k import | **1,750 ms** collection, 21 req/s, 0 errors (idle: 759 ms / 42 req/s) | same load during a fake-provider 10,000-row import |
| Cost per 1,000 products | **$1.15** | `ai_calls` sum ÷ products on the `messy-500` run (the Metrics tab averages every recorded call, evals included) |
| Savings from routing + skip-unchanged | **33%** ($0.2680 actual vs $0.3995 all-strong baseline) | baseline vs actual, `ai_calls` / Metrics tab |
| Eval: category / material / hallucinated claims | **85.7% category exact (9.5% before the taxonomy fix), 100% material, 0% hallucinated, 90.1% claim precision, 76.2% grouping (v1)**; v2 matches the categories and trades precision for recall (77.4% vs 73.8%) | `bun run eval -- --prompt v1,v2`, 42 labelled products, live host |

Read the two storefront rows together: during the import the storefront kept answering with 0 errors, but throughput halved — the worker shares the container and the box's 2 vCPUs. The fake provider builds at ~26 rows/s, roughly 60× the real provider's ~0.4 rows/s, so this is a CPU-saturation upper bound; a real 10k import spreads the same writes over hours.

**What breaks first at 1,000,000 products in 8 languages, and how would you fix it?**
1. **Translation volume and provider quotas.** 1M products × ~6 fields × 8 locales ≈ 48M strings; at our measured ~2,933 in / 2,124 out per product for build + DE+FR, eight locales land around **13 billion tokens** (build batching shifts this materially).
   - Per-model provider allowances break first (we already hit Groq's free-tier cap at 10k rows; OpenCode Go's per-model monthly dollar caps would follow at this scale).
   - Fix: a paid provider tier with a batch API (≈50% cheaper, no rate-limit pressure), keeping the per-tier model chains so one exhausted model never stalls the pipeline.
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

Testing against a real 11,576-row supplier export taught the rest: the synthetic fixtures passed, but real SKU schemes (`PLN-1066-16-A`), photos named after the base product rather than a variant, and supplier category names all needed changes that only showed up on real data. That is why the sample sheets now ship as slices of that export with its photos. A provider's free-tier limits also shape the architecture: per-model fallback chains turned constant "Paused" banners into zero pauses.

**How did you use AI while building this?**
AI coding agents as pair programmers:
- The plan and EDGE-CASES.md first.
- Then parallel agents on separate packages (core logic, worker pipeline, dashboard, storefront/eval/docs) against shared contracts: DB schema, queue job types, core types.
- Dry runs of the cleaning/grouping code against the real supplier sheet (no AI calls) to find grouping and photo-matching gaps before spending tokens.

Every module was reviewed, typechecked and tested. The eval harness and fixtures were also used to check the AI-written code's own claims.

## Screenshots

Screenshots and the 3–5 minute walkthrough are shared with the submission; they are deliberately not committed here because they show the private demo instance and its seeded data. The walkthrough covers:

1. **Upload tab** with a run in progress: live stage bar, done / needs-review / failed / pending counts, and the Cancel button.
2. **"Paused — resuming in X min"** banner (run with `AI_PROVIDER=fake FAKE_AI_FAILURES=rate_limit:0.3` to trigger it on demand).
3. **Products tab**: photo thumbnails, SKU · variants, price-from, colour-coded confidence, review reasons.
4. **Review page** side by side: source rows with cited cells highlighted + photos ↔ AI result, claims with sources (a struck-through rejected claim), EN/DE/FR tabs with an Out-of-date badge.
5. **Storefront** product and collection pages in DE and FR (and an English fallback country), plus a phone-width view.
6. **Metrics tab**: rates, model usage, cost over time, speed, translation coverage / out-of-date count.
7. **Restart demo**: the worker killed mid-import and the run completing with counts adding up (GIF).
8. **Settings**: webhook URL, API keys, country → language table.
