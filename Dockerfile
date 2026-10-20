# One image runs everything. ROLE=all (default): migrations + optional demo seed + worker + web in one
# container sharing one upload volume (mount it at /data). ROLE=web / ROLE=worker split them when
# STORAGE_DIR is shared storage. Next.js runs on real Node (its build crashes under Bun's node shim);
# Bun installs deps and runs the worker and migrations.
FROM node:22-bookworm-slim AS base
COPY --from=oven/bun:1.3.2 /usr/local/bin/bun /usr/local/bin/bun

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/ai/package.json packages/ai/
RUN bun install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && ./node_modules/.bin/next build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    ROLE=all PORT=3000 STORAGE_DIR=/data/storage SEED_DEMO=true \
    BUILD_BATCH_SIZE=1 TRANSLATE_BATCH_ITEMS=20 \
    WORKER_BUILD_CONCURRENCY=32 WORKER_TRANSLATE_CONCURRENCY=32 DB_POOL_WORKER=16
COPY --from=build /app /app
RUN mkdir -p /data/storage
EXPOSE 3000
CMD ["sh", "scripts/docker-start.sh"]
