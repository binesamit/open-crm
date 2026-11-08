-- Email for notifications (M4 step 3, D15): every new notification enqueues `notifications.dispatch` in the
-- same transaction, a minute later — read in the bell by then, no email. The worker owns the graphile_worker
-- schema; where it is missing (tests, a database the worker never ran on) the trigger does nothing.
CREATE FUNCTION "bines_enqueue_notification_email"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NOT NULL THEN
    EXECUTE 'SELECT graphile_worker.add_job($1, $2, run_at => $3, max_attempts => 5, job_key => $4)'
      USING 'notifications.dispatch', json_build_object('id', NEW."id"), now() + interval '1 minute', 'notification:' || NEW."id";
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_notifications_email" AFTER INSERT ON "notifications" FOR EACH ROW EXECUTE FUNCTION "bines_enqueue_notification_email"();
