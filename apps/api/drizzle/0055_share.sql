-- Sharing dashboards like boards (product fix list): an `editor` level on dashboards, dashboard notifications
-- ("shared with you"); starter kits as data (M11 stage 3): earlier versions of catalog entries.
ALTER TYPE "public"."dashboard_member_level" ADD VALUE 'editor' BEFORE 'viewer';--> statement-breakpoint
CREATE TABLE "catalog_versions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"key" varchar(48) NOT NULL,
	"version" varchar(64) NOT NULL,
	"manifest" jsonb NOT NULL,
	"note" varchar(255),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dashboard_id" varchar(26);--> statement-breakpoint
ALTER TABLE "catalog_versions" ADD CONSTRAINT "catalog_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_catalog_versions_key" ON "catalog_versions" USING btree ("key","created_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A dashboard may now be shareable (guests invited to it), like a board (hand-written: drizzle does not track checks).
ALTER TABLE "dashboards" DROP CONSTRAINT "ck_dashboards_kind";--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "ck_dashboards_kind" CHECK ("kind" IN ('main', 'private', 'shareable'));
