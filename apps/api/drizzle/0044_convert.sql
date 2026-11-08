CREATE TABLE "column_conversion_cells" (
	"conversion_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"outcome" varchar(10) NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"old_value" jsonb,
	"old_text" text,
	"old_number" double precision,
	"old_date" timestamp with time zone,
	"old_date_end" timestamp with time zone,
	"new_value" jsonb,
	"new_text" text,
	"new_number" double precision,
	"new_date" timestamp with time zone,
	"new_date_end" timestamp with time zone,
	CONSTRAINT "column_conversion_cells_conversion_id_item_id_pk" PRIMARY KEY("conversion_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "column_conversions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"kind" varchar(16) DEFAULT 'convert' NOT NULL,
	"restore_of" varchar(26),
	"from_type" varchar(32) NOT NULL,
	"from_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"to_type" varchar(32) NOT NULL,
	"to_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"converted" integer DEFAULT 0 NOT NULL,
	"empty" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"partial" integer DEFAULT 0 NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_id" varchar(26),
	"batch_id" varchar(26),
	"error" text,
	"failed_cleared_at" timestamp with time zone,
	"backup_purged_at" timestamp with time zone,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "converting_id" varchar(26);--> statement-breakpoint
ALTER TABLE "column_conversion_cells" ADD CONSTRAINT "column_conversion_cells_conversion_id_column_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."column_conversions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_conversion_cells" ADD CONSTRAINT "column_conversion_cells_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_conversion_cells" ADD CONSTRAINT "column_conversion_cells_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_conversions" ADD CONSTRAINT "column_conversions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_conversions" ADD CONSTRAINT "column_conversions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_conversions" ADD CONSTRAINT "column_conversions_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column_conversions" ADD CONSTRAINT "column_conversions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_column_conversion_cells_failed" ON "column_conversion_cells" USING btree ("conversion_id") WHERE "column_conversion_cells"."outcome" = 'failed';--> statement-breakpoint
CREATE INDEX "ix_column_conversions_column" ON "column_conversions" USING btree ("column_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_column_conversions_board" ON "column_conversions" USING btree ("board_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_column_conversions_account" ON "column_conversions" USING btree ("account_id","created_at");--> statement-breakpoint
-- D28: a column's type change reaches webhooks (`column_type_changed`) like the other listened events (the rest as
-- in 0038).
CREATE OR REPLACE FUNCTION "bines_enqueue_automation_dispatch_rows"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM graphile_worker.add_jobs(s.specs)
  FROM (
    SELECT array_agg(
      ROW('automation.dispatch', json_build_object('event_id', n."id", 'account_id', n."account_id"),
        NULL, NULL, 5, NULL, NULL, NULL)::graphile_worker.job_spec
      ORDER BY n."id") AS specs
    FROM new_rows n
    WHERE n."type" IN ('item.created', 'cell.changed', 'item.renamed', 'item.moved_to_group', 'update.created',
        'update.edited', 'update.deleted', 'item.archived', 'item.deleted', 'item.restored', 'item.unarchived',
        'item.moved_to_board', 'group.created', 'column.created', 'schedule.fired', 'webhook_in.received',
        'update.replied', 'button.clicked', 'column.type_changed')
      AND n."account_id" IN (
        SELECT a."account_id" FROM "automations" a WHERE a."is_active" AND a."deleted_at" IS NULL
        UNION
        SELECT w."account_id" FROM "webhooks" w WHERE w."is_active" AND w."deleted_at" IS NULL
        UNION
        SELECT g."account_id" FROM "agents" g WHERE g."is_active" AND g."deleted_at" IS NULL
          AND (g."triggers" ->> 'mention' = 'true' OR g."triggers" ->> 'assign' = 'true')
        UNION
        SELECT c."account_id" FROM "columns" c WHERE c."type" = 'ai' AND c."deleted_at" IS NULL
          AND c."settings" ->> 'auto_run' = 'true'
      )
  ) s
  WHERE s.specs IS NOT NULL;
  RETURN NULL;
END $$;
