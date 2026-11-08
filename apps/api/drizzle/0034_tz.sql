-- A member who never chose a timezone follows the account's (`account_settings.settings.locale.timezone`, A3):
-- users.timezone becomes nullable without a default (null = "לפי החשבון").
ALTER TABLE "users" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "timezone" DROP NOT NULL;--> statement-breakpoint
-- Existing users on the old default ('Asia/Jerusalem') never chose it unless their profile was saved with a
-- timezone change: PATCH /users/me records `user.profile_updated` with only the changed fields in `payload.after`
-- (users.service `updateMyProfile`). Such a user keeps the zone; everyone else on the default moves to null.
-- Any other zone was chosen explicitly (nothing else ever wrote one) and is kept.
UPDATE "users" u SET "timezone" = NULL
WHERE u."timezone" = 'Asia/Jerusalem'
  AND NOT EXISTS (
    SELECT 1 FROM "activity_log" e
    WHERE e."actor_id" = u."id" AND e."type" = 'user.profile_updated'
      AND e."payload" -> 'after' -> 'timezone' IS NOT NULL
  );
