CREATE TYPE "public"."board_role" AS ENUM('editor', 'contributor', 'assigned_contributor', 'viewer');--> statement-breakpoint
ALTER TABLE "board_members" ADD COLUMN "level" "board_role";--> statement-breakpoint
ALTER TABLE "board_team_members" ADD COLUMN "level" "board_role";