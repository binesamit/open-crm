-- Release D (F9). Group colour keys are ours (packages/shared/src/colors.ts LEGACY_GROUP_COLOR_KEYS). Hex values do not change.
ALTER TYPE "public"."group_color" RENAME VALUE 'bright_blue' TO 'blue';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'done_green' TO 'green';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'grass_green' TO 'forest';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'bright_green' TO 'lime';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'working_orange' TO 'orange';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'stuck_red' TO 'red';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'explosive' TO 'light_gray';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'dark_blue' TO 'azure';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'dark_purple' TO 'violet';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'egg_yolk' TO 'yellow';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'dark_orange' TO 'orange_red';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'sunset' TO 'salmon';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'dark_red' TO 'crimson';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'sofia_pink' TO 'pink';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'aquamarine' TO 'turquoise';--> statement-breakpoint
ALTER TYPE "public"."group_color" RENAME VALUE 'american_gray' TO 'gray';--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "color" SET DEFAULT 'blue';--> statement-breakpoint
ALTER TABLE "tags" ALTER COLUMN "color" SET DEFAULT 'blue';--> statement-breakpoint
UPDATE "tags" t SET "color" = m.new_key FROM (VALUES ('bright_blue', 'blue'), ('done_green', 'green'), ('grass_green', 'forest'), ('bright_green', 'lime'), ('working_orange', 'orange'), ('stuck_red', 'red'), ('explosive', 'light_gray'), ('dark_blue', 'azure'), ('dark_purple', 'violet'), ('egg_yolk', 'yellow'), ('dark_orange', 'orange_red'), ('sunset', 'salmon'), ('dark_red', 'crimson'), ('sofia_pink', 'pink'), ('aquamarine', 'turquoise'), ('american_gray', 'gray')) AS m(old_key, new_key) WHERE t."color" = m.old_key;--> statement-breakpoint
UPDATE "account_settings" s SET "settings" = jsonb_set(s."settings", '{defaults,group_colors}', (SELECT coalesce(jsonb_agg(to_jsonb(coalesce(m.new_key, e.k)) ORDER BY e.ord), '[]'::jsonb) FROM jsonb_array_elements_text(s."settings"->'defaults'->'group_colors') WITH ORDINALITY AS e(k, ord) LEFT JOIN (VALUES ('bright_blue', 'blue'), ('done_green', 'green'), ('grass_green', 'forest'), ('bright_green', 'lime'), ('working_orange', 'orange'), ('stuck_red', 'red'), ('explosive', 'light_gray'), ('dark_blue', 'azure'), ('dark_purple', 'violet'), ('egg_yolk', 'yellow'), ('dark_orange', 'orange_red'), ('sunset', 'salmon'), ('dark_red', 'crimson'), ('sofia_pink', 'pink'), ('aquamarine', 'turquoise'), ('american_gray', 'gray')) AS m(old_key, new_key) ON m.old_key = e.k)) WHERE jsonb_typeof(s."settings"->'defaults'->'group_colors') = 'array';--> statement-breakpoint
SELECT 1;