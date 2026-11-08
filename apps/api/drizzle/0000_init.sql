-- Hand-edited (see src/db/schema.ts header): pg_trgm extension + activity_log partitioning.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."account_member_role" AS ENUM('admin', 'member', 'viewer', 'guest');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'automation', 'api', 'system', 'form', 'email');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('file', 'link', 'doc');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."board_kind" AS ENUM('main', 'shareable', 'private');--> statement-breakpoint
CREATE TYPE "public"."board_member_role" AS ENUM('owner', 'subscriber');--> statement-breakpoint
CREATE TYPE "public"."board_permission_set" AS ENUM('edit_everything', 'edit_content', 'edit_assigned', 'view_comment');--> statement-breakpoint
CREATE TYPE "public"."board_view_items" AS ENUM('all', 'assigned_or_created', 'by_filter');--> statement-breakpoint
CREATE TYPE "public"."group_color" AS ENUM('bright_blue', 'done_green', 'grass_green', 'bright_green', 'working_orange', 'stuck_red', 'purple', 'explosive', 'dark_blue', 'dark_purple', 'egg_yolk', 'dark_orange', 'sunset', 'dark_red', 'sofia_pink', 'aquamarine', 'navy', 'brown', 'american_gray');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('invited', 'active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'email');--> statement-breakpoint
CREATE TYPE "public"."template_kind" AS ENUM('board', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."trash_object_type" AS ENUM('workspace', 'folder', 'board', 'group', 'item', 'column', 'view', 'update', 'asset', 'automation', 'form');--> statement-breakpoint
CREATE TYPE "public"."update_source" AS ENUM('user', 'email', 'automation', 'api', 'form');--> statement-breakpoint
CREATE TYPE "public"."view_type" AS ENUM('table', 'kanban', 'calendar', 'timeline', 'gantt', 'form', 'cards', 'workload', 'chart', 'files');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."workspace_member_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "account_invitations" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"email" varchar(320) NOT NULL,
	"role" "account_member_role" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"invited_by" varchar(26),
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" varchar(26),
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "account_members" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"role" "account_member_role" DEFAULT 'member' NOT NULL,
	"status" "member_status" DEFAULT 'invited' NOT NULL,
	"client_account_item_id" varchar(26),
	"invited_by" varchar(26),
	"invited_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_settings" (
	"account_id" varchar(26) PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" varchar(26),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" varchar(120) NOT NULL,
	"logo_asset_id" varchar(26),
	"plan" varchar(32) DEFAULT 'self_hosted' NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26),
	"item_id" varchar(26),
	"column_id" varchar(26),
	"actor_id" varchar(26),
	"actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"automation_id" varchar(26),
	"type" varchar(64) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"batch_id" varchar(26),
	"request_id" varchar(64),
	"undone_at" timestamp with time zone,
	"undone_by_event_id" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_log_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
-- Catch-all partition; the worker adds monthly partitions (activity_log_yYYYYmMM) ahead of time.
CREATE TABLE "activity_log_default" PARTITION OF "activity_log" DEFAULT;
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26),
	"name" varchar(120) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"scopes" jsonb DEFAULT '["boards:read"]'::jsonb NOT NULL,
	"board_ids" jsonb,
	"rate_limit_per_minute" integer DEFAULT 600 NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" varchar(26),
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"owner_id" varchar(26),
	"kind" "asset_kind" DEFAULT 'file' NOT NULL,
	"storage_key" text,
	"external_url" text,
	"file_name" varchar(255) NOT NULL,
	"mime" varchar(127) DEFAULT 'application/octet-stream' NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" varchar(64),
	"parent_asset_id" varchar(26),
	"version" integer DEFAULT 1 NOT NULL,
	"upload_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"actor_id" varchar(26),
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32),
	"target_id" varchar(26),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"provider_id" varchar(32) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"automation_id" varchar(26) NOT NULL,
	"event_id" varchar(26),
	"item_id" varchar(26),
	"status" "automation_run_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"actions_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26),
	"title" varchar(255) NOT NULL,
	"recipe" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"owner_id" varchar(26),
	"created_from_template_id" varchar(26),
	"seed_key" varchar(32),
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"created_by" varchar(26),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "board_members" (
	"board_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"role" "board_member_role" DEFAULT 'subscriber' NOT NULL,
	"added_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_members_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "board_team_members" (
	"board_id" varchar(26) NOT NULL,
	"team_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"role" "board_member_role" DEFAULT 'subscriber' NOT NULL,
	"added_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_team_members_board_id_team_id_pk" PRIMARY KEY("board_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"workspace_id" varchar(26) NOT NULL,
	"folder_id" varchar(26),
	"name" varchar(255) NOT NULL,
	"description" text,
	"kind" "board_kind" DEFAULT 'main' NOT NULL,
	"position" text NOT NULL,
	"item_terminology" varchar(40) DEFAULT 'item' NOT NULL,
	"hierarchy_depth_max" integer DEFAULT 5 NOT NULL,
	"permission_set" "board_permission_set" DEFAULT 'edit_everything' NOT NULL,
	"view_items" "board_view_items" DEFAULT 'all' NOT NULL,
	"view_items_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignee_column_id" varchar(26),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_from_template_id" varchar(26),
	"source_board_id" bigint,
	"created_by" varchar(26),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cell_files" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"asset_id" varchar(26) NOT NULL,
	"position" text NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cells" (
	"item_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"value" jsonb NOT NULL,
	"text_value" text,
	"number_value" double precision,
	"date_value" timestamp with time zone,
	"date_end_value" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(26),
	"updated_by_type" "actor_type" DEFAULT 'user' NOT NULL,
	CONSTRAINT "cells_item_id_column_id_pk" PRIMARY KEY("item_id","column_id")
);
--> statement-breakpoint
CREATE TABLE "columns" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"key" varchar(50) NOT NULL,
	"type" varchar(32) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" text NOT NULL,
	"width" integer DEFAULT 140 NOT NULL,
	"restricted_edit" jsonb,
	"restricted_view" jsonb,
	"rollup_function" varchar(16),
	"is_required" boolean DEFAULT false NOT NULL,
	"source_column_id" varchar(64),
	"created_by" varchar(26),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"workspace_id" varchar(26) NOT NULL,
	"parent_folder_id" varchar(26),
	"depth" integer DEFAULT 0 NOT NULL,
	"name" varchar(120) NOT NULL,
	"color" varchar(32),
	"position" text NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"form_id" varchar(26) NOT NULL,
	"item_id" varchar(26),
	"submitted_by" varchar(26),
	"submitter_email" varchar(320),
	"ip" varchar(45),
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"view_id" varchar(26) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"password_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"require_login" boolean DEFAULT false NOT NULL,
	"target_group_id" varchar(26),
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(26),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"title" varchar(255) NOT NULL,
	"color" "group_color" DEFAULT 'bright_blue' NOT NULL,
	"position" text NOT NULL,
	"source_group_id" varchar(64),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" varchar(128) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"principal_id" varchar(26) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_account_id_principal_id_key_pk" PRIMARY KEY("account_id","principal_id","key")
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"source" varchar(16) DEFAULT 'file' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_by" varchar(26),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_keys" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"padding" integer DEFAULT 3 NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_links" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"from_item_id" varchar(26) NOT NULL,
	"to_item_id" varchar(26) NOT NULL,
	"position" text NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_tags" (
	"item_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"tag_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"position" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_tags_item_id_column_id_tag_id_pk" PRIMARY KEY("item_id","column_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"group_id" varchar(26),
	"parent_item_id" varchar(26),
	"root_item_id" varchar(26),
	"depth" integer DEFAULT 0 NOT NULL,
	"position" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_seq" integer,
	"created_by" varchar(26),
	"creator_type" "actor_type" DEFAULT 'user' NOT NULL,
	"last_cell_change_at" timestamp with time zone,
	"last_cell_change_by" varchar(26),
	"child_count" integer DEFAULT 0 NOT NULL,
	"source_item_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"type" varchar(48) DEFAULT '*' NOT NULL,
	"board_id" varchar(26),
	"enabled" boolean DEFAULT true NOT NULL,
	"digest" varchar(16) DEFAULT 'instant' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"type" varchar(48) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"board_id" varchar(26),
	"item_id" varchar(26),
	"update_id" varchar(26),
	"actor_id" varchar(26),
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_access_grants" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"granted_by" varchar(26) NOT NULL,
	"granted_to_user_id" varchar(26),
	"scope" varchar(16) DEFAULT 'read_write' NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26),
	"name" varchar(60) NOT NULL,
	"color" varchar(32) DEFAULT 'bright_blue' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"color" varchar(32),
	"parent_team_id" varchar(26),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26),
	"kind" "template_kind" DEFAULT 'board' NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(48),
	"snapshot" jsonb NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"source_board_id" varchar(26),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "time_tracking_sessions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"started_by" varchar(26),
	"ended_by" varchar(26),
	"manually_entered" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trash_entries" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"object_type" "trash_object_type" NOT NULL,
	"object_id" varchar(26) NOT NULL,
	"object_name" varchar(255) NOT NULL,
	"board_id" varchar(26),
	"parent_entry_id" varchar(26),
	"deleted_by" varchar(26),
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"restore_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"restored_at" timestamp with time zone,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "update_files" (
	"update_id" varchar(26) NOT NULL,
	"asset_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"position" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_files_update_id_asset_id_pk" PRIMARY KEY("update_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "update_likes" (
	"update_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"reaction" varchar(16) DEFAULT 'like' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_likes_update_id_user_id_pk" PRIMARY KEY("update_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "update_mentions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"update_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26),
	"team_id" varchar(26),
	"mention_everyone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "updates" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"parent_update_id" varchar(26),
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"source" "update_source" DEFAULT 'user' NOT NULL,
	"status_column_id" varchar(26),
	"status_label_id" integer,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"email_message_id" varchar(255),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_profile_settings" (
	"user_id" varchar(26) PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" varchar(120) NOT NULL,
	"image" text,
	"avatar_asset_id" varchar(26),
	"title" varchar(120),
	"phone" varchar(32),
	"locale" varchar(8) DEFAULT 'he' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Jerusalem' NOT NULL,
	"is_platform_owner" boolean DEFAULT false NOT NULL,
	"is_support_staff" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"type" "view_type" DEFAULT 'table' NOT NULL,
	"name" varchar(120) NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" text NOT NULL,
	"created_by" varchar(26),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"webhook_id" varchar(26) NOT NULL,
	"event_id" varchar(26) NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"request_body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_status" integer,
	"response_body" text,
	"error" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26),
	"url" text NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret" varchar(128) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"challenge_verified_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"workspace_id" varchar(26) NOT NULL,
	"user_id" varchar(26),
	"team_id" varchar(26),
	"role" "workspace_member_role" DEFAULT 'member' NOT NULL,
	"added_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"kind" "workspace_kind" DEFAULT 'open' NOT NULL,
	"icon" varchar(64),
	"color" varchar(32),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" text NOT NULL,
	"created_by" varchar(26),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_client_account_item_id_items_id_fk" FOREIGN KEY ("client_account_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_logo_asset_id_assets_id_fk" FOREIGN KEY ("logo_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_parent_asset_id_assets_id_fk" FOREIGN KEY ("parent_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_from_template_id_templates_id_fk" FOREIGN KEY ("created_from_template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_team_members" ADD CONSTRAINT "board_team_members_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_team_members" ADD CONSTRAINT "board_team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_team_members" ADD CONSTRAINT "board_team_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_team_members" ADD CONSTRAINT "board_team_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_assignee_column_id_columns_id_fk" FOREIGN KEY ("assignee_column_id") REFERENCES "public"."columns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_from_template_id_templates_id_fk" FOREIGN KEY ("created_from_template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_files" ADD CONSTRAINT "cell_files_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_files" ADD CONSTRAINT "cell_files_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_files" ADD CONSTRAINT "cell_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell_files" ADD CONSTRAINT "fk_cell_files_cell" FOREIGN KEY ("item_id","column_id") REFERENCES "public"."cells"("item_id","column_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cells" ADD CONSTRAINT "cells_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_folder_id_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_target_group_id_groups_id_fk" FOREIGN KEY ("target_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_keys" ADD CONSTRAINT "item_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_keys" ADD CONSTRAINT "item_keys_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_keys" ADD CONSTRAINT "item_keys_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_links" ADD CONSTRAINT "item_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_links" ADD CONSTRAINT "item_links_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_links" ADD CONSTRAINT "item_links_from_item_id_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_links" ADD CONSTRAINT "item_links_to_item_id_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_links" ADD CONSTRAINT "item_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_parent_item_id_items_id_fk" FOREIGN KEY ("parent_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_root_item_id_items_id_fk" FOREIGN KEY ("root_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_last_cell_change_by_users_id_fk" FOREIGN KEY ("last_cell_change_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_granted_to_user_id_users_id_fk" FOREIGN KEY ("granted_to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_parent_team_id_teams_id_fk" FOREIGN KEY ("parent_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_source_board_id_boards_id_fk" FOREIGN KEY ("source_board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_tracking_sessions" ADD CONSTRAINT "time_tracking_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_tracking_sessions" ADD CONSTRAINT "time_tracking_sessions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_tracking_sessions" ADD CONSTRAINT "time_tracking_sessions_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_tracking_sessions" ADD CONSTRAINT "time_tracking_sessions_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_tracking_sessions" ADD CONSTRAINT "time_tracking_sessions_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_entries" ADD CONSTRAINT "trash_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_entries" ADD CONSTRAINT "trash_entries_parent_entry_id_trash_entries_id_fk" FOREIGN KEY ("parent_entry_id") REFERENCES "public"."trash_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_entries" ADD CONSTRAINT "trash_entries_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_files" ADD CONSTRAINT "update_files_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_files" ADD CONSTRAINT "update_files_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_files" ADD CONSTRAINT "update_files_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_likes" ADD CONSTRAINT "update_likes_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_likes" ADD CONSTRAINT "update_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_likes" ADD CONSTRAINT "update_likes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_mentions" ADD CONSTRAINT "update_mentions_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_mentions" ADD CONSTRAINT "update_mentions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_mentions" ADD CONSTRAINT "update_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_mentions" ADD CONSTRAINT "update_mentions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_parent_update_id_updates_id_fk" FOREIGN KEY ("parent_update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_status_column_id_columns_id_fk" FOREIGN KEY ("status_column_id") REFERENCES "public"."columns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_settings" ADD CONSTRAINT "user_profile_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_asset_id_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_invitations_account_pending" ON "account_invitations" USING btree ("account_id") WHERE "account_invitations"."accepted_at" is null and "account_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "ix_invitations_email" ON "account_invitations" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "ux_account_members_account_user" ON "account_members" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_account_members_user" ON "account_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_account_members_account_role" ON "account_members" USING btree ("account_id","role") WHERE "account_members"."deactivated_at" is null;--> statement-breakpoint
CREATE INDEX "ix_al_account_created" ON "activity_log" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_al_board_created" ON "activity_log" USING btree ("board_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_al_item_created" ON "activity_log" USING btree ("item_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_al_type" ON "activity_log" USING btree ("account_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_al_batch" ON "activity_log" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_api_tokens_hash" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_api_tokens_account" ON "api_tokens" USING btree ("account_id") WHERE "api_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "ix_assets_account_created" ON "assets" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_assets_parent_version" ON "assets" USING btree ("parent_asset_id","version");--> statement-breakpoint
CREATE INDEX "ix_assets_owner" ON "assets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "ix_audit_account_created" ON "audit_log" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_audit_actor" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_auth_identities_user" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_auth_identities_provider" ON "auth_identities" USING btree ("provider_id","provider_account_id");--> statement-breakpoint
CREATE INDEX "ix_auth_sessions_user" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_verifications_identifier" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "ix_automation_runs_automation_created" ON "automation_runs" USING btree ("automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_automation_runs_status" ON "automation_runs" USING btree ("account_id","status") WHERE "automation_runs"."status" in ('pending','running');--> statement-breakpoint
CREATE UNIQUE INDEX "ux_automation_runs_event" ON "automation_runs" USING btree ("automation_id","event_id") WHERE "automation_runs"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_automations_board_active" ON "automations" USING btree ("board_id","is_active") WHERE "automations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_board_members_user" ON "board_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_boards_workspace_folder" ON "boards" USING btree ("workspace_id","folder_id","position") WHERE "boards"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_boards_account_kind" ON "boards" USING btree ("account_id","kind") WHERE "boards"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_boards_name_trgm" ON "boards" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_boards_source" ON "boards" USING btree ("account_id","source_board_id") WHERE "boards"."source_board_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_cell_files" ON "cell_files" USING btree ("item_id","column_id","asset_id");--> statement-breakpoint
CREATE INDEX "ix_cells_board" ON "cells" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "ix_cells_column_number" ON "cells" USING btree ("column_id","number_value");--> statement-breakpoint
CREATE INDEX "ix_cells_column_date" ON "cells" USING btree ("column_id","date_value");--> statement-breakpoint
CREATE INDEX "ix_cells_column_text" ON "cells" USING btree ("column_id","text_value");--> statement-breakpoint
CREATE INDEX "ix_cells_column_updated" ON "cells" USING btree ("column_id","updated_at");--> statement-breakpoint
CREATE INDEX "ix_cells_value_gin" ON "cells" USING gin ("value" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "ix_cells_text_trgm" ON "cells" USING gin ("text_value" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_columns_board_key" ON "columns" USING btree ("board_id","key");--> statement-breakpoint
CREATE INDEX "ix_columns_board_position" ON "columns" USING btree ("board_id","position") WHERE "columns"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_columns_type" ON "columns" USING btree ("account_id","type");--> statement-breakpoint
CREATE INDEX "ix_folders_workspace_parent" ON "folders" USING btree ("workspace_id","parent_folder_id","position") WHERE "folders"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_form_submissions_form_created" ON "form_submissions" USING btree ("form_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_forms_view" ON "forms" USING btree ("view_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_forms_slug" ON "forms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ix_groups_board_position" ON "groups" USING btree ("board_id","position") WHERE "groups"."deleted_at" is null and "groups"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_item_keys_account_prefix" ON "item_keys" USING btree ("account_id","prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_item_keys_column" ON "item_keys" USING btree ("column_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_item_links_col_from_to" ON "item_links" USING btree ("column_id","from_item_id","to_item_id");--> statement-breakpoint
CREATE INDEX "ix_item_links_to" ON "item_links" USING btree ("to_item_id","column_id");--> statement-breakpoint
CREATE INDEX "ix_item_links_from" ON "item_links" USING btree ("from_item_id");--> statement-breakpoint
CREATE INDEX "ix_item_tags_tag" ON "item_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "ix_items_board_group_position" ON "items" USING btree ("board_id","group_id","position") WHERE "items"."deleted_at" is null and "items"."depth" = 0;--> statement-breakpoint
CREATE INDEX "ix_items_parent_position" ON "items" USING btree ("parent_item_id","position") WHERE "items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_items_root" ON "items" USING btree ("root_item_id") WHERE "items"."root_item_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_items_board_deleted" ON "items" USING btree ("board_id","deleted_at");--> statement-breakpoint
CREATE INDEX "ix_items_name_trgm" ON "items" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_items_created_by" ON "items" USING btree ("account_id","created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_items_board_key_seq" ON "items" USING btree ("board_id","key_seq") WHERE "items"."key_seq" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_items_source" ON "items" USING btree ("account_id","source_item_id") WHERE "items"."source_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_notification_settings" ON "notification_settings" USING btree ("user_id","channel","type",coalesce("board_id", ''));--> statement-breakpoint
CREATE INDEX "ix_notifications_user_unread" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "ix_notifications_user_created" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_support_grants_account_active" ON "support_access_grants" USING btree ("account_id","expires_at") WHERE "support_access_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_tags_scope_name" ON "tags" USING btree ("account_id",coalesce("board_id", ''),lower("name")) WHERE "tags"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_tags_name_trgm" ON "tags" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_team_members_user" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_teams_account_name" ON "teams" USING btree ("account_id",lower("name")) WHERE "teams"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_templates_scope_key" ON "templates" USING btree (coalesce("account_id", ''),"key") WHERE "templates"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_tts_item_column" ON "time_tracking_sessions" USING btree ("item_id","column_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_tts_running" ON "time_tracking_sessions" USING btree ("item_id","column_id") WHERE "time_tracking_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "ix_trash_account_deleted" ON "trash_entries" USING btree ("account_id","deleted_at" DESC NULLS LAST) WHERE "trash_entries"."restored_at" is null and "trash_entries"."purged_at" is null;--> statement-breakpoint
CREATE INDEX "ix_trash_purge" ON "trash_entries" USING btree ("purge_after") WHERE "trash_entries"."restored_at" is null and "trash_entries"."purged_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_trash_object" ON "trash_entries" USING btree ("object_type","object_id") WHERE "trash_entries"."restored_at" is null and "trash_entries"."purged_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_update_mentions_user" ON "update_mentions" USING btree ("update_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_update_mentions_team" ON "update_mentions" USING btree ("update_id","team_id");--> statement-breakpoint
CREATE INDEX "ix_update_mentions_user" ON "update_mentions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_updates_item_created" ON "updates" USING btree ("item_id","created_at" DESC NULLS LAST) WHERE "updates"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_updates_parent" ON "updates" USING btree ("parent_update_id");--> statement-breakpoint
CREATE INDEX "ix_updates_board_created" ON "updates" USING btree ("board_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_updates_body_trgm" ON "updates" USING gin ("body_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_updates_email_msg" ON "updates" USING btree ("account_id","email_message_id") WHERE "updates"."email_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_users_email" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "ix_views_board_position" ON "views" USING btree ("board_id","position") WHERE "views"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_views_default" ON "views" USING btree ("board_id") WHERE "views"."is_default" = true and "views"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_wd_webhook_created" ON "webhook_deliveries" USING btree ("webhook_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_wd_pending" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ix_webhooks_board_event" ON "webhooks" USING btree ("board_id","event_type") WHERE "webhooks"."is_active" = true and "webhooks"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_workspace_members_user" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_workspace_members_team" ON "workspace_members" USING btree ("workspace_id","team_id");--> statement-breakpoint
CREATE INDEX "ix_workspaces_account" ON "workspaces" USING btree ("account_id","position") WHERE "workspaces"."deleted_at" is null;