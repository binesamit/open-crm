ALTER TABLE "time_entries" ADD COLUMN "source_entry_id" bigint;--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "source_update_id" bigint;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "source_view_id" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_time_entries_source" ON "time_entries" USING btree ("account_id","source_entry_id") WHERE "time_entries"."source_entry_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_updates_source" ON "updates" USING btree ("account_id","source_update_id") WHERE "updates"."source_update_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_views_source" ON "views" USING btree ("account_id","source_view_id") WHERE "views"."source_view_id" is not null;