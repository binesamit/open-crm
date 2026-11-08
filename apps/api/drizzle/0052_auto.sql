-- Account automation templates ("save as template", product fix list): a recipe taken off its board with its
-- board references as slots, installed on another board by picking them again. Account-scoped, soft-deleted.
CREATE TABLE "automation_templates" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(48),
	"recipe" jsonb NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_automation_id" varchar(26),
	"pack_key" varchar(64),
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automation_templates" ADD CONSTRAINT "automation_templates_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_templates" ADD CONSTRAINT "automation_templates_source_automation_id_automations_id_fk" FOREIGN KEY ("source_automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_templates" ADD CONSTRAINT "automation_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_automation_templates_account" ON "automation_templates" USING btree ("account_id") WHERE "automation_templates"."deleted_at" is null;
