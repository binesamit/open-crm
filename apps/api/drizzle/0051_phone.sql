ALTER TYPE "public"."update_source" ADD VALUE 'sms';--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "meta" jsonb;