-- r18boardviews: who opened a board and how long ago (one row per board + person).
CREATE TABLE "board_viewers" (
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"device" varchar(8) NOT NULL,
	"user_agent" varchar(64) DEFAULT '' NOT NULL,
	"view_count" integer DEFAULT 1 NOT NULL,
	"first_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_viewers_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "board_viewers" ADD CONSTRAINT "board_viewers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_viewers" ADD CONSTRAINT "board_viewers_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_viewers" ADD CONSTRAINT "board_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_board_viewers_board_last" ON "board_viewers" USING btree ("board_id","last_viewed_at");--> statement-breakpoint
CREATE INDEX "ix_board_viewers_account_user" ON "board_viewers" USING btree ("account_id","user_id");