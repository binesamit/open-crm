CREATE TABLE "help_assets" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"storage_key" varchar(200) NOT NULL,
	"content_type" varchar(40) NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"width" integer,
	"height" integer,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "help_assets" ADD CONSTRAINT "help_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_help_assets_sha256" ON "help_assets" USING btree ("sha256");