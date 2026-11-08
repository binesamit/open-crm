-- Extensions ("תוספות", D27): the catalog / private manifests, installations with the admin consent, and the
-- platform owner kill switch. A board view of an extension is a view of type `extension`.
ALTER TYPE "public"."view_type" ADD VALUE IF NOT EXISTS 'extension';--> statement-breakpoint
CREATE TABLE "extension_installations" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"extension_id" varchar(26) NOT NULL,
	"key" varchar(48) NOT NULL,
	"version" varchar(64) NOT NULL,
	"manifest" jsonb NOT NULL,
	"source" varchar(12) NOT NULL,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"board_ids" jsonb,
	"allow_guests" boolean DEFAULT false NOT NULL,
	"status" varchar(12) DEFAULT 'enabled' NOT NULL,
	"pending_manifest" jsonb,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consented_by" varchar(26),
	"consented_at" timestamp with time zone,
	"installed_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extension_kills" (
	"key" varchar(48) PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"killed_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extensions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26),
	"key" varchar(48) NOT NULL,
	"name" varchar(120) NOT NULL,
	"version" varchar(64) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"manifest" jsonb NOT NULL,
	"source_url" text,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_extension_id_extensions_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_consented_by_users_id_fk" FOREIGN KEY ("consented_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_kills" ADD CONSTRAINT "extension_kills_killed_by_users_id_fk" FOREIGN KEY ("killed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_extension_installations_key" ON "extension_installations" USING btree ("account_id","key");--> statement-breakpoint
CREATE INDEX "ix_extension_installations_extension" ON "extension_installations" USING btree ("extension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_extensions_scope_key" ON "extensions" USING btree (coalesce("account_id", ''),"key") WHERE "extensions"."deleted_at" is null;