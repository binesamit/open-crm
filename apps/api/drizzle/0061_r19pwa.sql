-- r19pwa (the planning notes "PWA"): the phone channel (Web Push) — a third notification channel and the devices that get it.
ALTER TYPE "public"."notification_channel" ADD VALUE 'push';--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"session_id" varchar(26),
	"endpoint" text NOT NULL,
	"p256dh" varchar(256) NOT NULL,
	"auth" varchar(128) NOT NULL,
	"device_label" varchar(80) DEFAULT '' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_push_subscriptions_endpoint" ON "push_subscriptions" USING btree ("account_id","endpoint");--> statement-breakpoint
CREATE INDEX "ix_push_subscriptions_user" ON "push_subscriptions" USING btree ("account_id","user_id");--> statement-breakpoint
-- A new notification of someone with a registered phone queues `notifications.push` at once (the worker checks the
-- settings, quiet hours and read state). No graphile_worker schema (tests, a database the worker never ran on) =
-- nothing queued, like the email trigger (0010).
CREATE FUNCTION "bines_enqueue_notification_push"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NOT NULL AND EXISTS (
    SELECT 1 FROM "push_subscriptions" s WHERE s."account_id" = NEW."account_id" AND s."user_id" = NEW."user_id"
  ) THEN
    EXECUTE 'SELECT graphile_worker.add_job($1, $2, max_attempts => 3, job_key => $3)'
      USING 'notifications.push', json_build_object('id', NEW."id"), 'push:' || NEW."id";
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "tr_notifications_push" AFTER INSERT ON "notifications" FOR EACH ROW EXECUTE FUNCTION "bines_enqueue_notification_push"();
