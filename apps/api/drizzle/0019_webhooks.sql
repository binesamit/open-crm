ALTER TABLE "webhook_deliveries" ALTER COLUMN "webhook_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "automation_id" varchar(26);--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "action_index" integer;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "method" varchar(8) DEFAULT 'POST' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "event_type" varchar(64);--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "response_ms" integer;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "disabled_reason" varchar(120);--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "description" varchar(255);--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_webhooks_account_active" ON "webhooks" USING btree ("account_id") WHERE "webhooks"."is_active" = true and "webhooks"."deleted_at" is null;--> statement-breakpoint
-- Webhooks (M6 stage 7): the same dispatch job also fans an event out to the board's webhooks, so it is queued
-- when the account has an active automation OR an active webhook; and it hears the events webhooks subscribe to.
CREATE OR REPLACE FUNCTION "bines_enqueue_automation_dispatch"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "automations" a WHERE a."account_id" = NEW."account_id" AND a."is_active" AND a."deleted_at" IS NULL)
    OR EXISTS (SELECT 1 FROM "webhooks" w WHERE w."account_id" = NEW."account_id" AND w."is_active" AND w."deleted_at" IS NULL)
  ) THEN
    EXECUTE 'SELECT graphile_worker.add_job($1, $2, max_attempts => 5)'
      USING 'automation.dispatch', json_build_object('event_id', NEW."id", 'account_id', NEW."account_id");
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER "tr_activity_log_automation_dispatch" ON "activity_log";--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_automation_dispatch" AFTER INSERT ON "activity_log" FOR EACH ROW
  WHEN (NEW."type" IN ('item.created', 'cell.changed', 'item.renamed', 'item.moved_to_group', 'update.created',
    'update.edited', 'update.deleted', 'item.archived', 'item.deleted', 'item.restored', 'item.unarchived',
    'item.moved_to_board', 'group.created', 'column.created', 'schedule.fired', 'webhook_in.received'))
  EXECUTE FUNCTION "bines_enqueue_automation_dispatch"();
