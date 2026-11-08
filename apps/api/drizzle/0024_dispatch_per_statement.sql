-- Bulk edit / file import (12-ROADMAP B3): one statement may insert tens of thousands of activity rows. The
-- automation dispatch trigger ran per row (two EXISTS + one graphile add_job each: 10,000 imported rows with an
-- active automation took ~60 s); it now runs once per statement over the inserted rows (a transition table) and
-- queues the same jobs — one `automation.dispatch` per event of a listened type, in an account with an active
-- automation or webhook, max 5 attempts — with a single add_jobs. Same transaction, same jobs, same order.
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
        'item.moved_to_board', 'group.created', 'column.created', 'schedule.fired', 'webhook_in.received')
      AND n."account_id" IN (
        SELECT a."account_id" FROM "automations" a WHERE a."is_active" AND a."deleted_at" IS NULL
        UNION
        SELECT w."account_id" FROM "webhooks" w WHERE w."is_active" AND w."deleted_at" IS NULL
      )
  ) s
  WHERE s.specs IS NOT NULL;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER "tr_activity_log_automation_dispatch" ON "activity_log";--> statement-breakpoint
DROP FUNCTION "bines_enqueue_automation_dispatch"();--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_automation_dispatch" AFTER INSERT ON "activity_log"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "bines_enqueue_automation_dispatch_rows"();
