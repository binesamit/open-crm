// SPDX-License-Identifier: AGPL-3.0-only
import {
  accountSettingsSchema,
  AppError,
  decimalHours,
  formatDate,
  formatDuration,
  formatTime,
  localDateOf,
  type Region,
  toCsv,
  type TimeReportQuery,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { getAccountSettings } from '../accounts/accounts.repo';
import { accountRegion } from '../accounts/region';
import { assertBoard, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { findSubBoard } from '../boards/boards.repo';
import type { ItemRow } from '../items/items.repo';
import { type Actor, loadItem } from '../items/items.service';
import { boardVisibility, filterVisible } from '../items/visibility';
import { listItemEntries, reportEntries } from './time.repo';
import { st } from '../../lib/i18n';

/**
 * Board time report (03 §3.3): the board's entries and its subitems' (sub-board, D14), on items the actor may
 * see, over local days of the account's timezone. Running timers count up to now.
 */
export const loadReportEntries = async (db: Db, a: Actor, boardId: string, q: TimeReportQuery) => {
  if (q.from && q.to && q.from > q.to) throw new AppError('invalid_value', 'from is after to');
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  assertBoard(access, 'item.read');
  const sub = await findSubBoard(db, boardId);
  const settings = accountSettingsSchema.parse(await getAccountSettings(db, a.ctx.accountId));
  const rows = await reportEntries(db, {
    accountId: a.ctx.accountId,
    boardIds: [boardId, ...(sub ? [sub.id] : [])],
    tz: settings.locale.timezone,
    from: q.from,
    to: q.to,
    userId: q.user_id,
  });
  // Only entries of items this actor may see (05 §6) — each board by its own rules — and of time columns the
  // actor may see (05 §6.1, S-29: a hidden "billable hours" column stays hidden in reports and widgets).
  const visible = new Set<string>();
  const accesses = [access, ...(sub ? [await loadBoardAccess(db, a.ctx, a.user, sub.id)] : [])];
  for (const b of accesses) {
    const items = [
      ...new Map(rows.filter((r) => r.item.boardId === b.board.id).map((r) => [r.item.id, r.item])).values(),
    ];
    for (const i of await filterVisible(db, await boardVisibility(db, a, b), items as ItemRow[])) visible.add(i.id);
  }
  const accessOf = new Map(accesses.map((b) => [b.board.id, b]));
  const now = Date.now();
  return rows
    .filter((r) => visible.has(r.item.id))
    .filter((r) => {
      const b = accessOf.get(r.item.boardId);
      return !!b && columnAllowed(b, r.columnRestrictedView);
    })
    .map((r) => ({
      ...r,
      seconds: r.entry.durationS ?? Math.max(0, Math.round((now - r.entry.startedAt.getTime()) / 1000)),
      running: !r.entry.endedAt,
      who: r.userName || r.userEmail || '—',
    }));
};

/**
 * Reports count days in the account's timezone, so their dates and times are written in it too — in the account's
 * date / time format and the reader's language (A3).
 */
const reportRegion = (db: Db, a: Actor): Promise<Region> =>
  accountRegion(db, a.ctx.accountId, { locale: a.user.locale });

export const timeReport = async (db: Db, a: Actor, boardId: string, q: TimeReportQuery) => {
  const [entries, region] = await Promise.all([loadReportEntries(db, a, boardId, q), reportRegion(db, a)]);
  const groups = new Map<
    string,
    { key: string; label: string; duration_s: number; billable_s: number; entries: number }
  >();
  for (const e of entries) {
    const [key, label] =
      q.group_by === 'item'
        ? [e.item.id, e.item.name]
        : q.group_by === 'day'
          ? [e.day, formatDate(e.day, {}, region)]
          : [e.entry.userId ?? '', e.who];
    const g = groups.get(key) ?? { key, label, duration_s: 0, billable_s: 0, entries: 0 };
    g.duration_s += e.seconds;
    if (e.entry.billable) g.billable_s += e.seconds;
    g.entries++;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((x, y) =>
    q.group_by === 'day' ? x.key.localeCompare(y.key) : y.duration_s - x.duration_s,
  );
  return {
    group_by: q.group_by,
    from: q.from ?? null,
    to: q.to ?? null,
    total_s: rows.reduce((s, r) => s + r.duration_s, 0),
    billable_s: rows.reduce((s, r) => s + r.billable_s, 0),
    running: entries.filter((e) => e.running).length,
    rows,
  };
};

/** The CSV columns (i18n keys `server.csv.time.*`), in the reader's language. */
const HEADER = ['date', 'start', 'end', 'hours', 'duration', 'user', 'item', 'note', 'billable', 'source'];
const header = (region: Region) => HEADER.map((k) => st(`server.csv.time.${k}`, undefined, region.language));
const yesNo = (v: boolean, region: Region) => st(v ? 'server.csv.yes' : 'server.csv.no', undefined, region.language);
const time = (d: Date | null, region: Region) => (d ? formatTime(d, region) : '');

/** GET /boards/:id/time/report.csv — every entry of the report, one row each (for billing). */
export const timeReportCsv = async (db: Db, a: Actor, boardId: string, q: TimeReportQuery) => {
  const [entries, region] = await Promise.all([loadReportEntries(db, a, boardId, q), reportRegion(db, a)]);
  return toCsv(
    header(region),
    entries.map((e) => [
      formatDate(e.day, {}, region),
      time(e.entry.startedAt, region),
      time(e.entry.endedAt, region),
      decimalHours(e.seconds),
      formatDuration(e.seconds),
      e.who,
      e.item.name,
      e.entry.note,
      yesNo(e.entry.billable, region),
      e.entry.source,
    ]),
  );
};

/** GET /items/:id/time/entries.csv — the item's log (03 §3.3 "ייצוא CSV של הלוג"). */
export const itemTimeCsv = async (db: Db, a: Actor, itemId: string) => {
  const { item } = await loadItem(db, a, itemId);
  const region = await reportRegion(db, a);
  const now = Date.now();
  const rows = await listItemEntries(db, item.id);
  return toCsv(
    header(region),
    rows.map((r) => {
      const seconds = r.entry.durationS ?? Math.max(0, Math.round((now - r.entry.startedAt.getTime()) / 1000));
      return [
        formatDate(localDateOf(r.entry.startedAt, region), {}, region),
        time(r.entry.startedAt, region),
        time(r.entry.endedAt, region),
        decimalHours(seconds),
        formatDuration(seconds),
        r.userName || r.userEmail || '—',
        item.name,
        r.entry.note,
        yesNo(r.entry.billable, region),
        r.entry.source,
      ];
    }),
  );
};
