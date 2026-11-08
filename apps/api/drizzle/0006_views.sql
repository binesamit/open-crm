CREATE TYPE "public"."view_visibility" AS ENUM('shared', 'private');--> statement-breakpoint
CREATE TABLE "user_board_prefs" (
	"user_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"last_view_id" varchar(26),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_board_prefs_user_id_board_id_pk" PRIMARY KEY("user_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "user_view_prefs" (
	"user_id" varchar(26) NOT NULL,
	"view_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_view_prefs_user_id_view_id_pk" PRIMARY KEY("user_id","view_id")
);
--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "visibility" "view_visibility" DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_board_prefs" ADD CONSTRAINT "user_board_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_board_prefs" ADD CONSTRAINT "user_board_prefs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_board_prefs" ADD CONSTRAINT "user_board_prefs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_board_prefs" ADD CONSTRAINT "user_board_prefs_last_view_id_views_id_fk" FOREIGN KEY ("last_view_id") REFERENCES "public"."views"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_view_prefs" ADD CONSTRAINT "user_view_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_view_prefs" ADD CONSTRAINT "user_view_prefs_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_view_prefs" ADD CONSTRAINT "user_view_prefs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_views_system" ON "views" USING btree ("board_id") WHERE "views"."is_system" = true and "views"."deleted_at" is null;