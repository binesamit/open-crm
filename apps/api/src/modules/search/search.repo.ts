// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

/** `ILIKE` pattern for a free-text query: `%`, `_` and `\` are taken literally. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

/** Trigram-friendly `ILIKE` searches; JIT off (short queries, see items/query.repo). */
const run = <T>(db: Db, query: ReturnType<typeof sql>) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`set local jit = off`);
    return rows<T>(await tx.execute(query));
  });

/**
 * Live items whose name or a cell's text matches, or that carry a matching tag (fix2: searching a tag's name finds
 * the items tagged with it — by tag id, so a renamed tag still finds them). `matched` is what matched when the name
 * did not: `#tag` for a tag, else the cell text — never from a column whose view is restricted to owners.
 * `tagsOnly` (a `#tag` search): only tags count. Order: items carrying a tag named exactly `q`, then names starting
 * with it, then other tag hits, newest first.
 */
export const itemHits = (db: Db, accountId: string, q: string, limit: number, tagsOnly = false, archived = false) => {
  const p = likePattern(q);
  const prefix = `${likePattern(q).slice(1)}`;
  const byName = tagsOnly ? sql`false` : sql`i.name ilike ${p}`;
  const visibleTags = sql`col.deleted_at is null and col.restricted_view is null and col.type = 'tags'`;
  const tagName = sql`(select '#' || t.name from cells c
    join columns col on col.id = c.column_id and ${visibleTags}
    join tags t on t.account_id = ${accountId} and t.deleted_at is null and t.name ilike ${p}
      and jsonb_exists(c.value->'tag_ids', t.id::text)
    where c.item_id = i.id order by (lower(t.name) = lower(${q}::text)) desc, t.name limit 1)`;
  // S-28: a relation / dependency cell caches the names of the items it links to — items on boards (or rows) the
  // reader may not see; those names are not searched or shown here (the board's own view filters them per reader).
  const textCols = sql`col.deleted_at is null and col.restricted_view is null
    and col.type not in ('board_relation', 'dependency')`;
  const cellText = tagsOnly
    ? sql`null`
    : sql`(select c.text_value from cells c
        join columns col on col.id = c.column_id and ${textCols}
        where c.item_id = i.id and c.text_value ilike ${p} limit 1)`;
  // Candidates first, each through its own index (perf review: one OR of three EXISTS over every live item of
  // the account, ranked by more EXISTS per item, cost ~0.6 s at 100k items): names and cell texts by their
  // trigram indexes; tags (the account's tags whose name matches — account-wide and board ones) by the GIN index
  // on cells.value. Each hit carries whether a tag matched, and whether one is named exactly `q`, for the order.
  const tagCells = sql`select c.item_id, true as by_tag, lower(t.name) = lower(${q}::text) as exact_tag
      from tags t
      join cells c on c.account_id = ${accountId}
        and c.value @> jsonb_build_object('tag_ids', jsonb_build_array(t.id::text))
      join columns col on col.id = c.column_id and ${visibleTags}
      where t.account_id = ${accountId} and t.deleted_at is null and t.name ilike ${p}`;
  const candidates = tagsOnly
    ? tagCells
    : sql`select i.id as item_id, false as by_tag, false as exact_tag from items i
        where i.account_id = ${accountId} and i.name ilike ${p}
      union all
      select c.item_id, false, false from cells c
        join columns col on col.id = c.column_id and ${textCols}
        where c.account_id = ${accountId} and c.text_value ilike ${p}
      union all
      ${tagCells}`;
  return run<{ id: string; matched: string | null }>(
    db,
    sql`
    with hits as materialized (
      select item_id, bool_or(by_tag) as by_tag, bool_or(exact_tag) as exact_tag from (${candidates}) x
      group by item_id
    )
    select i.id,
      case when ${byName} then null else coalesce(${tagName}, ${cellText}) end as matched
    from hits h
    join items i on i.id = h.item_id
    join boards b on b.id = i.board_id
    where i.account_id = ${accountId} and i.deleted_at is null and b.deleted_at is null
      and ${archived ? sql`true` : sql`i.archived_at is null and b.archived_at is null`}
    order by h.exact_tag desc, (i.name ilike ${prefix}) desc, h.by_tag desc, i.updated_at desc
    limit ${limit}`,
  );
};

