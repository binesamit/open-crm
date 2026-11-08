-- Knowledge center: platform-level help articles, their versions, the searchable passages of the
-- published ones (Hebrew-aware FTS like knowledge_chunks, title weighted A) and the readers' events (metrics).
CREATE TABLE "help_article_versions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"article_id" varchar(26) NOT NULL,
	"version" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"title" varchar(200) NOT NULL,
	"content" jsonb NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_articles" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"group_id" varchar(26) NOT NULL,
	"locale" varchar(2) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"title" varchar(200) NOT NULL,
	"excerpt" varchar(300) DEFAULT '' NOT NULL,
	"category_id" varchar(26),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"visibility" varchar(16) DEFAULT 'signed_in' NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_title" varchar(200),
	"published_content" jsonb,
	"published_text" text,
	"published_version" integer,
	"published_at" timestamp with time zone,
	"published_by" varchar(26),
	"source_ticket_id" varchar(26),
	"helpful_yes" integer DEFAULT 0 NOT NULL,
	"helpful_no" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(26),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "help_categories" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"name_en" varchar(80),
	"icon" varchar(40),
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_chunks" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"article_id" varchar(26) NOT NULL,
	"ord" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', title || ' ' || regexp_replace(title, '(^|[^א-ת])[והבלמשכ]([א-ת]{2,})', '\1\2', 'g')), 'A') || setweight(to_tsvector('simple', body || ' ' || regexp_replace(body, '(^|[^א-ת])[והבלמשכ]([א-ת]{2,})', '\1\2', 'g')), 'B')) STORED
);
--> statement-breakpoint
CREATE TABLE "help_events" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"kind" varchar(24) NOT NULL,
	"account_id" varchar(26),
	"user_id" varchar(26),
	"article_id" varchar(26),
	"query" varchar(200),
	"locale" varchar(2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "help_article_versions" ADD CONSTRAINT "help_article_versions_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_article_versions" ADD CONSTRAINT "help_article_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_category_id_help_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."help_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_source_ticket_id_support_tickets_id_fk" FOREIGN KEY ("source_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_chunks" ADD CONSTRAINT "help_chunks_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_events" ADD CONSTRAINT "help_events_article_id_help_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."help_articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_help_article_versions_article" ON "help_article_versions" USING btree ("article_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_help_articles_slug" ON "help_articles" USING btree ("locale","slug") WHERE "help_articles"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_help_articles_group" ON "help_articles" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "ix_help_articles_status" ON "help_articles" USING btree ("status","locale");--> statement-breakpoint
CREATE INDEX "ix_help_chunks_article" ON "help_chunks" USING btree ("article_id","ord");--> statement-breakpoint
CREATE INDEX "ix_help_chunks_tsv" ON "help_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "ix_help_events_kind" ON "help_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "ix_help_events_article" ON "help_events" USING btree ("article_id");