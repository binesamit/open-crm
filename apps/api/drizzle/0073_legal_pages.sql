CREATE TABLE "legal_consents" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"document_id" varchar(26) NOT NULL,
	"version" integer NOT NULL,
	"context" varchar(16) NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_document_versions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"document_id" varchar(26) NOT NULL,
	"version" integer NOT NULL,
	"texts" jsonb NOT NULL,
	"published_by" varchar(26),
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"slug" varchar(60) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"requires_consent" boolean DEFAULT false NOT NULL,
	"draft" jsonb NOT NULL,
	"published_version" integer,
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_consents" ADD CONSTRAINT "legal_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_consents" ADD CONSTRAINT "legal_consents_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_legal_consents" ON "legal_consents" USING btree ("user_id","document_id","version");--> statement-breakpoint
CREATE INDEX "ix_legal_consents_doc" ON "legal_consents" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_legal_document_versions" ON "legal_document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_legal_documents_slug" ON "legal_documents" USING btree ("slug");