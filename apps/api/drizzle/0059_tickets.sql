CREATE SEQUENCE "public"."support_ticket_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "support_access_requests" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"ticket_id" varchar(26) NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"requested_by" varchar(26) NOT NULL,
	"mode" varchar(8) DEFAULT 'view' NOT NULL,
	"duration_hours" integer NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" varchar(26),
	"decided_at" timestamp with time zone,
	"grant_id" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_canned_replies" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"queue_id" varchar(26),
	"created_by" varchar(26),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_categories" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"queue_id" varchar(26),
	"default_priority" varchar(16),
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_queues" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_sla_policies" (
	"priority" varchar(16) PRIMARY KEY NOT NULL,
	"first_response_minutes" integer NOT NULL,
	"resolution_minutes" integer NOT NULL,
	"business_hours" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_staff" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"user_id" varchar(26),
	"role" varchar(16) DEFAULT 'agent' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"invited_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tags" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"name" varchar(40) NOT NULL,
	"color" varchar(7),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_assignments" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"ticket_id" varchar(26) NOT NULL,
	"assignee_id" varchar(26),
	"assigned_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "support_ticket_attachments" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"ticket_id" varchar(26) NOT NULL,
	"message_id" varchar(26),
	"asset_id" varchar(26) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_events" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"ticket_id" varchar(26) NOT NULL,
	"actor_id" varchar(26),
	"type" varchar(48) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"ticket_id" varchar(26) NOT NULL,
	"author_id" varchar(26),
	"author_name" varchar(120) DEFAULT '' NOT NULL,
	"kind" varchar(16) NOT NULL,
	"visibility" varchar(16) DEFAULT 'public' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_tags" (
	"ticket_id" varchar(26) NOT NULL,
	"tag_id" varchar(26) NOT NULL,
	CONSTRAINT "support_ticket_tags_ticket_id_tag_id_pk" PRIMARY KEY("ticket_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"requester_id" varchar(26),
	"requester_email" varchar(320) NOT NULL,
	"requester_name" varchar(120) DEFAULT '' NOT NULL,
	"subject" varchar(200) NOT NULL,
	"status" varchar(24) DEFAULT 'new' NOT NULL,
	"priority" varchar(16) DEFAULT 'normal' NOT NULL,
	"category_id" varchar(26),
	"queue_id" varchar(26),
	"assignee_id" varchar(26),
	"context" jsonb,
	"first_response_due_at" timestamp with time zone,
	"resolution_due_at" timestamp with time zone,
	"first_responded_at" timestamp with time zone,
	"sla_paused_at" timestamp with time zone,
	"first_breach_alerted_at" timestamp with time zone,
	"resolution_breach_alerted_at" timestamp with time zone,
	"solved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"csat_rating" integer,
	"csat_comment" text,
	"csat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "ticket_id" varchar(26);--> statement-breakpoint
ALTER TABLE "support_access_requests" ADD CONSTRAINT "support_access_requests_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_requests" ADD CONSTRAINT "support_access_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_requests" ADD CONSTRAINT "support_access_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_requests" ADD CONSTRAINT "support_access_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_requests" ADD CONSTRAINT "support_access_requests_grant_id_support_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."support_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_canned_replies" ADD CONSTRAINT "support_canned_replies_queue_id_support_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."support_queues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_canned_replies" ADD CONSTRAINT "support_canned_replies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_categories" ADD CONSTRAINT "support_categories_queue_id_support_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."support_queues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_staff" ADD CONSTRAINT "support_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_staff" ADD CONSTRAINT "support_staff_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_assignments" ADD CONSTRAINT "support_ticket_assignments_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_assignments" ADD CONSTRAINT "support_ticket_assignments_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_assignments" ADD CONSTRAINT "support_ticket_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_message_id_support_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_attachments" ADD CONSTRAINT "support_ticket_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_tag_id_support_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."support_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_id_support_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."support_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_queue_id_support_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."support_queues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_support_access_requests_ticket" ON "support_access_requests" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_support_access_requests_account" ON "support_access_requests" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_support_staff_email" ON "support_staff" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "ux_support_tags_name" ON "support_tags" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "ix_support_assignments_ticket" ON "support_ticket_assignments" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_support_attachments_ticket" ON "support_ticket_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ix_support_attachments_asset" ON "support_ticket_attachments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "ix_support_events_ticket" ON "support_ticket_events" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_support_messages_ticket" ON "support_ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_support_tickets_number" ON "support_tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "ix_support_tickets_account" ON "support_tickets" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_support_tickets_status" ON "support_tickets" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "ix_support_tickets_assignee" ON "support_tickets" USING btree ("assignee_id","status");--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Sensible SLA defaults (minutes; owner console → Support → SLA changes them): urgent runs around the clock.
INSERT INTO "support_sla_policies" ("priority", "first_response_minutes", "resolution_minutes", "business_hours") VALUES ('low', 1440, 10080, true), ('normal', 480, 2880, true), ('high', 120, 1440, true), ('urgent', 30, 480, false) ON CONFLICT DO NOTHING;
