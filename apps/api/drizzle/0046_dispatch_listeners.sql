-- The automation dispatch trigger queued one `automation.dispatch` job per listened event in any account that had
-- an active automation, webhook, triggered agent or auto-run AI column anywhere — so a bulk edit or import on a
-- board nobody listens to filled the queue with jobs that do nothing, ahead of the ones that matter (a busy
-- account's queue: tens of thousands of no-op jobs). It now queues an event only when something can hear it,
-- with the same rules as `dispatchEvent` (automations/engine/runner.ts):
--   * an active automation or webhook on the event's board (a sub-board's events: its parent board's);
--   * an auto-run AI column on the event's own board (cell / name changes, new items);
--   * an agent with a mention / assign trigger in the account (updates; people cells);
--   * an active automation on a board whose relation column links to the item (status changes — "when all
--     connected items are done");
--   * moving an item to another board (its date schedules follow it) and the engine's own events (a schedule
--     fired, an inbound webhook) keep the account-wide rule.
-- Events without a board are never dispatched (`dispatchEvent` ignores them). Same transaction, same job spec.
CREATE OR REPLACE FUNCTION "bines_enqueue_automation_dispatch_rows"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_regnamespace('graphile_worker') IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM graphile_worker.add_jobs(s.specs)
  FROM (
    SELECT array_agg(
      ROW('automation.dispatch', json_build_object('event_id', n."id", 'account_id', n."account_id"),
        NULL, NULL, 5, NULL, NULL, NULL)::graphile_worker.job_spec
      ORDER BY n."id") AS specs
    FROM new_rows n
    LEFT JOIN "boards" b ON b."id" = n."board_id"
    WHERE n."type" IN ('item.created', 'cell.changed', 'item.renamed', 'item.moved_to_group', 'update.created',
        'update.edited', 'update.deleted', 'item.archived', 'item.deleted', 'item.restored', 'item.unarchived',
        'item.moved_to_board', 'group.created', 'column.created', 'schedule.fired', 'webhook_in.received',
        'update.replied', 'button.clicked', 'column.type_changed')
      AND n."board_id" IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM "automations" a
          WHERE a."board_id" = COALESCE(b."parent_board_id", n."board_id") AND a."is_active" AND a."deleted_at" IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM "webhooks" w
          WHERE w."board_id" = COALESCE(b."parent_board_id", n."board_id") AND w."is_active" AND w."deleted_at" IS NULL
        )
        OR (
          n."type" IN ('cell.changed', 'item.renamed', 'item.created')
          AND EXISTS (
            SELECT 1 FROM "columns" c
            WHERE c."board_id" = n."board_id" AND c."type" = 'ai' AND c."deleted_at" IS NULL
              AND c."settings" ->> 'auto_run' = 'true'
          )
        )
        OR (
          (n."type" IN ('update.created', 'update.replied')
            OR (n."type" = 'cell.changed' AND n."payload" -> 'meta' ->> 'column_type' = 'people'))
          AND EXISTS (
            SELECT 1 FROM "agents" g
            WHERE g."account_id" = n."account_id" AND g."is_active" AND g."deleted_at" IS NULL
              AND (g."triggers" ->> 'mention' = 'true' OR g."triggers" ->> 'assign' = 'true')
          )
        )
        OR (
          n."type" = 'cell.changed' AND n."item_id" IS NOT NULL
          AND n."payload" -> 'meta' ->> 'column_type' = 'status'
          AND EXISTS (
            SELECT 1 FROM "item_links" l
            JOIN "columns" c ON c."id" = l."column_id"
            JOIN "automations" a ON a."board_id" = c."board_id" AND a."is_active" AND a."deleted_at" IS NULL
            WHERE l."to_item_id" = n."item_id"
          )
        )
        OR (
          n."type" IN ('item.moved_to_board', 'schedule.fired', 'webhook_in.received')
          AND n."account_id" IN (
            SELECT a."account_id" FROM "automations" a WHERE a."is_active" AND a."deleted_at" IS NULL
            UNION
            SELECT w."account_id" FROM "webhooks" w WHERE w."is_active" AND w."deleted_at" IS NULL
          )
        )
      )
  ) s
  WHERE s.specs IS NOT NULL;
  RETURN NULL;
END $$;
