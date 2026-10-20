#!/usr/bin/env bash
# Demo: crash the worker with kill -9 in the middle of an import, restart it, and watch the import resume.
# Usage: scripts/chaos-restart.sh [seconds-before-crash=20]
# Start an import from the dashboard (e.g. fixtures/bulk-10000.csv) first, or let this script use the newest open one.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
CRASH_AFTER="${1:-20}"

status() {
  psql "$DATABASE_URL" -Atc "
    select i.filename, i.status, i.total_rows,
      count(r.id) filter (where r.status = 'done'), count(r.id) filter (where r.status = 'needs_review'),
      count(r.id) filter (where r.status = 'failed'), count(r.id) filter (where r.status in ('pending','grouped'))
    from imports i left join import_rows r on r.import_id = i.id
    where i.id = (select id from imports order by created_at desc limit 1) group by i.id" |
    awk -F'|' '{printf "  %-24s %-11s total=%-6s done=%-6s review=%-6s failed=%-6s pending=%s\n",$1,$2,$3,$4,$5,$6,$7}'
}

echo "▶ starting worker"
bun apps/worker/src/index.ts > /tmp/catalogforge-worker-1.log 2>&1 &
PID=$!
for _ in $(seq "$CRASH_AFTER"); do sleep 1; status; done

echo "💥 kill -9 $PID (no graceful shutdown)"
kill -9 "$PID" || true
sleep 2
status

echo "▶ restarting worker: the boot reconciler re-queues whatever Postgres says is unfinished"
bun apps/worker/src/index.ts > /tmp/catalogforge-worker-2.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
while true; do
  sleep 2
  status
  s=$(psql "$DATABASE_URL" -Atc "select status from imports order by created_at desc limit 1")
  if [ "$s" = "completed" ] || [ "$s" = "failed" ]; then break; fi
done
echo "✅ final state — counts must add up to the sheet, with no duplicate SKUs/handles:"
psql "$DATABASE_URL" -Atc "
  select 'duplicate skus: ' || count(*) from (select store_id, sku from variants where sku is not null group by 1,2 having count(*) > 1) x
  union all
  select 'duplicate handles: ' || count(*) from (select store_id, handle from products group by 1,2 having count(*) > 1) y"
