CREATE TABLE "security_incidents" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"severity" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"personal_data" boolean DEFAULT false NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"people_affected" integer,
	"data_categories" text DEFAULT '' NOT NULL,
	"measures" text DEFAULT '' NOT NULL,
	"authority_notified_at" timestamp with time zone,
	"authority_reference" varchar(120),
	"subjects_notified_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_security_incidents_detected" ON "security_incidents" USING btree ("detected_at" DESC NULLS LAST);