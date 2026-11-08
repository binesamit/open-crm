CREATE TABLE "issued_licenses" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"ref" varchar(64) NOT NULL,
	"licensee" varchar(200) NOT NULL,
	"plan" varchar(20) NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seats" integer,
	"instance_id" varchar(64),
	"expires" timestamp with time zone,
	"grace_days" integer DEFAULT 14 NOT NULL,
	"support" varchar(20) DEFAULT 'community' NOT NULL,
	"email" varchar(320),
	"key" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" varchar(26),
	"revoked_at" timestamp with time zone,
	"revoked_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_installations" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"instance_id" varchar(64) NOT NULL,
	"company" varchar(200) DEFAULT '' NOT NULL,
	"size" varchar(10),
	"role" varchar(120) DEFAULT '' NOT NULL,
	"use_case" varchar(20),
	"email" varchar(320) NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"version" varchar(40),
	"locale" varchar(8),
	"verify_token_hash" varchar(64),
	"verify_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"poll_secret_hash" varchar(64),
	"license_id" varchar(26),
	"last_seen_at" timestamp with time zone,
	"active_users" integer,
	"boards" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issued_licenses" ADD CONSTRAINT "issued_licenses_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_licenses" ADD CONSTRAINT "issued_licenses_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_installations" ADD CONSTRAINT "license_installations_license_id_issued_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."issued_licenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_issued_licenses_ref" ON "issued_licenses" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "ix_issued_licenses_instance" ON "issued_licenses" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "ix_issued_licenses_created" ON "issued_licenses" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_license_installations_instance" ON "license_installations" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_license_installations_verify" ON "license_installations" USING btree ("verify_token_hash");--> statement-breakpoint
CREATE INDEX "ix_license_installations_created" ON "license_installations" USING btree ("created_at" DESC NULLS LAST);