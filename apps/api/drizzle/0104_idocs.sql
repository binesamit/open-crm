ALTER TYPE "public"."actor_type" ADD VALUE IF NOT EXISTS 'document';--> statement-breakpoint
ALTER TYPE "public"."update_source" ADD VALUE IF NOT EXISTS 'document';--> statement-breakpoint
CREATE TABLE "idoc_docs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"template_id" varchar(26),
	"name" varchar(200) NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"token" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_to" varchar(320),
	"first_viewed_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"signed_at" timestamp with time zone,
	"signature_id" varchar(26),
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"otp" jsonb,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idoc_events" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"doc_id" varchar(26) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"user_id" varchar(26),
	"who" varchar(200),
	"detail" varchar(500) DEFAULT '' NOT NULL,
	"data" jsonb,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idoc_signatures" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"doc_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"version" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"evidence" jsonb NOT NULL,
	"drawing" text,
	"snapshot" jsonb NOT NULL,
	"file_asset_id" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idoc_templates" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26),
	"name" varchar(120) NOT NULL,
	"description" varchar(500) DEFAULT '' NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idoc_docs" ADD CONSTRAINT "idoc_docs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_docs" ADD CONSTRAINT "idoc_docs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_docs" ADD CONSTRAINT "idoc_docs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_docs" ADD CONSTRAINT "idoc_docs_template_id_idoc_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."idoc_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_docs" ADD CONSTRAINT "idoc_docs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_events" ADD CONSTRAINT "idoc_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_events" ADD CONSTRAINT "idoc_events_doc_id_idoc_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."idoc_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_events" ADD CONSTRAINT "idoc_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_signatures" ADD CONSTRAINT "idoc_signatures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_signatures" ADD CONSTRAINT "idoc_signatures_doc_id_idoc_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."idoc_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_signatures" ADD CONSTRAINT "idoc_signatures_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_templates" ADD CONSTRAINT "idoc_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_templates" ADD CONSTRAINT "idoc_templates_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idoc_templates" ADD CONSTRAINT "idoc_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_idoc_docs_token" ON "idoc_docs" USING btree ("token");--> statement-breakpoint
CREATE INDEX "ix_idoc_docs_item" ON "idoc_docs" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "ix_idoc_docs_account_status" ON "idoc_docs" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "ix_idoc_events_doc" ON "idoc_events" USING btree ("doc_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_idoc_signatures_doc" ON "idoc_signatures" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "ix_idoc_templates_account" ON "idoc_templates" USING btree ("account_id","board_id");