# Deploying CatalogForge (Railway + Supabase)

The same Docker image runs both services; `ROLE` picks which one.

| Service | Where | Settings |
|---|---|---|
| `web` | Railway (from this repo, `Dockerfile`) | `ROLE=web`, public domain, health check `/store/auto` |
| `worker` | Railway (same repo/image) | `ROLE=worker`, **2 replicas**, no public domain |
| Redis | Railway Redis plugin | AOF persistence is on by default |
| Postgres | Supabase (or the Railway Postgres plugin) | Use the *session* pooler URL (port 5432); the transaction pooler breaks `LISTEN`/prepared statements |

## Environment variables (both services)
```
DATABASE_URL=postgres://...            # Supabase session pooler URL
REDIS_URL=redis://...                  # Railway Redis internal URL
GROQ_API_KEY=gsk_...                   # leave empty for demo mode (fake provider)
STORAGE_DIR=/data/storage              # see "File storage" below
APP_URL=https://<your-web-domain>
```

## File storage
Uploads are written by `web` and read by `worker`, so both need the same storage:
- **Simplest:** run web and worker in one Railway service with `ROLE=all` on a mounted volume. Otherwise point `STORAGE_DIR` at a shared volume.
- **Production:** swap the local-disk storage adapter for S3/Supabase Storage (one interface in `apps/web/lib/storage` and `apps/worker`).

## Steps
1. Create a Supabase project. Copy the session-pooler connection string.
2. `railway init`, then add the Redis plugin.
3. Create service `web` from the repo with the variables above and `ROLE=web`. Migrations run on boot.
4. Create service `worker` from the same repo with `ROLE=worker` and replicas = 2.
5. Seed once: `railway run --service web bun packages/db/src/seed.ts`.
6. Open `https://<domain>/login`. Log in with `demo@catalogforge.dev` / `demo1234`.

## Restart demo on Railway
Use **Restart** on the `worker` service while an import is running. The import shows `paused`/stalled jobs, then resumes when the worker boots. The reconciler re-enqueues unfinished stages from Postgres.
