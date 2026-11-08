// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './trash.repo';

/** A timer left running this long gets a "forgot your timer?" notification (03 §3.3). */
export const FORGOTTEN_AFTER_HOURS = 12;

type Forgotten = {
  id: string;
  account_id: string;
  user_id: string;
  board_id: string;
  /** The board whose settings also rule it: the parent, for a sub-board's item (D14). */
  top_board_id: string | null;
  item_id: string;
  started_at: string;
};

/** Running entries past the limit that have not been flagged yet. */
export const forgottenTimers = async (db: SqlClient) =>
  (
    await db.query(
      `select te.id, te.account_id, te.user_id, te.board_id, b.parent_board_id as top_board_id, te.item_id,
              te.started_at
       from time_entries te
       left join boards b on b.id = te.board_id
       where te.ended_at is null and te.deleted_at is null and te.user_id is not null
         and te.started_at < now() - make_interval(hours => $1)
         and not exists (
           select 1 from notifications n
           where n.type = 'time.forgotten' and n.payload->>'entry_id' = te.id)`,
      [FORGOTTEN_AFTER_HOURS],
    )
  ).rows as Forgotten[];

/**
 * Writes the "forgot your timer?" notification. Always one row per entry (it marks the entry as flagged); `bell` =
 * the user's bell settings allow it (`channelAllowed`, like every API notification) — off → a row for the email /
 * the phone only (`bell: false`, hidden from the bell), whose own rules the email and push tasks check.
 */
export const notifyForgotten = (db: SqlClient, id: string, t: Forgotten, bell: boolean) =>
  db.query(
    `insert into notifications (id, account_id, user_id, type, payload, board_id, item_id)
     values ($1, $2, $3, 'time.forgotten', $4::jsonb, $5, $6)`,
    [
      id,
      t.account_id,
      t.user_id,
      JSON.stringify({ entry_id: t.id, started_at: t.started_at, ...(bell ? {} : { bell: false }) }),
      t.board_id,
      t.item_id,
    ],
  );
