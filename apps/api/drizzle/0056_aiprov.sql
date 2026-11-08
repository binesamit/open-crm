-- AI providers: an OpenAI-compatible connection's base URL and hand-added models; dynamic AI prices
-- the platform's price table, seeded with the prices that used to be in code (USD per 1M tokens).
CREATE TABLE "ai_prices" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(120) NOT NULL,
	"input" double precision NOT NULL,
	"output" double precision NOT NULL,
	"cache_read" double precision,
	"cache_write" double precision,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"note" varchar(255),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_connections" ADD COLUMN "base_url" varchar(500);--> statement-breakpoint
ALTER TABLE "ai_connections" ADD COLUMN "manual_models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_prices" ADD CONSTRAINT "ai_prices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_ai_prices_provider_model" ON "ai_prices" USING btree ("provider","model");--> statement-breakpoint
INSERT INTO "ai_prices" ("id", "provider", "model", "input", "output", "cache_read", "cache_write", "currency") VALUES
	('01M4A1PR1CE5EED00000000001', 'anthropic', 'claude-opus-5-5', 4, 20, 0.2, 5, 'USD'),
	('01M4A1PR1CE5EED00000000002', 'anthropic', 'claude-sonnet-5-5', 2, 10, 0.2, 2.5, 'USD'),
	('01M4A1PR1CE5EED00000000003', 'anthropic', 'claude-haiku-4-5', 1, 5, 0.1, 1.25, 'USD')
ON CONFLICT ("provider", "model") DO NOTHING;
