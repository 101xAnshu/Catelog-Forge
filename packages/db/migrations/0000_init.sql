CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"import_id" uuid,
	"product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"batch" boolean DEFAULT false NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"baseline_cost_micros" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumb_key" text,
	"width" integer,
	"height" integer,
	"product_id" uuid,
	"product_key" text,
	"match_method" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source_row" integer,
	"source_column" text,
	"source_quote" text,
	"verified" boolean NOT NULL,
	"rejected_reason" text
);
--> statement-breakpoint
CREATE TABLE "country_locales" (
	"store_id" uuid NOT NULL,
	"country_code" char(2) NOT NULL,
	"locale" text NOT NULL,
	CONSTRAINT "country_locales_store_id_country_code_pk" PRIMARY KEY("store_id","country_code")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"sample_size" integer NOT NULL,
	"field_scores" jsonb NOT NULL,
	"hallucination_rate_bp" integer NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"import_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"webhook_status" text DEFAULT 'pending' NOT NULL,
	"webhook_attempts" integer DEFAULT 0 NOT NULL,
	"webhook_last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"cleaned" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"row_hash" text,
	"group_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"product_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"file_sha256" text NOT NULL,
	"filename" text NOT NULL,
	"sheet_key" text NOT NULL,
	"photos_key" text,
	"photo_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text,
	"paused_until" timestamp with time zone,
	"paused_reason" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"error" text,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_fields" (
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"value" text NOT NULL,
	"confidence" integer,
	"origin" text DEFAULT 'ai' NOT NULL,
	"ai_suggestion" text,
	"source_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_fields_product_id_field_path_pk" PRIMARY KEY("product_id","field_path")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_key" text NOT NULL,
	"handle" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"review_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_note" text,
	"title" text,
	"category" text,
	"min_confidence" integer,
	"source_input_hash" text,
	"built_input_hash" text,
	"output" jsonb,
	"group" jsonb,
	"last_import_id" uuid,
	"model" text,
	"prompt_version" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_members" (
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	CONSTRAINT "store_members_store_id_user_id_pk" PRIMARY KEY("store_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "storefront_products" (
	"store_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"handle" text NOT NULL,
	"product_id" uuid NOT NULL,
	"category" text,
	"title" text NOT NULL,
	"price_from_cents" bigint,
	"currency" char(3),
	"thumb_url" text,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_products_store_id_locale_handle_pk" PRIMARY KEY("store_id","locale","handle")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"base_currency" char(3) DEFAULT 'EUR' NOT NULL,
	"webhook_url" text,
	"webhook_secret" text DEFAULT encode(gen_random_bytes(24), 'hex') NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"field_path" text NOT NULL,
	"locale" text NOT NULL,
	"value" text,
	"source_hash" text,
	"origin" text DEFAULT 'ai' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translations_product_id_field_path_locale_pk" PRIMARY KEY("product_id","field_path","locale")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_key" text NOT NULL,
	"sku" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_cents" bigint,
	"currency" char(3),
	"weight_grams" integer,
	"source_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "country_locales" ADD CONSTRAINT "country_locales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_fields" ADD CONSTRAINT "product_fields_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_fields" ADD CONSTRAINT "product_fields_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_products" ADD CONSTRAINT "storefront_products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_store_created_idx" ON "ai_calls" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_import_idx" ON "ai_calls" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_import_sha_uq" ON "assets" USING btree ("import_id","sha256");--> statement-breakpoint
CREATE INDEX "assets_product_idx" ON "assets" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "claims_product_idx" ON "claims" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_import_type_uq" ON "events" USING btree ("import_id","type");--> statement-breakpoint
CREATE INDEX "events_store_created_idx" ON "events" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_import_row_uq" ON "import_rows" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_import_status_idx" ON "import_rows" USING btree ("import_id","status");--> statement-breakpoint
CREATE INDEX "import_rows_product_idx" ON "import_rows" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imports_store_file_uq" ON "imports" USING btree ("store_id","file_sha256");--> statement-breakpoint
CREATE INDEX "imports_store_created_idx" ON "imports" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "imports_status_idx" ON "imports" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "products_store_key_uq" ON "products" USING btree ("store_id","product_key");--> statement-breakpoint
CREATE UNIQUE INDEX "products_store_handle_uq" ON "products" USING btree ("store_id","handle");--> statement-breakpoint
CREATE INDEX "products_store_status_idx" ON "products" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "products_store_updated_idx" ON "products" USING btree ("store_id","updated_at");--> statement-breakpoint
CREATE INDEX "storefront_products_list_idx" ON "storefront_products" USING btree ("store_id","locale","category","published_at");--> statement-breakpoint
CREATE INDEX "storefront_products_product_idx" ON "storefront_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "translations_store_state_idx" ON "translations" USING btree ("store_id","locale","state");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_product_key_uq" ON "variants" USING btree ("product_id","variant_key");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_store_sku_uq" ON "variants" USING btree ("store_id","sku");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_title_trgm_idx" ON "products" USING gin ("title" gin_trgm_ops);
