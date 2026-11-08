CREATE TABLE "automation_schedules" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"account_id" varchar(26) NOT NULL,
	"automation_id" varchar(26) NOT NULL,
	"item_id" varchar(26),
	"kind" varchar(16) NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"value_hash" varchar(120),
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "ux_automation_runs_event";--> statement-breakpoint
ALTER TABLE "automation_schedules" ADD CONSTRAINT "automation_schedules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_schedules" ADD CONSTRAINT "automation_schedules_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_schedules" ADD CONSTRAINT "automation_schedules_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_automation_schedules_item" ON "automation_schedules" USING btree ("automation_id","item_id") WHERE "automation_schedules"."item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_automation_schedules_period" ON "automation_schedules" USING btree ("automation_id") WHERE "automation_schedules"."item_id" is null;--> statement-breakpoint
CREATE INDEX "ix_automation_schedules_due" ON "automation_schedules" USING btree ("fire_at") WHERE "automation_schedules"."fired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_automation_runs_event" ON "automation_runs" USING btree ("automation_id","event_id",coalesce("item_id", '')) WHERE "automation_runs"."event_id" is not null;--> statement-breakpoint
-- Moves between boards also re-arm date schedules (04 §5.6): the dispatch trigger now hears item.moved_to_board.
DROP TRIGGER "tr_activity_log_automation_dispatch" ON "activity_log";--> statement-breakpoint
CREATE TRIGGER "tr_activity_log_automation_dispatch" AFTER INSERT ON "activity_log" FOR EACH ROW
  WHEN (NEW."type" IN ('item.created', 'cell.changed', 'item.renamed', 'item.moved_to_group', 'update.created',
    'item.archived', 'item.deleted', 'item.restored', 'item.unarchived', 'item.moved_to_board', 'schedule.fired',
    'webhook_in.received'))
  EXECUTE FUNCTION "bines_enqueue_automation_dispatch"();
