-- Owner guides: the platform owner's private Markdown pages (owner console → Guides).
-- Numbered 0082 (not 0077) so parallel branches may take 0077–0081 without colliding.
CREATE TABLE "owner_guides" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"title" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "owner_guides" ADD CONSTRAINT "owner_guides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_owner_guides_order" ON "owner_guides" USING btree ("sort_order");