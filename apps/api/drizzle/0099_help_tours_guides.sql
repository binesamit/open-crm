CREATE TABLE "help_tour_progress" (
	"user_id" varchar(26) NOT NULL,
	"tour_id" varchar(26) NOT NULL,
	"state" varchar(16) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_tour_progress_user_id_tour_id_pk" PRIMARY KEY("user_id","tour_id")
);
--> statement-breakpoint
CREATE TABLE "help_tours" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"locale" varchar(2) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"title" varchar(120) NOT NULL,
	"route" varchar(24) NOT NULL,
	"audience" varchar(16) DEFAULT 'all' NOT NULL,
	"start" varchar(16) DEFAULT 'offer' NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" varchar(26),
	"updated_by" varchar(26),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "help_article_versions" ADD COLUMN "guide" jsonb;--> statement-breakpoint
ALTER TABLE "help_articles" ADD COLUMN "kind" varchar(16) DEFAULT 'article' NOT NULL;--> statement-breakpoint
ALTER TABLE "help_articles" ADD COLUMN "guide" jsonb;--> statement-breakpoint
ALTER TABLE "help_articles" ADD COLUMN "published_guide" jsonb;--> statement-breakpoint
ALTER TABLE "help_articles" ADD COLUMN "tour_id" varchar(26);--> statement-breakpoint
ALTER TABLE "help_tour_progress" ADD CONSTRAINT "help_tour_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_tour_progress" ADD CONSTRAINT "help_tour_progress_tour_id_help_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."help_tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_tours" ADD CONSTRAINT "help_tours_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_tours" ADD CONSTRAINT "help_tours_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_help_tours_slug" ON "help_tours" USING btree ("locale","slug") WHERE "help_tours"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "ix_help_tours_route" ON "help_tours" USING btree ("status","locale","route");--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_tour_id_help_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."help_tours"("id") ON DELETE set null ON UPDATE no action;