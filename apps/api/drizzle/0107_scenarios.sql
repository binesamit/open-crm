CREATE TABLE "scenario_runs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"scenario_id" varchar(26) NOT NULL,
	"event_id" varchar(26),
	"item_id" varchar(26),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"skip_reason" varchar(64),
	"depth" integer DEFAULT 1 NOT NULL,
	"chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resume_at" timestamp with time zone,
	"resume_nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"name" varchar(120) NOT NULL,
	"graph" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"owner_id" varchar(26),
	"created_by" varchar(26),
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"deactivated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_scenario_runs_scenario_created" ON "scenario_runs" USING btree ("scenario_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_scenario_runs_event" ON "scenario_runs" USING btree ("scenario_id","event_id") WHERE "scenario_runs"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_scenarios_board_active" ON "scenarios" USING btree ("board_id") WHERE "scenarios"."is_active" and "scenarios"."deleted_at" is null;--> statement-breakpoint
-- phase 3: a board with an active scenario hears its events too (as 0046, plus the scenarios).
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
    LEFT JOIN "boards" b ON b."id" = n."board_id"
    WHERE n."type" IN ('item.created', 'cell.changed', 'item.renamed', 'item.moved_to_group', 'update.created',
        'update.edited', 'update.deleted', 'item.archived', 'item.deleted', 'item.restored', 'item.unarchived',
        'item.moved_to_board', 'group.created', 'column.created', 'schedule.fired', 'webhook_in.received',
        'update.replied', 'button.clicked', 'column.type_changed')
      AND n."board_id" IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM "automations" a
          WHERE a."board_id" = COALESCE(b."parent_board_id", n."board_id") AND a."is_active" AND a."deleted_at" IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM "scenarios" sc
          WHERE sc."board_id" = COALESCE(b."parent_board_id", n."board_id") AND sc."is_active" AND sc."deleted_at" IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM "webhooks" w
          WHERE w."board_id" = COALESCE(b."parent_board_id", n."board_id") AND w."is_active" AND w."deleted_at" IS NULL
        )
        OR (
          n."type" IN ('cell.changed', 'item.renamed', 'item.created')
          AND EXISTS (
            SELECT 1 FROM "columns" c
            WHERE c."board_id" = n."board_id" AND c."type" = 'ai' AND c."deleted_at" IS NULL
              AND c."settings" ->> 'auto_run' = 'true'
          )
        )
        OR (
          (n."type" IN ('update.created', 'update.replied')
            OR (n."type" = 'cell.changed' AND n."payload" -> 'meta' ->> 'column_type' = 'people'))
          AND EXISTS (
            SELECT 1 FROM "agents" g
            WHERE g."account_id" = n."account_id" AND g."is_active" AND g."deleted_at" IS NULL
              AND (g."triggers" ->> 'mention' = 'true' OR g."triggers" ->> 'assign' = 'true')
          )
        )
        OR (
          n."type" = 'cell.changed' AND n."item_id" IS NOT NULL
          AND n."payload" -> 'meta' ->> 'column_type' = 'status'
          AND EXISTS (
            SELECT 1 FROM "item_links" l
            JOIN "columns" c ON c."id" = l."column_id"
            JOIN "automations" a ON a."board_id" = c."board_id" AND a."is_active" AND a."deleted_at" IS NULL
            WHERE l."to_item_id" = n."item_id"
          )
        )
        OR (
          n."type" IN ('item.moved_to_board', 'schedule.fired', 'webhook_in.received')
          AND n."account_id" IN (
            SELECT a."account_id" FROM "automations" a WHERE a."is_active" AND a."deleted_at" IS NULL
            UNION
            SELECT w."account_id" FROM "webhooks" w WHERE w."is_active" AND w."deleted_at" IS NULL
          )
        )
      )
  ) s
  WHERE s.specs IS NOT NULL;
  RETURN NULL;
END $$;
