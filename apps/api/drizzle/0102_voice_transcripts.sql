ALTER TABLE "assets" ADD COLUMN "transcript" jsonb;--> statement-breakpoint
-- transcription runs on request by default. Accounts that saved the voice settings stored the old default
-- (auto = true, a day after the feature went live) — they move to on request too; anyone may switch it back.
UPDATE "account_settings" SET "settings" = jsonb_set("settings", '{ai,voice,auto}', 'false'::jsonb) WHERE "settings" #>> '{ai,voice,auto}' = 'true';
