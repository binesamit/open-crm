CREATE TYPE "public"."time_entry_source" AS ENUM('timer', 'manual', 'automation', 'import');--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"item_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"user_id" varchar(26),
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_s" integer GENERATED ALWAYS AS ((extract(epoch from (ended_at - started_at)))::int) STORED,
	"source" time_entry_source DEFAULT 'timer' NOT NULL,
	"note" text,
	"billable" boolean DEFAULT true NOT NULL,
	"edited_by" varchar(26),
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_time_entries_item" ON "time_entries" USING btree ("item_id","column_id","started_at");--> statement-breakpoint
CREATE INDEX "ix_time_entries_board_started" ON "time_entries" USING btree ("board_id","started_at");--> statement-breakpoint
CREATE INDEX "ix_time_entries_user_started" ON "time_entries" USING btree ("account_id","user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_time_entries_running" ON "time_entries" USING btree ("account_id","user_id") WHERE "time_entries"."ended_at" is null and "time_entries"."deleted_at" is null;