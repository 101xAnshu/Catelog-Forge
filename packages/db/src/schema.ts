import { sql } from "drizzle-orm";
import {
  bigint, boolean, char, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import type { Issue, CleanedRow, ProductOutput } from "@cf/core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const storeId = () => uuid("store_id").notNull().references(() => stores.id, { onDelete: "cascade" });

/* ---------- tenancy & auth ---------- */

export const stores = pgTable("stores", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  baseCurrency: char("base_currency", { length: 3 }).notNull().default("EUR"),
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret").notNull().default(sql`encode(gen_random_bytes(24), 'hex')`),
  /** AI settings: { routingThreshold, reviewThreshold, promptVersion, useBatch } */
  settings: jsonb("settings").$type<StoreSettings>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export interface StoreSettings {
  routingThreshold?: number;
  reviewThreshold?: number;
  promptVersion?: string;
  useBatch?: boolean;
  brandGlossary?: string[];
}

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const storeMembers = pgTable(
  "store_members",
  {
    storeId: storeId(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "member">().notNull().default("owner"),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.userId] })],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 of the cookie token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const apiKeys = pgTable("api_keys", {
  id: id(),
  storeId: storeId(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(), // sha256 of the key
  prefix: text("prefix").notNull(), // first 8 chars for display
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const countryLocales = pgTable(
  "country_locales",
  {
    storeId: storeId(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    locale: text("locale").$type<"en" | "de" | "fr">().notNull(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.countryCode] })],
);

/* ---------- imports ---------- */

export type ImportStatus =
  | "queued" | "parsing" | "cleaning" | "grouping" | "building" | "translating" | "paused" | "completed" | "failed";

export interface ImportCounts {
  total: number;
  pending: number;
  done: number;
  needs_review: number;
  failed: number;
  products: number;
  orphan_photos: number;
}

export interface ImportSettings {
  routing: "auto" | "cheap" | "strong";
  useBatch: boolean;
  promptVersion: string;
}

export const imports = pgTable(
  "imports",
  {
    id: id(),
    storeId: storeId(),
    fileSha256: text("file_sha256").notNull(),
    filename: text("filename").notNull(),
    sheetKey: text("sheet_key").notNull(), // storage key of the uploaded sheet
    photosKey: text("photos_key"), // storage key of the uploaded zip (if any)
    photoKeys: jsonb("photo_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // loose photo uploads
    status: text("status").$type<ImportStatus>().notNull().default("queued"),
    stage: text("stage"), // last stage that started; used by the reconciler
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    totalRows: integer("total_rows").notNull().default(0),
    counts: jsonb("counts").$type<ImportCounts>().notNull().default(sql`'{}'::jsonb`),
    settings: jsonb("settings").$type<ImportSettings>().notNull(),
    source: text("source").$type<"dashboard" | "api">().notNull().default("dashboard"),
    error: text("error"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("imports_store_file_uq").on(t.storeId, t.fileSha256),
    index("imports_store_created_idx").on(t.storeId, t.createdAt),
    index("imports_status_idx").on(t.status),
  ],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: id(),
    importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
    storeId: storeId(),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    cleaned: jsonb("cleaned").$type<CleanedRow>(),
    issues: jsonb("issues").$type<Issue[]>().notNull().default(sql`'[]'::jsonb`),
    rowHash: text("row_hash"),
    groupKey: text("group_key"),
    status: text("status").$type<"pending" | "grouped" | "done" | "needs_review" | "failed">().notNull().default("pending"),
    reason: text("reason"),
    productId: uuid("product_id"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("import_rows_import_row_uq").on(t.importId, t.rowNumber),
    index("import_rows_import_status_idx").on(t.importId, t.status),
    index("import_rows_product_idx").on(t.productId),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: id(),
    storeId: storeId(),
    importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(), // original
    thumbKey: text("thumb_key"), // 512px webp
    width: integer("width"),
    height: integer("height"),
    productId: uuid("product_id"),
    productKey: text("product_key"),
    matchMethod: text("match_method").$type<"sku" | "image_column" | "name">(),
    status: text("status").$type<"ok" | "orphan" | "invalid">().notNull().default("ok"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("assets_import_sha_uq").on(t.importId, t.sha256),
    index("assets_product_idx").on(t.productId),
  ],
);

/* ---------- catalog ---------- */

export type ProductStatusDb = "processing" | "needs_review" | "approved" | "rejected" | "failed" | "archived";

export const products = pgTable(
  "products",
  {
    id: id(),
    storeId: storeId(),
    productKey: text("product_key").notNull(),
    handle: text("handle").notNull(),
    status: text("status").$type<ProductStatusDb>().notNull().default("processing"),
    reviewReasons: jsonb("review_reasons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    reviewNote: text("review_note"),
    title: text("title"), // denormalised English title for search/sort
    category: text("category"),
    minConfidence: integer("min_confidence"),
    sourceInputHash: text("source_input_hash"),
    builtInputHash: text("built_input_hash"), // input hash of the last successful AI build
    /** full brief-format output for exports and the review screen */
    output: jsonb("output").$type<ProductOutput>(),
    group: jsonb("group").$type<unknown>(), // ProductGroup snapshot sent to the AI (source rows, issues)
    lastImportId: uuid("last_import_id"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    version: integer("version").notNull().default(1), // optimistic locking
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_store_key_uq").on(t.storeId, t.productKey),
    uniqueIndex("products_store_handle_uq").on(t.storeId, t.handle),
    index("products_store_status_idx").on(t.storeId, t.status),
    index("products_store_updated_idx").on(t.storeId, t.updatedAt),
  ],
);

export const variants = pgTable(
  "variants",
  {
    id: id(),
    storeId: storeId(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    variantKey: text("variant_key").notNull(), // sku, or options signature when there is no sku
    sku: text("sku"),
    options: jsonb("options").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    priceCents: bigint("price_cents", { mode: "number" }),
    currency: char("currency", { length: 3 }),
    weightGrams: integer("weight_grams"),
    sourceRows: jsonb("source_rows").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("variants_product_key_uq").on(t.productId, t.variantKey),
    uniqueIndex("variants_store_sku_uq").on(t.storeId, t.sku),
  ],
);

/** English content per field; `origin=manual` is never overwritten by the AI. */
export const productFields = pgTable(
  "product_fields",
  {
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    storeId: storeId(),
    fieldPath: text("field_path").notNull(), // title | description_html | seo_title | seo_description | attributes.care ...
    value: text("value").notNull(),
    confidence: integer("confidence"),
    origin: text("origin").$type<"ai" | "manual">().notNull().default("ai"),
    aiSuggestion: text("ai_suggestion"), // latest AI value when a manual edit is kept
    sourceHash: text("source_hash").notNull(), // sha256(value) – drives re-translation
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.fieldPath] })],
);

export const claims = pgTable(
  "claims",
  {
    id: id(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    storeId: storeId(),
    text: text("text").notNull(),
    sourceRow: integer("source_row"),
    sourceColumn: text("source_column"),
    sourceQuote: text("source_quote"),
    verified: boolean("verified").notNull(),
    rejectedReason: text("rejected_reason"),
  },
  (t) => [index("claims_product_idx").on(t.productId)],
);

export const translations = pgTable(
  "translations",
  {
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    storeId: storeId(),
    fieldPath: text("field_path").notNull(),
    locale: text("locale").$type<"de" | "fr">().notNull(),
    value: text("value"),
    sourceHash: text("source_hash"), // the English source_hash this translation was made from
    origin: text("origin").$type<"ai" | "manual">().notNull().default("ai"),
    state: text("state").$type<"fresh" | "out_of_date" | "missing" | "pending">().notNull().default("pending"),
    error: text("error"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.fieldPath, t.locale] }),
    index("translations_store_state_idx").on(t.storeId, t.locale, t.state),
  ],
);

/** Read-only, denormalised snapshot; the only table the storefront reads. */
export const storefrontProducts = pgTable(
  "storefront_products",
  {
    storeId: storeId(),
    locale: text("locale").$type<"en" | "de" | "fr">().notNull(),
    handle: text("handle").notNull(),
    productId: uuid("product_id").notNull(),
    category: text("category"),
    title: text("title").notNull(),
    priceFromCents: bigint("price_from_cents", { mode: "number" }),
    currency: char("currency", { length: 3 }),
    thumbUrl: text("thumb_url"),
    payload: jsonb("payload").$type<StorefrontPayload>().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.locale, t.handle] }),
    index("storefront_products_list_idx").on(t.storeId, t.locale, t.category, t.publishedAt),
    index("storefront_products_product_idx").on(t.productId),
  ],
);

export interface StorefrontPayload {
  title: string;
  descriptionHtml: string;
  category: string | null;
  tags: string[];
  attributes: Record<string, string>;
  claims: string[];
  images: string[];
  seo: { title: string; description: string };
  variants: Array<{ sku: string | null; options: Record<string, string>; priceCents: number | null; currency: string | null }>;
  optionNames: string[];
  translatedFields: string[]; // which fields are in the requested locale (others fell back to English)
}

/* ---------- AI usage, events, eval ---------- */

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: id(),
    storeId: storeId(),
    importId: uuid("import_id"),
    productIds: jsonb("product_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    kind: text("kind").$type<"build" | "translate" | "rerun" | "eval" | "repair">().notNull(),
    model: text("model").notNull(),
    tier: text("tier").$type<"cheap" | "strong" | "vision">().notNull(),
    batch: boolean("batch").notNull().default(false),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0), // USD * 1e6
    baselineCostMicros: bigint("baseline_cost_micros", { mode: "number" }).notNull().default(0), // same tokens on strong model, no batch
    latencyMs: integer("latency_ms").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    outcome: text("outcome").$type<"ok" | "invalid_json" | "rate_limited" | "timeout" | "error">().notNull(),
    errorCode: text("error_code"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_calls_store_created_idx").on(t.storeId, t.createdAt),
    index("ai_calls_import_idx").on(t.importId),
  ],
);

/** Transactional outbox: SSE fan-out and webhook delivery read from here. */
export const events = pgTable(
  "events",
  {
    id: id(),
    storeId: storeId(),
    importId: uuid("import_id"),
    type: text("type").notNull(), // import.completed | import.failed
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    webhookStatus: text("webhook_status").$type<"pending" | "delivered" | "failed" | "skipped">().notNull().default("pending"),
    webhookAttempts: integer("webhook_attempts").notNull().default(0),
    webhookLastError: text("webhook_last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("events_import_type_uq").on(t.importId, t.type),
    index("events_store_created_idx").on(t.storeId, t.createdAt),
  ],
);

export const evalRuns = pgTable("eval_runs", {
  id: id(),
  storeId: uuid("store_id"),
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  sampleSize: integer("sample_size").notNull(),
  fieldScores: jsonb("field_scores").$type<Record<string, number>>().notNull(),
  hallucinationRate: integer("hallucination_rate_bp").notNull(), // basis points
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  createdAt: createdAt(),
});
