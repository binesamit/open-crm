-- Secret columns: each account's wrapped data key, the encrypted values (outside `cells`) and the
-- two-factor reveal grants (per person and session).
CREATE TABLE "account_secret_keys" (
	"account_id" varchar(26) PRIMARY KEY NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_reveal_grants" (
	"user_id" varchar(26) NOT NULL,
	"session_id" varchar(26) NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_reveal_grants_user_id_session_id_pk" PRIMARY KEY("user_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "secret_values" (
	"item_id" varchar(26) NOT NULL,
	"column_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"board_id" varchar(26) NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_by" varchar(26),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_values_item_id_column_id_pk" PRIMARY KEY("item_id","column_id")
);
--> statement-breakpoint
ALTER TABLE "account_secret_keys" ADD CONSTRAINT "account_secret_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_reveal_grants" ADD CONSTRAINT "secret_reveal_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_reveal_grants" ADD CONSTRAINT "secret_reveal_grants_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_column_id_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_secret_values_account" ON "secret_values" USING btree ("account_id");