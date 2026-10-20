#!/usr/bin/env bash
# Fallback when k6 isn't installed. Usage:
#   load/autocannon.sh [BASE_URL] [HANDLE]
# Prints p50/p97.5/p99 latency and req/s for the collection and product pages (100 connections, 60 s each).
set -euo pipefail
BASE="${1:-http://localhost:3000}"
HANDLE="${2:-hand-thrown-terracotta-planter}"
DURATION="${DURATION:-60}"
CONNECTIONS="${CONNECTIONS:-100}"
for path in "/store/de" "/store/de/products/${HANDLE}" "/store/fr/products/${HANDLE}"; do
  echo "== ${path}"
  bunx --bun autocannon@7 -c "${CONNECTIONS}" -d "${DURATION}" --renderStatusCodes "${BASE}${path}"
done
