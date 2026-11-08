CREATE TABLE "cost_entries" (
	"source_id" varchar(26) NOT NULL,
	"day" date NOT NULL,
	"metric" varchar(60) NOT NULL,
	"service" varchar(120) DEFAULT '' NOT NULL,
	"account_ref" varchar(26) DEFAULT '' NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit" varchar(24) NOT NULL,
	"amount" double precision,
	"cost" double precision,
	"currency" varchar(3),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_entries_source_id_day_metric_service_account_ref_pk" PRIMARY KEY("source_id","day","metric","service","account_ref")
);
--> statement-breakpoint
CREATE TABLE "cost_fx_rates" (
	"day" date NOT NULL,
	"currency" varchar(3) NOT NULL,
	"quote" varchar(3) NOT NULL,
	"rate" double precision NOT NULL,
	"source" varchar(16) NOT NULL,
	CONSTRAINT "cost_fx_rates_day_currency_quote_pk" PRIMARY KEY("day","currency","quote")
);
--> statement-breakpoint
CREATE TABLE "cost_prices" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"metric" varchar(60) NOT NULL,
	"service" varchar(120) DEFAULT '*' NOT NULL,
	"price" double precision NOT NULL,
	"currency" varchar(3) NOT NULL,
	"free_per_month" double precision DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"note" varchar(255),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_sources" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"adapter" varchar(32) NOT NULL,
	"name" varchar(80),
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_sealed" text,
	"secret_hint" varchar(16),
	"budget_monthly" double precision,
	"last_sync_at" timestamp with time zone,
	"last_sync_ok" boolean,
	"last_error" text,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_meter" (
	"day" date NOT NULL,
	"account_ref" varchar(26) DEFAULT '' NOT NULL,
	"metric" varchar(60) NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_meter_day_account_ref_metric_pk" PRIMARY KEY("day","account_ref","metric")
);
--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_source_id_cost_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."cost_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_prices" ADD CONSTRAINT "cost_prices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_sources" ADD CONSTRAINT "cost_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_cost_entries_day" ON "cost_entries" USING btree ("day");--> statement-breakpoint
CREATE INDEX "ix_cost_entries_metric_day" ON "cost_entries" USING btree ("metric","day");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_cost_prices_metric_service_from" ON "cost_prices" USING btree ("metric","service","effective_from");