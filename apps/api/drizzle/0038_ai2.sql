CREATE TABLE "ai_column_pending" (
	"account_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"actor_id" varchar(26),
	"due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_column_pending_item_id_column_id_pk" PRIMARY KEY("item_id","column_id")
);
--> statement-breakpoint
CREATE TABLE "ai_column_runs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"requested_by" varchar(26),
	"trigger" varchar(16) DEFAULT 'manual' NOT NULL,
	"mode" varchar(16) DEFAULT 'items' NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"stopped" varchar(40),
	"batch_id" varchar(26),
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_column_usage" (
	"account_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"month" varchar(7) NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_column_usage_column_id_month_pk" PRIMARY KEY("column_id","month")
);
--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"board_id" varchar(26),
	"item_id" varchar(26),
	"title" varchar(120) DEFAULT '' NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"conversation_id" varchar(26) NOT NULL,
	"seq" integer NOT NULL,
	"role" varchar(16) NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_column_pending" ADD CONSTRAINT "ai_column_pending_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_pending" ADD CONSTRAINT "ai_column_pending_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_pending" ADD CONSTRAINT "ai_column_pending_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_pending" ADD CONSTRAINT "ai_column_pending_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_runs" ADD CONSTRAINT "ai_column_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_runs" ADD CONSTRAINT "ai_column_runs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_runs" ADD CONSTRAINT "ai_column_runs_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_runs" ADD CONSTRAINT "ai_column_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_usage" ADD CONSTRAINT "ai_column_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_column_usage" ADD CONSTRAINT "ai_column_usage_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ai_column_pending_due" ON "ai_column_pending" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "ix_ai_column_runs_column" ON "ai_column_runs" USING btree ("column_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_ai_conversations_user" ON "ai_conversations" USING btree ("account_id","user_id","board_id") WHERE "ai_conversations"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_ai_messages_seq" ON "ai_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
-- AI writes of a person (the planning notes "AGENTS-MCP" מ11–מ12): an AI column run or actions approved in the assistant
-- panel run in a transaction that sets `bines.ai` (set_config local, like `bines.mcp` in 0025). The activity rows
-- stay the person's (actor_id, actor_type) but get the run's / approval's batch_id — one undoable action — and
-- payload.meta.via = 'ai' + payload.meta.ai = {source: column|assistant, …}.
CREATE FUNCTION "bines_activity_ai_actor"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctx text := current_setting('bines.ai', true);
BEGIN
  IF ctx IS NOT NULL AND ctx <> '' THEN
    NEW."batch_id" := coalesce(ctx::jsonb ->> 'batch_id', NEW."batch_id");
    NEW."payload" := jsonb_set(NEW."payload", '{meta}',
      coalesce(NEW."payload" -> 'meta', '{}'::jsonb) || jsonb_build_object('via', 'ai', 'ai', ctx::jsonb));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_ai_actor" BEFORE INSERT ON "activity_log" FOR EACH ROW EXECUTE FUNCTION "bines_activity_ai_actor"();--> statement-breakpoint
-- Auto-run AI columns hear cell changes through the dispatch job: an account with an auto-run AI column is
-- dispatched too (the rest as in 0037).
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
        'update.replied', 'button.clicked')
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
