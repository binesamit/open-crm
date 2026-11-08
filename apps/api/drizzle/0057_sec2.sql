CREATE TABLE "sender_requests" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"value" varchar(320) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reason" text,
	"requested_by" varchar(26),
	"decided_by" varchar(26),
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sender_requests" ADD CONSTRAINT "sender_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_requests" ADD CONSTRAINT "sender_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_requests" ADD CONSTRAINT "sender_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_sender_requests_account" ON "sender_requests" USING btree ("account_id","kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_sender_requests_status" ON "sender_requests" USING btree ("status","created_at");--> statement-breakpoint
-- Grandfathering (S-46): custom senders already saved before approval existed stay in force — each one is
-- recorded as approved (hand-written data step; requested_by = whoever last saved the settings).
INSERT INTO "sender_requests" ("id", "account_id", "kind", "value", "status", "reason", "requested_by", "decided_at")
SELECT upper(substr(md5(random()::text || s."account_id" || v."kind"), 1, 26)), s."account_id", v."kind", v."value",
       'approved', 'grandfathered', s."updated_by", now()
FROM "account_settings" s
CROSS JOIN LATERAL (VALUES
  ('email_sender_name', btrim(s."settings" #>> '{branding,email_sender_name}')),
  ('email_reply_to', btrim(s."settings" #>> '{branding,email_reply_to}')),
  ('sms_sender_id', btrim(s."settings" #>> '{sms,sender_id}'))
) AS v("kind", "value")
WHERE v."value" IS NOT NULL AND v."value" <> '';
