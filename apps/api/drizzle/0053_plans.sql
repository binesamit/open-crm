-- Subscription plans (stages 1-3): owner-defined plans with immutable versions (grandfathering)
-- each account's subscription history (current = ended_at is null), usage counters and once-a-period alert marks.
-- Nothing is seeded: an account with no subscription is legacy = unlimited.
CREATE TYPE "public"."subscription_status" AS ENUM('trial', 'active', 'past_due', 'read_only', 'suspended');--> statement-breakpoint
CREATE TABLE "account_subscriptions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"plan_version_id" varchar(26) NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"status_since" timestamp with time zone DEFAULT now() NOT NULL,
	"interval" varchar(8) DEFAULT 'month' NOT NULL,
	"seats" integer,
	"period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"provider" varchar(40),
	"external_id" varchar(200),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "account_usage_counters" (
	"account_id" varchar(26) NOT NULL,
	"period" varchar(10) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"value" double precision DEFAULT 0 NOT NULL,
	"warned_at" timestamp with time zone,
	"reached_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_usage_counters_account_id_period_kind_pk" PRIMARY KEY("account_id","period","kind")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"plan_id" varchar(26) NOT NULL,
	"version" integer NOT NULL,
	"price_monthly_minor" bigint DEFAULT 0 NOT NULL,
	"price_yearly_minor" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'ILS' NOT NULL,
	"vat_included" boolean DEFAULT true NOT NULL,
	"pricing" varchar(16) DEFAULT 'flat' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text,
	"visibility" varchar(16) DEFAULT 'public' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD CONSTRAINT "account_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD CONSTRAINT "account_subscriptions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD CONSTRAINT "account_subscriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_usage_counters" ADD CONSTRAINT "account_usage_counters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_account_subscriptions_current" ON "account_subscriptions" USING btree ("account_id") WHERE "account_subscriptions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "ix_account_subscriptions_account" ON "account_subscriptions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_account_subscriptions_version" ON "account_subscriptions" USING btree ("plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_plan_versions_plan_version" ON "plan_versions" USING btree ("plan_id","version");