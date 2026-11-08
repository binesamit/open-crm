CREATE TABLE "trial_emails_sent" (
	"subscription_id" varchar(26) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"sent" boolean DEFAULT true NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_emails_sent_subscription_id_kind_pk" PRIMARY KEY("subscription_id","kind")
);
--> statement-breakpoint
ALTER TABLE "trial_emails_sent" ADD CONSTRAINT "trial_emails_sent_subscription_id_account_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."account_subscriptions"("id") ON DELETE cascade ON UPDATE no action;