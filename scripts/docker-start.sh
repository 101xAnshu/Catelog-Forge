#!/bin/sh
# Container entrypoint. ROLE=all (default) runs migrations, the optional demo seed, the worker and the
# web app in one container so uploads and the worker share one disk (STORAGE_DIR). ROLE=web / ROLE=worker
# split them when STORAGE_DIR points at shared storage.
set -e
cd /app

if [ -z "$DATABASE_URL" ] || [ -z "$REDIS_URL" ]; then
  echo "DATABASE_URL and REDIS_URL must be set (see docs/DEPLOY.md)." >&2
  exit 1
fi
mkdir -p "${STORAGE_DIR:-/data/storage}"

if [ "$ROLE" != "worker" ]; then
  echo "Applying database migrations…"
  bun packages/db/src/migrate.ts
  if [ "$SEED_DEMO" = "true" ]; then
    echo "Seeding demo store (SEED_DEMO=true)…"
    bun packages/db/src/seed.ts
  fi
fi

if [ "$ROLE" = "worker" ]; then
  cd apps/worker && exec bun src/index.ts
fi

worker_pid=""
if [ "$ROLE" = "all" ]; then
  (cd apps/worker && exec bun src/index.ts) &
  worker_pid=$!
fi

(cd apps/web && exec ./node_modules/.bin/next start -p "${PORT:-3000}") &
web_pid=$!

# Forward SIGTERM so the worker shuts down gracefully (jobs resume on the next boot either way).
shutdown() {
  kill -TERM "$web_pid" $worker_pid 2>/dev/null || true
  wait
  exit 0
}
trap shutdown TERM INT

# If either process dies, stop the container so the platform restarts it.
while kill -0 "$web_pid" 2>/dev/null && { [ -z "$worker_pid" ] || kill -0 "$worker_pid" 2>/dev/null; }; do
  sleep 5
done
echo "A process exited; stopping container so it is restarted." >&2
shutdown
