ALTER TABLE "ai_column_pending" ADD COLUMN "board_limit" jsonb;--> statement-breakpoint
ALTER TABLE "ai_column_pending" ADD COLUMN "token_scopes" jsonb;--> statement-breakpoint
ALTER TABLE "ai_column_runs" ADD COLUMN "board_limit" jsonb;--> statement-breakpoint
ALTER TABLE "ai_column_runs" ADD COLUMN "token_scopes" jsonb;