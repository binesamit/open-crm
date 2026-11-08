CREATE TABLE "doc_comment_threads" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"doc_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"block_id" varchar(64) NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(26),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "doc_comments" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"thread_id" varchar(26) NOT NULL,
	"doc_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"body" jsonb NOT NULL,
	"text_value" text DEFAULT '' NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"doc_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"ydoc" "bytea" NOT NULL,
	"content" jsonb,
	"text_value" text DEFAULT '' NOT NULL,
	"label" varchar(120),
	"auto" boolean DEFAULT true NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "doc_id" varchar(26);--> statement-breakpoint
ALTER TABLE "doc_comment_threads" ADD CONSTRAINT "doc_comment_threads_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comment_threads" ADD CONSTRAINT "doc_comment_threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comment_threads" ADD CONSTRAINT "doc_comment_threads_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comment_threads" ADD CONSTRAINT "doc_comment_threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_thread_id_doc_comment_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."doc_comment_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_doc_comment_threads_doc" ON "doc_comment_threads" USING btree ("doc_id","created_at") WHERE "doc_comment_threads"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_doc_comments_thread" ON "doc_comments" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_doc_versions_doc" ON "doc_versions" USING btree ("doc_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;