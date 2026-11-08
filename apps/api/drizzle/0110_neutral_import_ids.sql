-- The import id columns get neutral names (source_*). Databases made from the current migrations already have them;
-- this renames the legacy columns where an older version of the migrations made them.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'boards' AND column_name = 'monday_board_id') THEN
    ALTER TABLE "boards" RENAME COLUMN "monday_board_id" TO "source_board_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'columns' AND column_name = 'monday_column_id') THEN
    ALTER TABLE "columns" RENAME COLUMN "monday_column_id" TO "source_column_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'groups' AND column_name = 'monday_group_id') THEN
    ALTER TABLE "groups" RENAME COLUMN "monday_group_id" TO "source_group_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'items' AND column_name = 'monday_item_id') THEN
    ALTER TABLE "items" RENAME COLUMN "monday_item_id" TO "source_item_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'time_entries' AND column_name = 'monday_entry_id') THEN
    ALTER TABLE "time_entries" RENAME COLUMN "monday_entry_id" TO "source_entry_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'updates' AND column_name = 'monday_update_id') THEN
    ALTER TABLE "updates" RENAME COLUMN "monday_update_id" TO "source_update_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'views' AND column_name = 'monday_view_id') THEN
    ALTER TABLE "views" RENAME COLUMN "monday_view_id" TO "source_view_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'docs' AND column_name = 'monday_doc_id') THEN
    ALTER TABLE "docs" RENAME COLUMN "monday_doc_id" TO "source_doc_id";
  END IF;
END $$;
--> statement-breakpoint
ALTER INDEX IF EXISTS "ux_boards_monday" RENAME TO "ux_boards_source";
--> statement-breakpoint
ALTER INDEX IF EXISTS "ux_items_monday" RENAME TO "ux_items_source";
--> statement-breakpoint
ALTER INDEX IF EXISTS "ux_time_entries_monday" RENAME TO "ux_time_entries_source";
--> statement-breakpoint
ALTER INDEX IF EXISTS "ux_updates_monday" RENAME TO "ux_updates_source";
--> statement-breakpoint
ALTER INDEX IF EXISTS "ux_views_monday" RENAME TO "ux_views_source";
--> statement-breakpoint
ALTER INDEX IF EXISTS "ux_docs_monday" RENAME TO "ux_docs_source";
--> statement-breakpoint
ALTER TABLE "import_jobs" ALTER COLUMN "source" SET DEFAULT 'file';
--> statement-breakpoint
UPDATE "webhooks" SET "config" = "config" - 'legacy_payload' WHERE "config" ? 'legacy_payload';
