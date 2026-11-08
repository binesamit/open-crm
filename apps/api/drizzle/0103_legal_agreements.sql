ALTER TABLE "account_subscriptions" ADD COLUMN "purchased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD COLUMN "renewal_reminded_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD COLUMN "cancellation" jsonb;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD COLUMN "material" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "purchase_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD COLUMN "marketing_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "marketing_opt_in_at" timestamp with time zone;