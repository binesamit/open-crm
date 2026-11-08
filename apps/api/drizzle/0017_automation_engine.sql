ALTER TYPE "public"."automation_run_status" ADD VALUE 'partial' BEFORE 'failed';--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "skip_reason" varchar(64);--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "depth" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "event_type" varchar(64);--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "consecutive_errors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "deactivated_reason" varchar(160);--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "note" text;--> statement-breakpoint
CREATE INDEX "ix_automations_account_active" ON "automations" USING btree ("account_id") WHERE "automations"."is_active" and "automations"."deleted_at" is null;--> statement-breakpoint
-- Automation engine (M6 stage 2, 04 §5.1). Actions run through the ordinary services inside a transaction that
-- sets `bines.automation` (set_config local); every activity row written there is the automation's: actor_type,
-- automation_id, and payload.meta.automation = {automation_id, run_id, depth, chain} for loop protection.
CREATE FUNCTION "bines_activity_automation_actor"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctx text := current_setting('bines.automation', true);
BEGIN
  IF ctx IS NOT NULL AND ctx <> '' THEN
    NEW."actor_type" := 'automation';
    NEW."automation_id" := ctx::jsonb ->> 'automation_id';
    NEW."payload" := jsonb_set(NEW."payload", '{meta}',
      coalesce(NEW."payload" -> 'meta', '{}'::jsonb) || jsonb_build_object('automation', ctx::jsonb));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_automation_actor" BEFORE INSERT ON "activity_log" FOR EACH ROW EXECUTE FUNCTION "bines_activity_automation_actor"();--> statement-breakpoint
-- Every event a trigger can listen to enqueues `automation.dispatch` in the same transaction (no lost events),
-- but only in an account that has an active automation. The worker owns the graphile_worker schema; without it
-- (tests) nothing is enqueued and the tests dispatch by hand.
CREATE FUNCTION "bines_enqueue_automation_dispatch"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NOT NULL AND EXISTS (
    SELECT 1 FROM "automations" a WHERE a."account_id" = NEW."account_id" AND a."is_active" AND a."deleted_at" IS NULL
  ) THEN
    EXECUTE 'SELECT graphile_worker.add_job($1, $2, max_attempts => 5)'
      USING 'automation.dispatch', json_build_object('event_id', NEW."id", 'account_id', NEW."account_id");
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_automation_dispatch" AFTER INSERT ON "activity_log" FOR EACH ROW
  WHEN (NEW."type" IN ('item.created', 'cell.changed', 'item.renamed', 'item.moved_to_group', 'update.created',
    'item.archived', 'item.deleted', 'item.restored', 'item.unarchived', 'schedule.fired', 'webhook_in.received'))
  EXECUTE FUNCTION "bines_enqueue_automation_dispatch"();
