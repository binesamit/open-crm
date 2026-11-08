// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  columnTypes,
  computedTriggerDate,
  dateFireAt,
  dateScheduleHash,
  firesWhenLate,
  isDateTrigger,
  newId,
  nextPeriodFire,
  recipeSchema,
  type Recipe,
} from '@bines/shared';
import type { Db } from '../../../db/client';
import { automations, automationSchedules, cells, columns, items } from '../../../db/schema';
import { recordEvent } from '../../activity/activity.repo';
import { Calculator } from '../../items/computed';
import { activeAutomationsOn, type AutomationRow } from '../automations.repo';
import { accountEnv } from './context';

/**
 * 04 §5.6 — scheduled triggers. Date triggers keep one row per (automation, item) in step with the watched
 * cell (the dispatcher calls `syncItemSchedules` on every relevant event); `every_time_period` keeps one row per
 * automation. The minute tick turns due rows into `schedule.fired` activity rows → the normal dispatch.
 */

const recipeOf = (a: AutomationRow): Recipe | null => {
  const r = recipeSchema.safeParse(a.recipe);
  return r.success ? r.data : null;
};

/**
 * Values computed from the item (s4f: a "last updated" column — of chosen columns too), read by the same
 * Calculator as the board. One per sync: a whole-board resync prefetches the board once.
 */
export type ComputedDates = { calc: Calculator; boardId?: string };

/**
 * The date a trigger watches on an item (timeline: its end), or null when empty. A stored date is its cell; a
 * computed one (last updated) is the value the board shows — see `computedTriggerDate`.
 */
const watchedDate = async (
  db: Db,
  item: { id: string; boardId: string; accountId: string },
  key: string,
  timeZone: string,
  computed?: ComputedDates,
) => {
  const col = (
    await db
      .select()
      .from(columns)
      .where(and(eq(columns.boardId, item.boardId), eq(columns.key, key), isNull(columns.deletedAt)))
      .limit(1)
  )[0];
  const def = col && columnTypes.get(col.type);
  if (!col || !def?.toDate) return null;
  const settings = { ...(def.defaultSettings as object), ...(col.settings as object) };
  if (def.fromItem) {
    const calc = computed?.calc ?? new Calculator(db, item.accountId, undefined, timeZone);
    await calc.prefetch([item.id], 0, undefined, computed?.boardId);
    const value = calc.value(item.id, col).value;
    const at = value === null ? null : def.toDate(value, settings);
    return at ? computedTriggerDate(at, (settings as { show_time?: boolean }).show_time === true, timeZone) : null;
  }
  const cell = (
    await db
      .select({ value: cells.value })
      .from(cells)
      .where(and(eq(cells.itemId, item.id), eq(cells.columnId, col.id)))
      .limit(1)
  )[0];
  if (!cell?.value) return null;
  return (def.toDateEnd ?? def.toDate)(cell.value, settings) ?? null;
};

const upsertDateRow = async (
  db: Db,
  automation: AutomationRow,
  itemId: string,
  fireAt: Date,
  hash: string,
  firedAt: Date | null,
) => {
  const existing = (
    await db
      .select()
      .from(automationSchedules)
      .where(and(eq(automationSchedules.automationId, automation.id), eq(automationSchedules.itemId, itemId)))
      .limit(1)
  )[0];
  if (existing?.valueHash === hash) {
    // Same date, same recipe: keep (fired stays fired) — unless it went stale while the automation was off.
    if (!existing.firedAt && firedAt)
      await db.update(automationSchedules).set({ firedAt }).where(eq(automationSchedules.id, existing.id));
    return;
  }
  if (existing)
    await db
      .update(automationSchedules)
      .set({ fireAt, valueHash: hash, firedAt })
      .where(eq(automationSchedules.id, existing.id));
  else
    await db.insert(automationSchedules).values({
      id: newId(),
      accountId: automation.accountId,
      automationId: automation.id,
      itemId,
      kind: 'date',
      fireAt,
      valueHash: hash,
      firedAt,
    });
};

const deleteItemRows = (db: Db, automationIds: string[], itemId: string) =>
  automationIds.length
    ? db
        .delete(automationSchedules)
        .where(and(inArray(automationSchedules.automationId, automationIds), eq(automationSchedules.itemId, itemId)))
    : Promise.resolve();

