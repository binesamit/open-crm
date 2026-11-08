-- the count an extension shows beside its sidebar page (`app_page`) — the account's (no user) or one
-- member's. Gone with the installation, the account or the member.
CREATE TABLE "extension_app_page_badges" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"installation_id" varchar(26) NOT NULL,
	"feature" varchar(40) NOT NULL,
	"user_id" varchar(26),
	"count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_app_page_badges" ADD CONSTRAINT "extension_app_page_badges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_app_page_badges" ADD CONSTRAINT "extension_app_page_badges_installation_id_extension_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."extension_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_app_page_badges" ADD CONSTRAINT "extension_app_page_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_extension_app_page_badges" ON "extension_app_page_badges" USING btree ("installation_id","feature",coalesce("user_id", ''));--> statement-breakpoint
CREATE INDEX "ix_extension_app_page_badges_account" ON "extension_app_page_badges" USING btree ("account_id");