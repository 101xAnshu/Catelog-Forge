# Deploying CatalogForge

One Docker image runs everything. On start it:
1. applies database migrations,
2. seeds the demo store (`SEED_DEMO=true`),
3. starts the worker and the web app.

Uploads live on one volume mounted at `/data`. You only provide Postgres, Redis and an AI key.

## Required environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | Postgres connection string. For Supabase use the **session pooler** URL (port 5432) and append `?sslmode=require`. |
| `REDIS_URL` | Redis connection string (`redis://` or `rediss://`). Redis must use `maxmemory-policy noeviction` (BullMQ requirement). |
| `OPENCODE_API_KEY` | Your OpenCode Go key. Leave it empty (with no `GROQ_API_KEY`) to run in demo mode with the fake AI provider. |
| `APP_URL` | Public URL of the app, e.g. `https://catalogforge.up.railway.app`. Used in API responses and exports. |

## Optional variables (defaults are already set in the image)

| Variable | Default | Notes |
|---|---|---|
| `SEED_DEMO` | `true` | Creates `demo@catalogforge.dev` / `demo1234`. Set `false` on a public instance you don't want open; then sign up at `/signup`. |
| `ROLE` | `all` | `all` = web + worker in one container. `web` / `worker` split them, but both then need the same `STORAGE_DIR`. |
| `STORAGE_DIR` | `/data/storage` | Mount a persistent volume at `/data`. |
| `GROQ_API_KEY` | – | Fallback provider, used only when there is no OpenCode key. |
| `AI_PROVIDER` | auto | Force `opencode`, `groq` or `fake`. |
| `OPENCODE_MODELS_CHEAP` / `_STRONG` / `_VISION` | built in | Comma-separated model chains; see `.env.example`. |
| `BUILD_BATCH_SIZE` | `1` | Products per AI build call. 1 is fastest with OpenCode Go. |
| `WORKER_BUILD_CONCURRENCY` / `WORKER_TRANSLATE_CONCURRENCY` | `32` | Parallel AI calls. OpenCode Go has no per-minute limit. |
| `DB_POOL_WORKER` | `16` | Worker DB connections. Keep under your Postgres plan's connection limit. |

Health check: `GET /api/health` returns 200 when Postgres and Redis answer.

## Option A: Railway

1. Push this repo to GitHub, then in Railway choose **New Project → Deploy from GitHub repo**. It builds the `Dockerfile`; `railway.json` sets the health check and restart policy.
2. In the project, **+ New → Database → PostgreSQL**, then **+ New → Database → Redis**.
3. On the app service, open **Variables** and add:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   OPENCODE_API_KEY=<your key>
   APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   ```
4. On the app service, open **Settings → Volumes → Add volume** and set the mount path to `/data`.
5. Under **Settings → Networking**, generate a public domain. Railway sets `PORT`.
6. Deploy. Open `https://<domain>/login` and sign in with `demo@catalogforge.dev` / `demo1234`.

Railway's Redis plugin ships with AOF persistence. If you bring your own Redis, set `maxmemory-policy noeviction`.

## Option B: Any server with Docker (VPS)

```bash
cp .env.example .env                       # set OPENCODE_API_KEY and APP_URL
docker compose -f docker-compose.prod.yml up -d --build
```

`docker-compose.prod.yml` runs the app, Postgres 16 and Redis 7 (AOF + `noeviction`), each with a persistent volume. The database and Redis URLs are wired inside the compose file. Put a TLS proxy such as Caddy or nginx in front of port 3000.

## Option C: Render / Fly / other Docker hosts

Deploy the `Dockerfile` as a web service on port 3000 with a persistent disk at `/data`. Add managed Postgres and Redis, set the four required variables, and use `/api/health` as the health check.

## Scaling out

For more AI throughput, raise the concurrency variables first. To run several worker containers, use `ROLE=web` for one service and `ROLE=worker` for the others, and point every `STORAGE_DIR` at shared storage (a shared volume, or swap the local-disk adapter in `apps/web/lib/storage.ts` and `apps/worker/src/storage.ts` for S3). Jobs, retries and restarts are coordinated through Postgres and Redis, so any number of workers is safe.

## Restart demo on a deployment

Start a large import, then restart the service (Railway: **Deployments → Restart**). On boot the worker's reconciler rebuilds the queue from Postgres and the import continues. The row counts still add up, with no duplicates.
