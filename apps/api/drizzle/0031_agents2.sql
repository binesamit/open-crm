CREATE TABLE "agent_knowledge" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"agent_id" varchar(26) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"title" varchar(255) NOT NULL,
	"asset_id" varchar(26),
	"doc_id" varchar(26),
	"board_id" varchar(26),
	"body" text,
	"status" varchar(16) DEFAULT 'indexing' NOT NULL,
	"error" varchar(120),
	"chunks" integer DEFAULT 0 NOT NULL,
	"chars" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"added_by" varchar(26),
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"agent_id" varchar(26) NOT NULL,
	"source_id" varchar(26) NOT NULL,
	"ord" integer NOT NULL,
	"body" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', body || ' ' || regexp_replace(body, '(^|[^א-ת])[והבלמשכ]([א-ת]{2,})', '\1\2', 'g'))) STORED
);
--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_agent_knowledge_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."agent_knowledge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_agent_knowledge_agent" ON "agent_knowledge" USING btree ("agent_id") WHERE "agent_knowledge"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_knowledge_chunks_source" ON "knowledge_chunks" USING btree ("source_id","ord");--> statement-breakpoint
CREATE INDEX "ix_knowledge_chunks_tsv" ON "knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
-- Agent triggers (מ8): a mention of an agent in an update / reply, or its assignment in a people column, starts a
-- run. They are heard by the same `automation.dispatch` job, so the dispatch trigger (0024) now also queues events
-- of accounts with an active agent that listens (mention / assign), and update replies (`update.replied`).
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
        'update.replied')
      AND n."account_id" IN (
        SELECT a."account_id" FROM "automations" a WHERE a."is_active" AND a."deleted_at" IS NULL
        UNION
        SELECT w."account_id" FROM "webhooks" w WHERE w."is_active" AND w."deleted_at" IS NULL
        UNION
        SELECT g."account_id" FROM "agents" g WHERE g."is_active" AND g."deleted_at" IS NULL
          AND (g."triggers" ->> 'mention' = 'true' OR g."triggers" ->> 'assign' = 'true')
      )
  ) s
  WHERE s.specs IS NOT NULL;
  RETURN NULL;
END $$;