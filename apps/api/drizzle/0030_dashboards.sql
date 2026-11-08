CREATE TYPE "public"."dashboard_member_level" AS ENUM('owner', 'viewer');--> statement-breakpoint
ALTER TYPE "public"."trash_object_type" ADD VALUE 'dashboard';--> statement-breakpoint
CREATE TABLE "dashboard_members" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"dashboard_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26),
	"team_id" varchar(26),
	"level" "dashboard_member_level" DEFAULT 'viewer' NOT NULL,
	"added_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_widgets" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"dashboard_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"type" varchar(40) NOT NULL,
	"title" varchar(255) DEFAULT '' NOT NULL,
	"position" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(26),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"workspace_id" varchar(26) NOT NULL,
	"folder_id" varchar(26),
	"position" text NOT NULL,
	"kind" "board_kind" DEFAULT 'main' NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" varchar(16),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(26),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dashboard_members" ADD CONSTRAINT "dashboard_members_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_members" ADD CONSTRAINT "dashboard_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_members" ADD CONSTRAINT "dashboard_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_members" ADD CONSTRAINT "dashboard_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_members" ADD CONSTRAINT "dashboard_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_dashboard_members_user" ON "dashboard_members" USING btree ("dashboard_id","user_id") WHERE "dashboard_members"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_dashboard_members_team" ON "dashboard_members" USING btree ("dashboard_id","team_id") WHERE "dashboard_members"."team_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_dashboard_members_user" ON "dashboard_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_dashboard_members_team" ON "dashboard_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "ix_dashboard_widgets_dashboard" ON "dashboard_widgets" USING btree ("dashboard_id") WHERE "dashboard_widgets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_dashboards_workspace_folder" ON "dashboards" USING btree ("workspace_id","folder_id","position") WHERE "dashboards"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_dashboards_account" ON "dashboards" USING btree ("account_id") WHERE "dashboards"."deleted_at" is null;--> statement-breakpoint
-- A member is a person or a team, never both; a dashboard is main or private (no guests yet — D25).
ALTER TABLE "dashboard_members" ADD CONSTRAINT "ck_dashboard_members_subject" CHECK (("user_id" IS NULL) <> ("team_id" IS NULL));--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "ck_dashboards_kind" CHECK ("kind" IN ('main', 'private'));