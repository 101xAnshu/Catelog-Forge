DROP INDEX IF EXISTS "assets_import_sha_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "assets_import_filename_uq" ON "assets" USING btree ("import_id","filename");
