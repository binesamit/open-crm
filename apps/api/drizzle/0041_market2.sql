-- Extensions ת3–ת5 ("תוספות", D27): the installation signing secret (signed automation calls and triggers) and
-- the extension own storage per installation / user.
CREATE TABLE "extension_storage" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"installation_id" varchar(26) NOT NULL,
	"user_id" varchar(26),
	"key" varchar(200) NOT NULL,
	"value" jsonb NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "signing_secret" text;--> statement-breakpoint
ALTER TABLE "extension_storage" ADD CONSTRAINT "extension_storage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_storage" ADD CONSTRAINT "extension_storage_installation_id_extension_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."extension_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_storage" ADD CONSTRAINT "extension_storage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_extension_storage_key" ON "extension_storage" USING btree ("installation_id",coalesce("user_id", ''),"key");--> statement-breakpoint
CREATE INDEX "ix_extension_storage_account" ON "extension_storage" USING btree ("account_id");