/**
 * Re-arms (or removes) the date schedules of one item for the board's date-trigger automations. A date that is
 * already due when it is set fires once only when ≤24h late (past dates do not fire).
 */
export const syncItemSchedules = async (
  db: Db,
  accountId: string,
  itemId: string,
  boardAutomations: AutomationRow[],
  now = new Date(),
  computed?: ComputedDates,
) => {
  const dated = boardAutomations.filter((a) => {
    const r = recipeOf(a);
    return r && isDateTrigger(r.trigger);
  });
  // Moved to another board: rows of automations that are not on its board any more go.
  const item = (
    await db
      .select()
      .from(items)
      .where(and(eq(items.accountId, accountId), eq(items.id, itemId)))
      .limit(1)
  )[0];
  if (item) {
    const foreign = await db
      .select({ id: automationSchedules.id })
      .from(automationSchedules)
      .innerJoin(automations, eq(automations.id, automationSchedules.automationId))
      .where(and(eq(automationSchedules.itemId, itemId), ne(automations.boardId, item.boardId)));
    if (foreign.length)
      await db.delete(automationSchedules).where(
        inArray(
          automationSchedules.id,
          foreign.map((f) => f.id),
        ),
      );
  }
  if (!dated.length) return;
  if (!item || item.deletedAt || item.archivedAt || item.depth > 0) {
    await deleteItemRows(
      db,
      dated.map((a) => a.id),
      itemId,
    );
    return;
  }
  const { timezone, weekend, calendar } = await accountEnv(db, accountId, now);
  for (const automation of dated) {
    if (automation.boardId !== item.boardId) continue;
    const t = recipeOf(automation)!.trigger;
    if (!isDateTrigger(t)) continue;
    const stored = await watchedDate(db, item, t.column, timezone, computed);
    if (!stored) {
      await deleteItemRows(db, [automation.id], itemId);
      continue;
    }
    const fireAt = dateFireAt(t, stored, timezone, { weekend, calendar });
    const late = fireAt.getTime() <= now.getTime();
    await upsertDateRow(
      db,
      automation,
      itemId,
      fireAt,
      dateScheduleHash(t, stored),
      late && !firesWhenLate(t, fireAt, now) ? now : null,
    );
  }
};

/**
 * Builds every schedule row of one automation (on activation, a recipe change, or loading the seed): date rows
 * for each live item, or the single period row. Removes rows a non-scheduled recipe no longer needs.
 */
export const syncAutomationSchedules = async (db: Db, automation: AutomationRow, now = new Date()) => {
  const recipe = recipeOf(automation);
  const t = recipe?.trigger;
  if (!t || !automation.boardId || (!isDateTrigger(t) && t.type !== 'every_time_period')) {
    await db.delete(automationSchedules).where(eq(automationSchedules.automationId, automation.id));
    return;
  }
  if (t.type === 'every_time_period') {
    await db
      .delete(automationSchedules)
      .where(and(eq(automationSchedules.automationId, automation.id), sql`${automationSchedules.itemId} is not null`));
    const { timezone } = await accountEnv(db, automation.accountId, now);
    const fireAt = nextPeriodFire(t, now, timezone);
    const hash = `${t.period}|${t.time}|${t.weekday ?? ''}|${t.day_of_month ?? ''}`;
    const existing = (
      await db
        .select()
        .from(automationSchedules)
        .where(and(eq(automationSchedules.automationId, automation.id), isNull(automationSchedules.itemId)))
        .limit(1)
    )[0];
    // The same recipe, still armed for a moment ahead: nothing to do. A row whose moment passed while the
    // automation was paused is re-armed, else it fired the minute after re-enabling (audit 2026-10-10, #4).
    if (existing?.valueHash === hash && !existing.firedAt && existing.fireAt.getTime() > now.getTime()) return;
    if (existing)
      await db
        .update(automationSchedules)
        .set({ fireAt, valueHash: hash, firedAt: null })
        .where(eq(automationSchedules.id, existing.id));
    else
      await db.insert(automationSchedules).values({
        id: newId(),
        accountId: automation.accountId,
        automationId: automation.id,
        itemId: null,
        kind: 'period',
        fireAt,
        valueHash: hash,
      });
    return;
  }
  await db
    .delete(automationSchedules)
    .where(and(eq(automationSchedules.automationId, automation.id), isNull(automationSchedules.itemId)));
  const live = await db
    .select({ id: items.id })
    .from(items)
    .where(
      and(eq(items.boardId, automation.boardId), eq(items.depth, 0), isNull(items.deletedAt), isNull(items.archivedAt)),
    );
  // A computed date (last updated) is read for the whole board at once.
  const computed: ComputedDates | undefined = (await isComputedDateColumn(db, automation.boardId, t.column))
    ? {
        calc: new Calculator(
          db,
          automation.accountId,
          undefined,
          (await accountEnv(db, automation.accountId, now)).timezone,
        ),
        boardId: automation.boardId,
      }
    : undefined;
  if (computed && live.length)
    await computed.calc.prefetch(
      live.map((i) => i.id),
      0,
      undefined,
      automation.boardId,
    );
  for (const { id } of live) await syncItemSchedules(db, automation.accountId, id, [automation], now, computed);
};

