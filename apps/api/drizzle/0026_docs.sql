CREATE TYPE "public"."doc_host" AS ENUM('workspace', 'cell');--> statement-breakpoint
CREATE TYPE "public"."doc_member_level" AS ENUM('owner', 'editor', 'commenter', 'viewer');--> statement-breakpoint
ALTER TYPE "public"."trash_object_type" ADD VALUE 'doc';--> statement-breakpoint
CREATE TABLE "doc_assets" (
	"doc_id" varchar(26) NOT NULL,
	"asset_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_assets_doc_id_asset_id_pk" PRIMARY KEY("doc_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "doc_members" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"doc_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26),
	"team_id" varchar(26),
	"level" "doc_member_level" DEFAULT 'editor' NOT NULL,
	"added_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"workspace_id" varchar(26) NOT NULL,
	"folder_id" varchar(26),
	"position" text NOT NULL,
	"kind" "board_kind" DEFAULT 'main' NOT NULL,
	"host" "doc_host" DEFAULT 'workspace' NOT NULL,
	"board_id" varchar(26),
	"item_id" varchar(26),
	"column_id" varchar(26),
	"name" varchar(255) NOT NULL,
	"icon" varchar(16),
	"cover_asset_id" varchar(26),
	"ydoc" "bytea",
	"content" jsonb,
	"text_value" text DEFAULT '' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(26),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"source_doc_id" bigint
);
--> statement-breakpoint
ALTER TABLE "doc_assets" ADD CONSTRAINT "doc_assets_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_assets" ADD CONSTRAINT "doc_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_assets" ADD CONSTRAINT "doc_assets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_cover_asset_id_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_doc_assets_asset" ON "doc_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_doc_members_user" ON "doc_members" USING btree ("doc_id","user_id") WHERE "doc_members"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_doc_members_team" ON "doc_members" USING btree ("doc_id","team_id") WHERE "doc_members"."team_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_doc_members_user" ON "doc_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_doc_members_team" ON "doc_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "ix_docs_workspace_folder" ON "docs" USING btree ("workspace_id","folder_id","position") WHERE "docs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_docs_account" ON "docs" USING btree ("account_id") WHERE "docs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_docs_name_trgm" ON "docs" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_docs_text_trgm" ON "docs" USING gin ("text_value" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_docs_source" ON "docs" USING btree ("account_id","source_doc_id") WHERE "docs"."source_doc_id" is not null;--> statement-breakpoint
-- A cell doc (ד2) names its cell; a sidebar doc does not need to.
ALTER TABLE "docs" ADD CONSTRAINT "ck_docs_host" CHECK ("host" = 'workspace' OR ("board_id" IS NOT NULL AND "item_id" IS NOT NULL AND "column_id" IS NOT NULL));--> statement-breakpoint
-- A member is a person or a team, never both.
ALTER TABLE "doc_members" ADD CONSTRAINT "ck_doc_members_subject" CHECK (("user_id" IS NULL) <> ("team_id" IS NULL));
