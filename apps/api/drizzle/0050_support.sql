CREATE TABLE "support_recovery_requests" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"requested_by" varchar(26),
	"target_user_id" varchar(26) NOT NULL,
	"target_email" varchar(320) NOT NULL,
	"reason" text NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" varchar(26),
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_access_grants" ALTER COLUMN "scope" SET DEFAULT 'read';--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "grantee_kind" varchar(16) DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "granted_to_email" varchar(320);--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "revoked_by" varchar(26);--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_recovery_requests" ADD CONSTRAINT "support_recovery_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_recovery_requests" ADD CONSTRAINT "support_recovery_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_recovery_requests" ADD CONSTRAINT "support_recovery_requests_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_recovery_requests" ADD CONSTRAINT "support_recovery_requests_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_support_recovery_account" ON "support_recovery_requests" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;