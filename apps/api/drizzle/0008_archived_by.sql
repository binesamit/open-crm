ALTER TABLE "boards" ADD COLUMN "archived_by" varchar(26);--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "archived_by" varchar(26);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "archived_by" varchar(26);--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;