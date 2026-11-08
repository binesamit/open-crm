ALTER TABLE "account_members" DROP CONSTRAINT "account_members_client_account_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "view_items" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "view_items" SET DEFAULT 'all'::text;--> statement-breakpoint
-- Guests are simply invited to boards now (board-scoped): a board that was "by client" keeps the stricter mode.
UPDATE "boards" SET "view_items" = 'assigned_or_created' WHERE "view_items" = 'by_client';--> statement-breakpoint
UPDATE "boards" SET "view_items_config" = "view_items_config" - 'client_column' WHERE "view_items_config" ? 'client_column';--> statement-breakpoint
DROP TYPE "public"."board_view_items";--> statement-breakpoint
CREATE TYPE "public"."board_view_items" AS ENUM('all', 'assigned_or_created', 'by_filter');--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "view_items" SET DEFAULT 'all'::"public"."board_view_items";--> statement-breakpoint
ALTER TABLE "boards" ALTER COLUMN "view_items" SET DATA TYPE "public"."board_view_items" USING "view_items"::"public"."board_view_items";--> statement-breakpoint
ALTER TABLE "account_members" DROP COLUMN "client_account_item_id";