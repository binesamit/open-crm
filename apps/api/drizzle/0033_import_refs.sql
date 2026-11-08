-- IF NOT EXISTS: the W3 rehearsal created this table by hand on the local DB (before W2's 0032 had run there).
CREATE TABLE IF NOT EXISTS "import_refs" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"source" varchar(32) NOT NULL,
	"external_id" varchar(191) NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" varchar(26) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_refs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_import_refs_external" ON "import_refs" USING btree ("account_id","source","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_import_refs_entity" ON "import_refs" USING btree ("account_id","entity_type","entity_id");
