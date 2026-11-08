CREATE TABLE "ai_connections" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"name" varchar(80) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"key_enc" text NOT NULL,
	"key_hint" varchar(8) NOT NULL,
	"default_model" varchar(80),
	"last_test" jsonb,
	"last_used_at" timestamp with time zone,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"account_id" varchar(26) NOT NULL,
	"day" date NOT NULL,
	"source" varchar(32) NOT NULL,
	"connection_id" varchar(26) NOT NULL,
	"model" varchar(80) NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_account_id_day_source_connection_id_model_pk" PRIMARY KEY("account_id","day","source","connection_id","model")
);
--> statement-breakpoint
ALTER TABLE "ai_connections" ADD CONSTRAINT "ai_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_connections" ADD CONSTRAINT "ai_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ai_connections_account" ON "ai_connections" USING btree ("account_id") WHERE "ai_connections"."deleted_at" is null;--> statement-breakpoint
-- MCP action log (the planning notes "AGENTS-MCP" §3.3, מ4). A tool call of the MCP server runs its writes in a
-- transaction that sets `bines.mcp` (set_config local, like `bines.automation` in 0017). Every activity row written
-- there stays the user's (actor_id) but is marked as coming through the API (actor_type 'api'), gets
-- payload.meta.via = 'mcp' + payload.meta.mcp = {tool, client, token_id, batch_id}, and the call's batch_id — so one
-- tool call is one undoable action ("undo" / Ctrl+Z / the activity log), whatever the service wrote.
CREATE FUNCTION "bines_activity_mcp_actor"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctx text := current_setting('bines.mcp', true);
BEGIN
  IF ctx IS NOT NULL AND ctx <> '' THEN
    NEW."actor_type" := 'api';
    NEW."batch_id" := coalesce(ctx::jsonb ->> 'batch_id', NEW."batch_id");
    NEW."payload" := jsonb_set(NEW."payload", '{meta}',
      coalesce(NEW."payload" -> 'meta', '{}'::jsonb) || jsonb_build_object('via', 'mcp', 'mcp', ctx::jsonb));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_mcp_actor" BEFORE INSERT ON "activity_log" FOR EACH ROW EXECUTE FUNCTION "bines_activity_mcp_actor"();