/**
 * Files whose name matches: in a file-column cell (never an owner-only column) or attached to an update, on
 * live items (archived ones too with `archived`). Visibility is checked by the service.
 */
export const fileHits = (db: Db, accountId: string, q: string, limit: number, archived = false) => {
  const p = likePattern(q);
  const live = archived ? sql`i.deleted_at is null` : sql`i.deleted_at is null and i.archived_at is null`;
  return run<{ id: string; name: string; item_id: string; in_update: boolean }>(
    db,
    sql`
    select * from (
      select a.id, coalesce(cur.file_name, a.file_name) as name, f.item_id, false as in_update, a.created_at
      from cell_files f
      join assets a on a.id = f.asset_id and a.deleted_at is null
      -- a file's current version names it
      left join lateral (
        select v.file_name from assets v
        where v.parent_asset_id = a.id and v.deleted_at is null and v.upload_status = 'uploaded'
        order by v.version desc limit 1
      ) cur on true
      join items i on i.id = f.item_id and ${live}
      join columns col on col.id = f.column_id and col.deleted_at is null and col.restricted_view is null
      where f.account_id = ${accountId} and coalesce(cur.file_name, a.file_name) ilike ${p}
      union all
      select a.id, a.file_name, u.item_id, true, a.created_at from update_files uf
      join assets a on a.id = uf.asset_id and a.deleted_at is null
      join updates u on u.id = uf.update_id and u.deleted_at is null
      join items i on i.id = u.item_id and ${live}
      where uf.account_id = ${accountId} and a.file_name ilike ${p}
    ) hits
    order by created_at desc
    limit ${limit}`,
  );
};

/** Account tags by name (03 §3.1), names starting with the text first. */
export const tagHits = (db: Db, accountId: string, q: string, limit: number) =>
  run<{ id: string; name: string; color: string }>(
    db,
    sql`
    select id, name, color from tags
    where account_id = ${accountId} and board_id is null and deleted_at is null and name ilike ${likePattern(q)}
    order by (name ilike ${likePattern(q).slice(1)}) desc, name
    limit ${limit}`,
  );

/** Top-level live boards by name. */
export const boardHits = (db: Db, accountId: string, q: string, limit: number) =>
  run<{ id: string; name: string; workspace: string | null }>(
    db,
    sql`
    select b.id, b.name, w.name as workspace from boards b
    left join workspaces w on w.id = b.workspace_id
    where b.account_id = ${accountId} and b.deleted_at is null and b.archived_at is null
      and b.parent_board_id is null and b.name ilike ${likePattern(q)}
    order by (b.name ilike ${likePattern(q).slice(1)}) desc, b.updated_at desc
    limit ${limit}`,
  );

/**
 * Live sidebar docs (M8) by name or text: name hits first, then the most recently edited. `text` comes back only
 * when the name did not match (for the excerpt).
 */
export const docHits = (db: Db, accountId: string, q: string, limit: number) =>
  run<{ id: string; name: string; workspace: string | null; text: string | null }>(
    db,
    sql`
    select d.id, d.name, w.name as workspace,
      case when d.name ilike ${likePattern(q)} then null else d.text_value end as text
    from docs d
    left join workspaces w on w.id = d.workspace_id
    where d.account_id = ${accountId} and d.deleted_at is null and d.archived_at is null and d.host = 'workspace'
      and (d.name ilike ${likePattern(q)} or d.text_value ilike ${likePattern(q)})
    order by (d.name ilike ${likePattern(q)}) desc, d.updated_at desc
    limit ${limit}`,
  );

/** Live dashboards by name; the service keeps those the actor may open. */
export const dashboardHits = (db: Db, accountId: string, q: string, limit: number) =>
  run<{ id: string; workspace: string | null }>(
    db,
    sql`
    select d.id, w.name as workspace
    from dashboards d
    left join workspaces w on w.id = d.workspace_id
    where d.account_id = ${accountId} and d.deleted_at is null and d.name ilike ${likePattern(q)}
    order by d.updated_at desc
    limit ${limit}`,
  );

