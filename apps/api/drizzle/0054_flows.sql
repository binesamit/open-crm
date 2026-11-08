CREATE TABLE "flow_connections" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"platform" varchar(16) NOT NULL,
	"name" varchar(120) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"secret_hint" varchar(12),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" varchar(12) DEFAULT 'unknown' NOT NULL,
	"last_error" varchar(300),
	"checked_at" timestamp with time zone,
	"monitor_since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "flow_failure_alerts" (
	"connection_id" varchar(26) NOT NULL,
	"run_id" varchar(64) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"flow_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_failure_alerts_connection_id_run_id_pk" PRIMARY KEY("connection_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "flow_connections" ADD CONSTRAINT "flow_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_connections" ADD CONSTRAINT "flow_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_failure_alerts" ADD CONSTRAINT "flow_failure_alerts_connection_id_flow_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."flow_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_failure_alerts" ADD CONSTRAINT "flow_failure_alerts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_flow_connections_account" ON "flow_connections" USING btree ("account_id") WHERE "flow_connections"."deleted_at" is null;