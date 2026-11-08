-- Realtime (01 §4, M4): every activity_log row and every notification is announced on the `bines_events` channel.
-- NOTIFY is delivered only when the writing transaction commits, so a rolled-back mutation is never broadcast.
-- The payload carries ids only (8 KB limit); the API hub filters per connection and the browser refetches.
CREATE FUNCTION "bines_notify_activity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('bines_events', json_build_object(
    'id', NEW."id", 'account_id', NEW."account_id", 'type', NEW."type",
    'board_id', NEW."board_id", 'item_id', NEW."item_id", 'column_id', NEW."column_id",
    'actor_id', NEW."actor_id", 'actor_type', NEW."actor_type",
    'batch_id', NEW."batch_id", 'request_id', NEW."request_id")::text);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_notify" AFTER INSERT ON "activity_log" FOR EACH ROW EXECUTE FUNCTION "bines_notify_activity"();--> statement-breakpoint
CREATE FUNCTION "bines_notify_notification"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('bines_events', json_build_object(
    'id', NEW."id", 'account_id', NEW."account_id", 'type', 'notification.created',
    'board_id', NEW."board_id", 'item_id', NEW."item_id", 'user_id', NEW."user_id",
    'actor_id', NEW."actor_id")::text);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_notifications_notify" AFTER INSERT ON "notifications" FOR EACH ROW EXECUTE FUNCTION "bines_notify_notification"();
