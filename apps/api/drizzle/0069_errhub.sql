-- Errors & health hub: deduplicated error events, their hourly counts and the alerts that fired.
CREATE TABLE "error_alerts" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"rule_id" varchar(40) NOT NULL,
	"rule_name" varchar(80) DEFAULT '' NOT NULL,
	"mode" varchar(12) NOT NULL,
	"account_id" varchar(26),
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"read_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedupe_key" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_event_hours" (
	"event_id" varchar(26) NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "error_event_hours_event_id_hour_pk" PRIMARY KEY("event_id","hour")
);
--> statement-breakpoint
CREATE TABLE "error_events" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"fingerprint" varchar(32) NOT NULL,
	"account_id" varchar(26),
	"source" varchar(16) NOT NULL,
	"code" varchar(80) NOT NULL,
	"severity" varchar(12) NOT NULL,
	"message" varchar(300) DEFAULT '' NOT NULL,
	"links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"assignee_id" varchar(26),
	"muted_until" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(26),
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"ticket_id" varchar(26),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "error_alerts" ADD CONSTRAINT "error_alerts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_event_hours" ADD CONSTRAINT "error_event_hours_event_id_error_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."error_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_error_alerts_created" ON "error_alerts" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_error_alerts_dedupe" ON "error_alerts" USING btree ("dedupe_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_error_event_hours_hour" ON "error_event_hours" USING btree ("hour");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_error_events_fingerprint" ON "error_events" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "ix_error_events_last_seen" ON "error_events" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_error_events_account" ON "error_events" USING btree ("account_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_error_events_status" ON "error_events" USING btree ("status","last_seen_at" DESC NULLS LAST);