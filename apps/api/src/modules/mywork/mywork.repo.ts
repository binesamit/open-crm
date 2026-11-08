// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers } from '../../db/schema';

/**
 * Live items that name one of `principals` (me and my teams) in a people column, touched since `since` — newest
 * first: on live top-level boards, and with `subitems` also on their live sub-boards (D14). Visibility and board
 * access are checked by the service.
 */
export const assignedItemIds = async (
  db: Db,
  accountId: string,
  principals: string[],
  since: Date,
  limit: number,
  subitems = false,
) => {
  if (!principals.length) return [];
  // People cells naming a principal, found through the GIN index on cells.value (jsonb_path_ops, `@>`); the
  // old per-item EXISTS over jsonb_array_elements read every recent item's cells (perf review, 100k items:
  // ~700 ms → ~50 ms). MATERIALIZED: one index scan instead of one per people column.
  const wanted = sql.join(
    principals.map(
      (p) => sql`jsonb_build_object('persons_and_teams', jsonb_build_array(jsonb_build_object('id', ${p}::text)))`,
    ),
    sql`, `,
  );
  // Short query over many cells: JIT compilation would cost more than the query (see items/query.repo).
  const res = await db.transaction(async (tx) => {
    await tx.execute(sql`set local jit = off`);
    return tx.execute(sql`
    with mine as materialized (
      select c.item_id, c.column_id from cells c
      where c.account_id = ${accountId} and c.value @> any(array[${wanted}])
    )
    select i.id from items i
    join boards b on b.id = i.board_id
    left join boards pb on pb.id = b.parent_board_id
    where i.account_id = ${accountId} and i.deleted_at is null and i.archived_at is null
      and b.deleted_at is null and b.archived_at is null
      and ${
        subitems
          ? sql`(b.parent_board_id is null and i.depth = 0
              or pb.id is not null and pb.deleted_at is null and pb.archived_at is null)`
          : sql`b.parent_board_id is null and i.depth = 0`
      }
      and i.updated_at >= ${since}
      and i.id in (
        select m.item_id from mine m
        join columns col on col.id = m.column_id and col.type = 'people' and col.deleted_at is null)
    order by i.updated_at desc
    limit ${limit}`);
  });
  return ((res as unknown as { rows: unknown[] }).rows as { id: string }[]).map((r) => r.id);
};

export const memberSettings = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ settings: accountMembers.settings })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
      .limit(1)
  )[0]?.settings ?? {};

export const setMemberSettings = (db: Db, accountId: string, userId: string, settings: Record<string, unknown>) =>
  db
    .update(accountMembers)
    .set({ settings })
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));
