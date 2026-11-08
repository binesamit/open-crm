CREATE TABLE "platform_settings" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" varchar(26),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ALTER COLUMN "rate_limit_per_minute" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "api_tokens" ALTER COLUMN "rate_limit_per_minute" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "daily_quota" integer;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The old fixed defaults (600/min personal, 1,200/min service) become "inherit": the account / platform settings now decide.
UPDATE "api_tokens" SET "rate_limit_per_minute" = NULL WHERE ("token_prefix" LIKE 'bos_svc_%' AND "rate_limit_per_minute" = 1200) OR ("token_prefix" NOT LIKE 'bos_svc_%' AND "rate_limit_per_minute" = 600);
