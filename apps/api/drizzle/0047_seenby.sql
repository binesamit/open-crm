CREATE TABLE "update_views" (
	"account_id" varchar(26) NOT NULL,
	"update_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"device" varchar(8) NOT NULL,
	"user_agent" varchar(64) DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_views_update_id_user_id_device_pk" PRIMARY KEY("update_id","user_id","device")
);
--> statement-breakpoint
ALTER TABLE "update_views" ADD CONSTRAINT "update_views_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_views" ADD CONSTRAINT "update_views_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_views" ADD CONSTRAINT "update_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_update_views_account_user" ON "update_views" USING btree ("account_id","user_id");