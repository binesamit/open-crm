CREATE TABLE "support_agent_actions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"run_id" varchar(26) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"decided_by" varchar(26),
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_agent_runs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"error_event_id" varchar(26),
	"ticket_id" varchar(26),
	"account_id" varchar(26),
	"trigger" varchar(12) DEFAULT 'manual' NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"model" varchar(120),
	"report" jsonb,
	"final_text" text,
	"error" varchar(120),
	"steps" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"code_ref" varchar(64),
	"requested_by" varchar(26),
	"dev_status" varchar(16),
	"dev_approved_by" varchar(26),
	"dev_approved_at" timestamp with time zone,
	"dev_branch" varchar(120),
	"dev_pr_url" varchar(300),
	"dev_error" varchar(120),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_agent_steps" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"run_id" varchar(26) NOT NULL,
	"seq" integer NOT NULL,
	"kind" varchar(8) NOT NULL,
	"tool" varchar(64),
	"tool_use_id" varchar(80),
	"input" jsonb,
	"output" jsonb,
	"is_error" boolean DEFAULT false NOT NULL,
	"content" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_agent_actions" ADD CONSTRAINT "support_agent_actions_run_id_support_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."support_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_actions" ADD CONSTRAINT "support_agent_actions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_runs" ADD CONSTRAINT "support_agent_runs_error_event_id_error_events_id_fk" FOREIGN KEY ("error_event_id") REFERENCES "public"."error_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_runs" ADD CONSTRAINT "support_agent_runs_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_runs" ADD CONSTRAINT "support_agent_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_runs" ADD CONSTRAINT "support_agent_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_runs" ADD CONSTRAINT "support_agent_runs_dev_approved_by_users_id_fk" FOREIGN KEY ("dev_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_steps" ADD CONSTRAINT "support_agent_steps_run_id_support_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."support_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_support_agent_actions_run" ON "support_agent_actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ix_support_agent_runs_error" ON "support_agent_runs" USING btree ("error_event_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_support_agent_runs_ticket" ON "support_agent_runs" USING btree ("ticket_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_support_agent_runs_created" ON "support_agent_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_support_agent_steps_seq" ON "support_agent_steps" USING btree ("run_id","seq");