-- Extensions ת6–ת7 + outbound MCP (מ10): version history, extension server tokens and credentials, the catalog
-- review, and the external MCP servers an account registers.
CREATE TABLE "extension_server_tokens" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"installation_id" varchar(26) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_versions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"installation_id" varchar(26) NOT NULL,
	"version" varchar(64) NOT NULL,
	"manifest" jsonb NOT NULL,
	"via" varchar(12) NOT NULL,
	"applied_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"key" varchar(16) NOT NULL,
	"name" varchar(120) NOT NULL,
	"url" text NOT NULL,
	"auth_kind" varchar(16) DEFAULT 'none' NOT NULL,
	"secret_enc" text,
	"secret_hint" varchar(12),
	"oauth" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(12) DEFAULT 'unknown' NOT NULL,
	"last_error" varchar(300),
	"refreshed_at" timestamp with time zone,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"max_calls_per_hour" integer DEFAULT 120 NOT NULL,
	"created_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "version_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "auto_update" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "check_error" varchar(120);--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "service_user_id" varchar(26);--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "server_client_id" varchar(64);--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "server_secret_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "server_status" varchar(12);--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "server_error" varchar(200);--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "server_event" varchar(16);--> statement-breakpoint
ALTER TABLE "extension_installations" ADD COLUMN "server_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "published_by" varchar(26);--> statement-breakpoint
ALTER TABLE "extensions" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_server_tokens" ADD CONSTRAINT "extension_server_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_server_tokens" ADD CONSTRAINT "extension_server_tokens_installation_id_extension_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."extension_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_versions" ADD CONSTRAINT "extension_versions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_versions" ADD CONSTRAINT "extension_versions_installation_id_extension_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."extension_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_versions" ADD CONSTRAINT "extension_versions_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_extension_server_tokens_hash" ON "extension_server_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_extension_server_tokens_installation" ON "extension_server_tokens" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "ix_extension_versions_installation" ON "extension_versions" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_mcp_servers_key" ON "mcp_servers" USING btree ("account_id","key") WHERE "mcp_servers"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "extension_installations" ADD CONSTRAINT "extension_installations_service_user_id_users_id_fk" FOREIGN KEY ("service_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_extension_installations_client" ON "extension_installations" USING btree ("server_client_id");