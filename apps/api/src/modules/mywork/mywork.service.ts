// SPDX-License-Identifier: AGPL-3.0-only
import {
  accountSettingsSchema,
  canBoard,
  columnTypes,
  dateInZone,
  localDate,
  MY_WORK_LIMITS,
  type MyWork,
  type MyWorkSettings,
  myWorkSettingsSchema,
  WORK_SECTIONS,
  type WorkBoard,
  type WorkItem,
  workSection,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountCalendar } from '../../lib/account-calendar';
import type { Actor } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import { actorRegion, regionCellText } from '../accounts/region';
import { loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { listGroups, type ColumnRow } from '../boards/boards.repo';
import { columnDto } from '../boards/boards.service';
import { cellsByItemIds, itemsByIds, type ItemRow } from '../items/items.repo';
import { visibleColumns } from '../items/items.service';
import { accountTeams } from '../items/query.repo';
import { boardVisibility, filterVisible } from '../items/visibility';
import { assignedItemIds, memberSettings, setMemberSettings } from './mywork.repo';

const DATE_TYPES = new Set(['date', 'timeline']);
const BOARD_CONCURRENCY = 8;

/** `fn` over `list` with at most `limit` running at once; results keep the input order. */
const mapLimit = async <T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> => {
  const out = new Array<R>(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
};

export const myWorkSettings = async (db: Db, a: Actor): Promise<MyWorkSettings> => {
  const all = (await memberSettings(db, a.ctx.accountId, a.user.id)) as { my_work?: unknown };
  const parsed = myWorkSettingsSchema.safeParse(all.my_work ?? {});
  return parsed.success ? parsed.data : myWorkSettingsSchema.parse({});
};

export const updateMyWorkSettings = async (
  db: Db,
  a: Actor,
  patch: {
    hide_done?: boolean;
    group_by?: 'date' | 'board';
    subitems?: boolean;
    boards?: Record<
      string,
      {
        hidden?: boolean;
        date_column?: string | null;
        status_column?: string | null;
        people_column?: string | null;
      } | null
    >;
  },
) => {
  const current = await myWorkSettings(db, a);
  const boards = { ...current.boards };
  for (const [id, prefs] of Object.entries(patch.boards ?? {})) {
    if (prefs === null) delete boards[id];
    else boards[id] = { ...boards[id], ...prefs };
  }
  const next: MyWorkSettings = {
    hide_done: patch.hide_done ?? current.hide_done,
    group_by: patch.group_by ?? current.group_by,
    subitems: patch.subitems ?? current.subitems,
    boards,
  };
  const all = (await memberSettings(db, a.ctx.accountId, a.user.id)) as Record<string, unknown>;
  await setMemberSettings(db, a.ctx.accountId, a.user.id, { ...all, my_work: next });
  return next;
};

/** The deadline of a date / timeline cell as a local calendar date (a timeline counts by its end). */
const deadlineOf = (column: ColumnRow, value: unknown, timezone: string) => {
  const def = columnTypes.get(column.type);
  if (value === null || value === undefined || !def?.toDate) return null;
  try {
    const raw =
      def.toDateEnd?.(value as never, column.settings as never) ?? def.toDate(value as never, column.settings as never);
    return raw ? localDate(raw, timezone) : null;
  } catch {
    return null;
  }
};

const isDone = (column: ColumnRow | undefined, value: unknown) => {
  if (!column || !value) return false;
  const labels = (column.settings as { labels?: { id: number; is_done?: boolean }[] }).labels ?? [];
  const index = (value as { index?: number }).index;
  return labels.some((l) => l.id === index && l.is_done);
};

const pick = (columns: ColumnRow[], key: string | null | undefined, ok: (c: ColumnRow) => boolean) =>
  key === null ? undefined : ((key ? columns.find((c) => c.key === key && ok(c)) : undefined) ?? columns.find(ok));

/**
 * GET /me/work (07 §9.2, 06 §2.23): items where I or a team of mine sit in a people column, on boards I can
 * read and items I may see (`view_items`), touched in the last 4 months — at most 50 boards and 1,000 items,
 * the most recently touched first. Each board's first date / status column decides unless I chose others;
 * items whose status is a "done" label are hidden when `hide_done` is on.
 */
export const myWork = async (db: Db, a: Actor): Promise<MyWork> => {
  const [settings, accountSettings, teams, region] = await Promise.all([
    myWorkSettings(db, a),
    getAccountSettings(db, a.ctx.accountId).then((s) => accountSettingsSchema.parse(s)),
    accountTeams(db, a.ctx.accountId),
    actorRegion(db, a),
  ]);
  const { timezone, weekend, first_day } = accountSettings.locale;
  const calendar = await accountCalendar(db, a.ctx.accountId, accountSettings);
  const env = { today: dateInZone(new Date(), timezone), timezone, weekend, firstDay: first_day, calendar };
  const principals = [a.user.id, ...teams.filter((t) => t.member_ids.includes(a.user.id)).map((t) => t.id)];

  const since = new Date();
  since.setMonth(since.getMonth() - MY_WORK_LIMITS.months);
  const ids = await assignedItemIds(
    db,
    a.ctx.accountId,
    principals,
    since,
    MY_WORK_LIMITS.items + 1,
    settings.subitems,
  );
  let truncated = ids.length > MY_WORK_LIMITS.items;
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = (await itemsByIds(db, a.ctx.accountId, ids.slice(0, MY_WORK_LIMITS.items))).sort(
    (x, y) => order.get(x.id)! - order.get(y.id)!,
  );

  // Boards in order of their most recently touched item; only the first 50 count.
  const byBoard = new Map<string, ItemRow[]>();
  for (const r of rows) byBoard.set(r.boardId, [...(byBoard.get(r.boardId) ?? []), r]);
  let boardIds = [...byBoard.keys()];
  if (boardIds.length > MY_WORK_LIMITS.boards) {
    boardIds = boardIds.slice(0, MY_WORK_LIMITS.boards);
    truncated = true;
  }
  const readable = await readableBoardIds(db, a.ctx, a.user, boardIds);

  /** One board's entry and its rows (null when nothing of mine there is visible to me). */
  const loadBoard = async (boardId: string): Promise<{ board: WorkBoard; items: WorkItem[] } | null> => {
    const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
    const prefs = settings.boards[boardId] ?? {};
    const [columns, groups, visible] = await Promise.all([
      visibleColumns(db, access),
      listGroups(db, boardId),
      boardVisibility(db, a, access).then((v) => filterVisible(db, v, byBoard.get(boardId)!)),
    ]);
    if (!visible.length) return null;
    const dateColumn = pick(columns, prefs.date_column, (c) => DATE_TYPES.has(c.type));
    const statusColumn = pick(columns, prefs.status_column, (c) => c.type === 'status');
    const cells = await cellsByItemIds(
      db,
      visible.map((i) => i.id),
    );
    const names = (c: { value: unknown }) =>
      ((c.value as { persons_and_teams?: { id: string }[] }).persons_and_teams ?? []).some((p) =>
        principals.includes(p.id),
      );
    // My chosen people column decides what is mine here; otherwise any people column naming me.
    const chosen = prefs.people_column
      ? columns.find((c) => c.key === prefs.people_column && c.type === 'people')
      : undefined;
    const peopleColumn =
      chosen ?? columns.find((col) => col.type === 'people' && cells.some((c) => c.columnId === col.id && names(c)));
    const mine = chosen
      ? new Set(cells.filter((c) => c.columnId === chosen.id && names(c)).map((c) => c.itemId))
      : null;
    // A subitem shows under its parent's name (D14).
    const parentIds = [...new Set(visible.flatMap((i) => (i.parentItemId ? [i.parentItemId] : [])))];
    const parents = new Map(
      (parentIds.length ? await itemsByIds(db, a.ctx.accountId, parentIds) : []).map((p) => [p.id, p.name]),
    );
    const shown = [dateColumn, statusColumn, peopleColumn].filter((c): c is ColumnRow => !!c);
    const board: WorkBoard = {
      id: boardId,
      name: access.board.name,
      open_board_id: access.board.parentBoardId ?? boardId,
      subitems: !!access.board.parentBoardId,
      hidden: !!prefs.hidden,
      can_edit: canBoard(access.perm, 'item.update').ok,
      date_column: dateColumn ? columnDto(dateColumn, access) : null,
      status_column: statusColumn ? columnDto(statusColumn, access) : null,
      people_column: peopleColumn ? columnDto(peopleColumn, access) : null,
      date_choices: columns.filter((c) => DATE_TYPES.has(c.type)).map((c) => ({ key: c.key, title: c.title })),
      status_choices: columns.filter((c) => c.type === 'status').map((c) => ({ key: c.key, title: c.title })),
      people_choices: columns.filter((c) => c.type === 'people').map((c) => ({ key: c.key, title: c.title })),
      people_choice: chosen ? chosen.key : null,
    };
    if (prefs.hidden) return { board, items: [] };

    // Date, status and people are stored cells: read them from the rows already loaded (no calculator).
    const byItem = new Map<string, Record<string, { value: unknown; text: string | null }>>();
    for (const c of cells) {
      const col = shown.find((x) => x.id === c.columnId);
      if (!col) continue;
      const row = byItem.get(c.itemId) ?? {};
      row[col.key] = { value: c.value, text: regionCellText(col.type, col.settings, c.value, c.textValue, region) };
      byItem.set(c.itemId, row);
    }
    const groupOf = new Map(groups.map((g) => [g.id, g]));
    const items: WorkItem[] = [];
    for (const item of visible) {
      if (mine && !mine.has(item.id)) continue;
      const dto = { cells: byItem.get(item.id) ?? {} };
      const status = statusColumn ? dto.cells[statusColumn.key]?.value : undefined;
      if (settings.hide_done && isDone(statusColumn, status)) continue;
      const date = dateColumn ? deadlineOf(dateColumn, dto.cells[dateColumn.key]?.value, timezone) : null;
      const g = item.groupId ? groupOf.get(item.groupId) : undefined;
      items.push({
        id: item.id,
        name: item.name,
        board_id: boardId,
        parent: item.parentItemId ? { id: item.parentItemId, name: parents.get(item.parentItemId) ?? '' } : null,
        group: g ? { id: g.id, title: g.title, color: g.color } : null,
        section: workSection(date, env),
        date,
        cells: dto.cells,
      });
    }
    return { board, items };
  };

  // Several boards at a time (the pool has 10 connections), results in board order.
  const loaded = await mapLimit(
    boardIds.filter((id) => readable.has(id)),
    BOARD_CONCURRENCY,
    loadBoard,
  );
  const boards = loaded.flatMap((r) => (r ? [r.board] : []));
  const items = loaded.flatMap((r) => r?.items ?? []);

  // Within a section: by deadline, then by name.
  items.sort((x, y) => (x.date ?? '9999').localeCompare(y.date ?? '9999') || x.name.localeCompare(y.name, 'he'));
  return {
    today: env.today,
    sections: WORK_SECTIONS.map((key) => ({ key, items: items.filter((i) => i.section === key) })),
    boards,
    truncated,
    settings,
  };
};
