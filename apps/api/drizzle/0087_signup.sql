CREATE TABLE "signup_requests" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(120) NOT NULL,
	"org_name" varchar(120) NOT NULL,
	"plan_version_id" varchar(26),
	"method" varchar(16) NOT NULL,
	"status" varchar(20) NOT NULL,
	"token_hash" varchar(64),
	"password_hash" text,
	"locale" varchar(8),
	"timezone" varchar(64),
	"currency" varchar(3),
	"consents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(300),
	"account_id" varchar(26),
	"user_id" varchar(26),
	"decided_by" varchar(26),
	"decided_at" timestamp with time zone,
	"reason" text,
	"sends" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD COLUMN "trial_end_status" varchar(16);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "origin" varchar(16) DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_signup_requests_email" ON "signup_requests" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "ix_signup_requests_status" ON "signup_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_signup_requests_created" ON "signup_requests" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_signup_requests_ip" ON "signup_requests" USING btree ("ip","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_signup_requests_token" ON "signup_requests" USING btree ("token_hash");