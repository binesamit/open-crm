CREATE TABLE "account_web_search" (
	"account_id" varchar(26) PRIMARY KEY NOT NULL,
	"provider" varchar(16),
	"key_enc" text,
	"key_hint" varchar(16),
	"max_per_run" integer DEFAULT 10 NOT NULL,
	"max_per_day" integer DEFAULT 200 NOT NULL,
	"updated_by" varchar(26),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "web_search" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "account_web_search" ADD CONSTRAINT "account_web_search_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_web_search" ADD CONSTRAINT "account_web_search_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;