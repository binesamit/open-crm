-- pal40: a group / tag may take any of the 40 palette colours, so every palette key is a
-- `group_color` value (the vivid gold / sage / slate / plum and the 24 deep, soft and neutral ones).
-- Values are only added; nothing is rewritten.
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'gold';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'sage';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'slate';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'plum';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'rust';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'amber_deep';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'olive_deep';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'moss';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'emerald_deep';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'teal_deep';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'ocean';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'midnight';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'grape';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'magenta_deep';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'wine';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'maroon';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'rose';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'peach';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'apricot';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'sky_soft';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'iris';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'lilac';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'orchid';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'blush';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'taupe';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'stone';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'graphite';--> statement-breakpoint
ALTER TYPE "public"."group_color" ADD VALUE IF NOT EXISTS 'steel';
