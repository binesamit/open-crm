CREATE TABLE "item_followers" (
	"item_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"source" varchar(16) NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_followers_item_id_user_id_pk" PRIMARY KEY("item_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "item_followers" ADD CONSTRAINT "item_followers_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_followers" ADD CONSTRAINT "item_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_followers" ADD CONSTRAINT "item_followers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_item_followers_user" ON "item_followers" USING btree ("user_id");--> statement-breakpoint
-- Existing items: their creators and everyone who wrote an update on them follow them (D15).
INSERT INTO "item_followers" ("item_id", "user_id", "account_id", "source")
SELECT i."id", i."created_by", i."account_id", 'creator' FROM "items" i
JOIN "users" u ON u."id" = i."created_by"
WHERE i."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "item_followers" ("item_id", "user_id", "account_id", "source")
SELECT DISTINCT up."item_id", up."created_by", up."account_id", 'update' FROM "updates" up
JOIN "users" u ON u."id" = up."created_by"
JOIN "items" i ON i."id" = up."item_id" AND i."deleted_at" IS NULL
WHERE up."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
