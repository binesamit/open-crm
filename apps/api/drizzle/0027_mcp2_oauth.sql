CREATE TABLE "mcp_connections" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"user_id" varchar(26) NOT NULL,
	"client_pk" varchar(26) NOT NULL,
	"client_name" varchar(120) NOT NULL,
	"scopes" jsonb NOT NULL,
	"board_ids" jsonb,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"client_id" varchar(512) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"client_name" varchar(120) NOT NULL,
	"client_uri" text,
	"logo_uri" text,
	"redirect_uris" jsonb NOT NULL,
	"auth_method" varchar(32) DEFAULT 'none' NOT NULL,
	"secret_hash" varchar(128),
	"fetched_at" timestamp with time zone,
	"fresh_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"client_pk" varchar(26) NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"requested_scopes" jsonb NOT NULL,
	"resource" text NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"user_id" varchar(26),
	"account_id" varchar(26),
	"scopes" jsonb,
	"board_ids" jsonb,
	"code_hash" varchar(128),
	"code_expires_at" timestamp with time zone,
	"connection_id" varchar(26),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"connection_id" varchar(26) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_client_pk_oauth_clients_id_fk" FOREIGN KEY ("client_pk") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_pk_oauth_clients_id_fk" FOREIGN KEY ("client_pk") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_mcp_connections_account" ON "mcp_connections" USING btree ("account_id","user_id") WHERE "mcp_connections"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_oauth_clients_client_id" ON "oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_oauth_grants_code" ON "oauth_grants" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "ix_oauth_grants_expires" ON "oauth_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_oauth_tokens_hash" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_oauth_tokens_connection" ON "oauth_tokens" USING btree ("connection_id");