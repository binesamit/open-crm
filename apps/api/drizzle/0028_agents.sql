ALTER TYPE "public"."actor_type" ADD VALUE 'agent';--> statement-breakpoint
CREATE TABLE "agent_approvals" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"agent_id" varchar(26) NOT NULL,
	"run_id" varchar(26) NOT NULL,
	"tool_use_id" varchar(80) NOT NULL,
	"tool" varchar(64) NOT NULL,
	"input" jsonb,
	"preview" text DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_by" varchar(26),
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_steps" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"run_id" varchar(26) NOT NULL,
	"seq" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"tool" varchar(64),
	"tool_use_id" varchar(80),
	"input" jsonb,
	"output" jsonb,
	"is_error" boolean DEFAULT false NOT NULL,
	"outcome" varchar(16),
	"content" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"agent_id" varchar(26) NOT NULL,
	"trigger" varchar(16) DEFAULT 'manual' NOT NULL,
	"prompt" text,
	"item_id" varchar(26),
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"skip_reason" varchar(64),
	"error" text,
	"final_text" text,
	"model" varchar(80),
	"steps" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"requested_by" varchar(26),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"name" varchar(80) NOT NULL,
	"avatar" varchar(16),
	"role" varchar(200) DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"connection_id" varchar(26),
	"model" varchar(80) NOT NULL,
	"effort" varchar(16) DEFAULT 'medium' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_mode" varchar(16) DEFAULT 'learner' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"template_key" varchar(40),
	"created_by" varchar(26),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_connection_id_ai_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ai_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_approvals_call" ON "agent_approvals" USING btree ("run_id","tool_use_id");--> statement-breakpoint
CREATE INDEX "ix_agent_approvals_pending" ON "agent_approvals" USING btree ("account_id","expires_at") WHERE "agent_approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_run_steps_seq" ON "agent_run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "ix_agent_runs_agent_created" ON "agent_runs" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_agent_runs_account_status" ON "agent_runs" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "ix_agents_account" ON "agents" USING btree ("account_id") WHERE "agents"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agents_user" ON "agents" USING btree ("user_id");--> statement-breakpoint
-- Agent action log (the planning notes "AGENTS-MCP" §3.3, מ6). An agent's write tool runs in a transaction that sets
-- `bines.agent` (set_config local, like `bines.automation` in 0017 and `bines.mcp` in 0025). Every activity row
-- written there is the agent's: actor_type 'agent' (actor_id stays the agent's service user), batch_id = the run
-- id — so "undo the whole run" is the existing batch undo — and payload.meta.agent = {agent_id, run_id, step, tool}.
CREATE FUNCTION "bines_activity_agent_actor"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctx text := current_setting('bines.agent', true);
BEGIN
  IF ctx IS NOT NULL AND ctx <> '' THEN
    NEW."actor_type" := 'agent';
    NEW."batch_id" := coalesce(ctx::jsonb ->> 'run_id', NEW."batch_id");
    NEW."payload" := jsonb_set(NEW."payload", '{meta}',
      coalesce(NEW."payload" -> 'meta', '{}'::jsonb) || jsonb_build_object('agent', ctx::jsonb));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_agent_actor" BEFORE INSERT ON "activity_log" FOR EACH ROW EXECUTE FUNCTION "bines_activity_agent_actor"();