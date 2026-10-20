# One image for both services. ROLE=web (default) runs Next.js, ROLE=worker runs the BullMQ worker,
# ROLE=all runs both in one container (single volume for uploads; simplest Railway setup).
# Next.js runs on real Node (its build crashes under Bun's node shim); Bun installs deps and runs the worker.
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
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 ROLE=web PORT=3000
COPY --from=build /app /app
EXPOSE 3000
# Migrations are idempotent; the web service applies them before starting.
CMD ["sh", "-c", "if [ \"$ROLE\" = \"worker\" ]; then cd apps/worker && exec bun src/index.ts; fi; bun packages/db/src/migrate.ts || exit 1; if [ \"$ROLE\" = \"all\" ]; then (cd apps/worker && bun src/index.ts) & fi; cd apps/web && exec ./node_modules/.bin/next start -p ${PORT}"]