/** Whether a board column (by key) is computed from the item — a "last updated" column (s4f). */
export const isComputedDateColumn = async (db: Db, boardId: string, key: string) => {
  const col = (
    await db
      .select({ type: columns.type })
      .from(columns)
      .where(and(eq(columns.boardId, boardId), eq(columns.key, key), isNull(columns.deletedAt)))
      .limit(1)
  )[0];
  return !!col && !!columnTypes.get(col.type)?.fromItem;
};

/**
 * s4f: a computed column's settings changed (a "last updated" column now watches other columns) — every active
 * date trigger of the board that reads it is re-armed from the new values.
 */
export const resyncDateTriggersOfColumn = async (db: Db, accountId: string, boardId: string, key: string) => {
  for (const automation of await activeAutomationsOn(db, accountId, [boardId])) {
    const t = recipeOf(automation)?.trigger;
    if (t && isDateTrigger(t) && t.column === key) await syncAutomationSchedules(db, automation);
  }
};

export const TICK_BATCH = 1000;

/**
 * `automation.schedule_tick` (every minute): claims due rows (SKIP LOCKED — one tick at a time per row), writes
 * one `schedule.fired` activity row each, and advances period rows to their next fire (a worker that was down
 * fires a missed period once, not once per missed period).
 */
export const tickSchedules = async (db: Db, now = new Date()) => {
  return db.transaction(async (tx) => {
    // Paused automations keep their rows (04 §5.6) but do not fire; activation re-syncs them.
    const due = await tx
      .select({ id: automationSchedules.id })
      .from(automationSchedules)
      .innerJoin(automations, eq(automations.id, automationSchedules.automationId))
      .where(
        and(
          isNull(automationSchedules.firedAt),
          lte(automationSchedules.fireAt, now),
          eq(automations.isActive, true),
          isNull(automations.deletedAt),
        ),
      )
      .orderBy(asc(automationSchedules.fireAt))
      .limit(TICK_BATCH)
      .for('update', { of: automationSchedules, skipLocked: true });
    if (!due.length) return 0;
    const rows = await tx
      .update(automationSchedules)
      .set({ firedAt: now })
      .where(
        inArray(
          automationSchedules.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
    const autos = await tx
      .select()
      .from(automations)
      .where(inArray(automations.id, [...new Set(rows.map((r) => r.automationId))]));
    const byId = new Map(autos.map((a) => [a.id, a]));
    const zones = new Map<string, string>();
    let fired = 0;
    for (const row of rows) {
      const automation = byId.get(row.automationId);
      if (!automation?.boardId || automation.deletedAt) continue;
      await recordEvent(tx, {
        accountId: row.accountId,
        type: 'schedule.fired',
        actorId: null,
        actorType: 'system',
        boardId: automation.boardId,
        itemId: row.itemId,
        meta: { automation_id: automation.id, schedule_id: row.id, fire_at: row.fireAt.toISOString() },
      });
      fired++;
      const t = recipeOf(automation)?.trigger;
      if (row.kind === 'period' && t?.type === 'every_time_period') {
        const tz = zones.get(row.accountId) ?? (await accountEnv(tx, row.accountId, now)).timezone;
        zones.set(row.accountId, tz);
        await tx
          .update(automationSchedules)
          .set({ fireAt: nextPeriodFire(t, now, tz), firedAt: null })
          .where(eq(automationSchedules.id, row.id));
      }
    }
    return fired;
  });
};