/** Live updates (and replies) by text, newest first. */
export const updateHits = (db: Db, accountId: string, q: string, limit: number) =>
  run<{ id: string; item_id: string; body_text: string; author: string | null; created_at: Date }>(
    db,
    sql`
    select u.id, u.item_id, u.body_text, coalesce(nullif(us.name, ''), us.email) as author, u.created_at
    from updates u
    join items i on i.id = u.item_id and i.deleted_at is null and i.archived_at is null
    left join users us on us.id = u.created_by
    where u.account_id = ${accountId} and u.deleted_at is null and u.body_text ilike ${likePattern(q)}
    order by u.created_at desc
    limit ${limit}`,
  );

/** Active members by name or email. */
export const peopleHits = (db: Db, accountId: string, q: string, limit: number) =>
  run<{ id: string; name: string; email: string }>(
    db,
    sql`
    select u.id, coalesce(nullif(u.name, ''), u.email) as name, u.email from account_members m
    join users u on u.id = m.user_id
    where m.account_id = ${accountId} and m.status = 'active'
      and (u.name ilike ${likePattern(q)} or u.email ilike ${likePattern(q)})
    order by u.name
    limit ${limit}`,
  );

/**
 * The Inbox (07 §9.3): updates and replies by others on items I follow, or that mention me, since `since`;
 * newest first, paged by id. An entry is read when I dismissed it (V) or it is older than my "mark all read"
 * (`clearedAt`); read ones are left out unless `includeRead`.
 */
export const inboxRows = (
  db: Db,
  accountId: string,
  userId: string,
  opts: {
    since: Date;
    before?: string;
    mentionsOnly: boolean;
    limit: number;
    clearedAt: Date | null;
    includeRead: boolean;
  },
) => {
  const read = sql`(${opts.clearedAt ? sql`u.created_at <= ${opts.clearedAt}` : sql`false`}
      or exists (select 1 from inbox_dismissals d where d.user_id = ${userId} and d.update_id = u.id))`;
  return run<{
    id: string;
    parent_update_id: string | null;
    item_id: string;
    body_html: string;
    body_text: string;
    file_names: string[];
    created_at: Date;
    author_id: string | null;
    author_name: string | null;
    mention: boolean;
    read: boolean;
  }>(
    db,
    sql`
    select u.id, u.parent_update_id, u.item_id, u.body_html, u.body_text,
      array(select a.file_name from update_files uf join assets a on a.id = uf.asset_id
        where uf.update_id = u.id order by a.file_name) as file_names,
      u.created_at, u.created_by as author_id,
      coalesce(nullif(us.name, ''), us.email) as author_name,
      exists (select 1 from update_mentions m where m.update_id = u.id and m.user_id = ${userId}) as mention,
      ${read} as read
    from updates u
    join items i on i.id = u.item_id and i.deleted_at is null and i.archived_at is null
    left join users us on us.id = u.created_by
    where u.account_id = ${accountId} and u.deleted_at is null and u.created_at >= ${opts.since}
      and u.created_by is distinct from ${userId}
      ${opts.before ? sql`and u.id < ${opts.before}` : sql``}
      ${opts.includeRead ? sql`` : sql`and not ${read}`}
      and (
        exists (select 1 from update_mentions m where m.update_id = u.id and m.user_id = ${userId})
        ${
          opts.mentionsOnly
            ? sql``
            : sql`or exists (select 1 from item_followers f
                 where f.item_id = u.item_id and f.user_id = ${userId} and not f.muted)`
        })
    order by u.id desc
    limit ${opts.limit}`,
  );
};

/** "V" on inbox entries: only updates of this account count. */
export const dismissInbox = (db: Db, accountId: string, userId: string, updateIds: string[]) =>
  db.execute(sql`
    insert into inbox_dismissals (user_id, update_id, account_id)
    select ${userId}, u.id, u.account_id from updates u
    where u.account_id = ${accountId} and u.id in (${sql.join(
      updateIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    on conflict do nothing`);
