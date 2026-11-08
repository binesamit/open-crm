-- M8 ד9–ד11 (views2): the Map view type, geocoded addresses (location column) and the account's Google Places key.
-- A button click (`button.clicked`, button column) is heard by automations like the other listened events.
ALTER TYPE "view_type" ADD VALUE IF NOT EXISTS 'map';--> statement-breakpoint
CREATE TABLE "geocode_cache" (
	"account_id" varchar(26) NOT NULL,
	"query" varchar(500) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"found" boolean NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"country_code" varchar(2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geocode_cache_account_id_query_pk" PRIMARY KEY("account_id","query")
);--> statement-breakpoint
CREATE TABLE "account_geo" (
	"account_id" varchar(26) PRIMARY KEY NOT NULL,
	"google_key" text,
	"google_key_hint" varchar(16),
	"updated_by" varchar(26),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "geocode_cache" ADD CONSTRAINT "geocode_cache_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_geo" ADD CONSTRAINT "account_geo_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_geo" ADD CONSTRAINT "account_geo_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bines_enqueue_automation_dispatch_rows"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM graphile_worker.add_jobs(s.specs)
  FROM (
    SELECT array_agg(
      ROW('automation.dispatch', json_build_object('event_id', n."id", 'account_id', n."account_id"),
        NULL, NULL, 5, NULL, NULL, NULL)::graphile_worker.job_spec
      ORDER BY n."id") AS specs
    FROM new_rows n
    WHERE n."type" IN ('item.created', 'cell.changed', 'item.renamed', 'item.moved_to_group', 'update.created',
        'update.edited', 'update.deleted', 'item.archived', 'item.deleted', 'item.restored', 'item.unarchived',
        'item.moved_to_board', 'group.created', 'column.created', 'schedule.fired', 'webhook_in.received',
        'update.replied', 'button.clicked')
      AND n."account_id" IN (
        SELECT a."account_id" FROM "automations" a WHERE a."is_active" AND a."deleted_at" IS NULL
        UNION
        SELECT w."account_id" FROM "webhooks" w WHERE w."is_active" AND w."deleted_at" IS NULL
        UNION
        SELECT g."account_id" FROM "agents" g WHERE g."is_active" AND g."deleted_at" IS NULL
          AND (g."triggers" ->> 'mention' = 'true' OR g."triggers" ->> 'assign' = 'true')
      )
  ) s
  WHERE s.specs IS NOT NULL;
  RETURN NULL;
END $$;
