CREATE TABLE "inbound_addresses" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"item_id" varchar(26),
	"board_id" varchar(26),
	"token" varchar(32) NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inbound_emails" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"address_id" varchar(26) NOT NULL,
	"provider_email_id" varchar(100) NOT NULL,
	"message_id" varchar(255),
	"from_email" varchar(320) DEFAULT '' NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"reason" varchar(40),
	"item_id" varchar(26),
	"update_id" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "inbound_addresses" ADD CONSTRAINT "inbound_addresses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_addresses" ADD CONSTRAINT "inbound_addresses_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_addresses" ADD CONSTRAINT "inbound_addresses_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_addresses" ADD CONSTRAINT "inbound_addresses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_address_id_inbound_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."inbound_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_inbound_addresses_token" ON "inbound_addresses" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_inbound_addresses_item" ON "inbound_addresses" USING btree ("item_id") WHERE "inbound_addresses"."kind" = 'item' and "inbound_addresses"."disabled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_inbound_addresses_board" ON "inbound_addresses" USING btree ("board_id") WHERE "inbound_addresses"."kind" = 'board' and "inbound_addresses"."disabled_at" is null;--> statement-breakpoint
CREATE INDEX "ix_inbound_addresses_account" ON "inbound_addresses" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_inbound_emails_provider" ON "inbound_emails" USING btree ("address_id","provider_email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_inbound_emails_message" ON "inbound_emails" USING btree ("address_id","message_id") WHERE "inbound_emails"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_inbound_emails_address_created" ON "inbound_emails" USING btree ("address_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_inbound_emails_account_created" ON "inbound_emails" USING btree ("account_id","created_at" DESC NULLS LAST);