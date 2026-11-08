CREATE TABLE "plan_addons" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text,
	"limit_kind" varchar(32) NOT NULL,
	"unit_amount" double precision NOT NULL,
	"price_monthly_minor" bigint DEFAULT 0 NOT NULL,
	"price_yearly_minor" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'ILS' NOT NULL,
	"vat_included" boolean DEFAULT true NOT NULL,
	"plan_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_qty" integer DEFAULT 20 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD COLUMN "addons" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "highlights" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "recommended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "min_seats" integer;--> statement-breakpoint
ALTER TABLE "plan_addons" ADD CONSTRAINT "plan_addons_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;