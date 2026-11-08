-- Hand-written constraints that drizzle-kit does not model (the `SQL:` notes in src/db/schema.ts).
ALTER TABLE "accounts" ADD CONSTRAINT "ck_accounts_slug" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$');--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "ck_workspace_members_principal" CHECK (("user_id" IS NOT NULL) <> ("team_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "ck_folders_depth" CHECK ("depth" BETWEEN 0 AND 2);--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "ck_boards_hierarchy_depth_max" CHECK ("hierarchy_depth_max" BETWEEN 1 AND 6);--> statement-breakpoint
-- New column ids are limited to 20 chars by the service (CLAUDE.md rule 5); the DB allows 50 so imported source ids fit verbatim.
ALTER TABLE "columns" ADD CONSTRAINT "ck_columns_key" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,49}$');--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "ck_columns_single_restriction" CHECK (NOT ("restricted_edit" IS NOT NULL AND "restricted_view" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "ck_items_tree" CHECK (("depth" = 0 AND "group_id" IS NOT NULL AND "parent_item_id" IS NULL) OR ("depth" > 0 AND "parent_item_id" IS NOT NULL AND "group_id" IS NULL));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "ck_items_depth" CHECK ("depth" BETWEEN 0 AND 5);--> statement-breakpoint
CREATE INDEX "ix_automations_trigger_type" ON "automations" ("account_id", ("recipe"->'trigger'->>'type')) WHERE "is_active" AND "deleted_at" IS NULL;
