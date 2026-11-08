-- plan-lock: the owner can close an account — only its plan, the offered plans and support answer
-- nothing is deleted. `status_message` = the owner's words to the account's members (why it is closed).
ALTER TYPE "public"."subscription_status" ADD VALUE 'closed';--> statement-breakpoint
ALTER TABLE "account_subscriptions" ADD COLUMN "status_message" text;
