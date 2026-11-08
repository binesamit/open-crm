-- invites: who cancelled an invitation, its email history (last sent, by whom, how many, status) and when it was opened.
ALTER TABLE "account_invitations" ADD COLUMN "revoked_by" varchar(26);--> statement-breakpoint
ALTER TABLE "account_invitations" ADD COLUMN "last_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD COLUMN "last_sent_by" varchar(26);--> statement-breakpoint
ALTER TABLE "account_invitations" ADD COLUMN "send_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD COLUMN "email_status" varchar(16);--> statement-breakpoint
ALTER TABLE "account_invitations" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_last_sent_by_users_id_fk" FOREIGN KEY ("last_sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Open invitations from before: counted as emailed once, when made (most were).
UPDATE "account_invitations" SET "send_count" = 1, "last_sent_at" = "created_at", "email_status" = 'sent' WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
