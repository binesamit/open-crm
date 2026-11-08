CREATE TABLE "status_workflow_versions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"version" integer NOT NULL,
	"workflow" jsonb NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_workflow_versions" ADD CONSTRAINT "status_workflow_versions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_workflow_versions" ADD CONSTRAINT "status_workflow_versions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_workflow_versions" ADD CONSTRAINT "status_workflow_versions_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_workflow_versions" ADD CONSTRAINT "status_workflow_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_workflow_versions" ON "status_workflow_versions" USING btree ("column_id","version");