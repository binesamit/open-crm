ALTER TABLE "account_members" ADD COLUMN "title" varchar(120);--> statement-breakpoint
ALTER TABLE "account_members" ADD COLUMN "department" varchar(120);--> statement-breakpoint
ALTER TABLE "account_members" ADD COLUMN "phone" varchar(32);--> statement-breakpoint
ALTER TABLE "ai_connections" ADD COLUMN "price_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Fix: job title, department and phone are per account now — every membership starts with the person's
-- current values (users.* keep theirs as a backup; nothing reads them any more).
UPDATE "account_members" AS am
SET "title" = u."title", "department" = u."department", "phone" = u."phone"
FROM "users" AS u
WHERE u."id" = am."user_id"
  AND (u."title" IS NOT NULL OR u."department" IS NOT NULL OR u."phone" IS NOT NULL);
