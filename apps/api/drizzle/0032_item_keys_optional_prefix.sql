DROP INDEX "ux_item_keys_account_prefix";--> statement-breakpoint
CREATE INDEX "ix_item_keys_board" ON "item_keys" USING btree ("board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_item_keys_account_prefix" ON "item_keys" USING btree ("account_id","prefix") WHERE "item_keys"."prefix" <> '';