CREATE TABLE "license_payment_events" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"provider" varchar(40) NOT NULL,
	"event_id" varchar(200) NOT NULL,
	"type" varchar(80) NOT NULL,
	"license_id" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_reminders" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"license_id" varchar(26) NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"days" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issued_licenses" ADD COLUMN "payment_provider" varchar(40);--> statement-breakpoint
ALTER TABLE "issued_licenses" ADD COLUMN "payment_customer_id" varchar(120);--> statement-breakpoint
ALTER TABLE "issued_licenses" ADD COLUMN "payment_subscription_id" varchar(120);--> statement-breakpoint
ALTER TABLE "license_payment_events" ADD CONSTRAINT "license_payment_events_license_id_issued_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."issued_licenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_reminders" ADD CONSTRAINT "license_reminders_license_id_issued_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."issued_licenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_license_payment_events" ON "license_payment_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_license_reminders" ON "license_reminders" USING btree ("license_id","expires","days");--> statement-breakpoint
CREATE INDEX "ix_issued_licenses_subscription" ON "issued_licenses" USING btree ("payment_provider","payment_subscription_id");