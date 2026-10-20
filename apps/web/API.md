# CatalogForge public API

All endpoints take `Authorization: Bearer <api key>`. Create keys under **Settings → API keys**.
Seeded demo key: `cf_demo_0123456789abcdef0123456789abcdef`. Every key is scoped to one store and can only see that store's data.

## Start an import

```bash
curl -X POST http://localhost:3000/api/v1/imports \
  -H "Authorization: Bearer $KEY" \
  -F sheet=@fixtures/small.csv \
  -F photos=@fixtures/photos.zip \
  -F routing=auto -F promptVersion=v1
```

- `202 Accepted`: `{ "id", "duplicate": false, "status": "queued", "statusUrl" }`.
- `200 OK` with `"duplicate": true` means the identical sheet + photos were already imported. No new work is done.

Limits:
- 25 MB sheet (CSV/XLSX, 10,000 rows)
- 500 MB ZIP
- 20 MB per image
- 2,000 photos

Errors return `{ "error": { "code", "message" } }`. Codes:
- `UNSUPPORTED_FILE_TYPE`
- `FILE_TOO_LARGE`
- `TOO_MANY_PHOTOS`
- `SHEET_REQUIRED`
- `UNAUTHORIZED`

## Import status

`GET /api/v1/imports/:id` → `{ status, stage, counts: { total, done, needs_review, failed, pending }, pausedUntil, error }`.
`done + needs_review + failed + pending` always equals `total`.

`GET /api/v1/imports` lists recent imports.

## Products

`GET /api/v1/products?limit=50&cursor=<id>` returns approved products in the brief's JSON format, with `nextCursor` for pagination.

## Exports

`GET /api/exports?format=csv|json|shopify` takes the same filters as the dashboard (`status`, `q`, `confidence`, `importId`, `category`). It works with an API key as well as a session.

## Webhook

When an import finishes, CatalogForge POSTs `{ type: "import.completed" | "import.failed", importId, counts }` to the store's webhook URL.
- The body is signed with HMAC-SHA256 using the store's webhook secret, sent in `X-CatalogForge-Signature: sha256=<hex>`.
- Failed deliveries are retried with exponential backoff.
