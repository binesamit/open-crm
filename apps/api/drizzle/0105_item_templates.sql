CREATE TABLE "item_template_assets" (
	"template_id" varchar(26) NOT NULL,
	"asset_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	CONSTRAINT "item_template_assets_template_id_asset_id_pk" PRIMARY KEY("template_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "item_templates" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"name" varchar(120) NOT NULL,
	"category" varchar(60) DEFAULT '' NOT NULL,
	"description" varchar(500) DEFAULT '' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"root" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_item_id" varchar(26),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "item_template_assets" ADD CONSTRAINT "item_template_assets_template_id_item_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."item_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_template_assets" ADD CONSTRAINT "item_template_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_template_assets" ADD CONSTRAINT "item_template_assets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_templates" ADD CONSTRAINT "item_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_templates" ADD CONSTRAINT "item_templates_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_templates" ADD CONSTRAINT "item_templates_source_item_id_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_templates" ADD CONSTRAINT "item_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_item_template_assets_asset" ON "item_template_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "ix_item_templates_board" ON "item_templates" USING btree ("account_id","board_id") WHERE "item_templates"."deleted_at" is null;