// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, dateInZone, newId, normalizeConditions, type RecipeInput, zonedToUtc } from '@bines/shared';
import { activityLog, automationRuns, automations, automationSchedules, cells, items } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { syncAutomationSchedules, tickSchedules } from '../src/modules/automations/engine/schedules';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * s4f — "date arrives" on a "last updated" column: the schedule follows the time the board shows for that column —
 * the last change of its chosen columns (r23ui) when it has some, else of any cell — never the item's updated_at.
 * Scheduling on a change, the activation backfill, a change of the chosen columns, and the condition all agree.
 */
let t: TestContext;
let admin: string;
let adminId: string;
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);
const TZ = 'Asia/Jerusalem';
const DAY = 86_400_000;
/** The zone's offset from UTC at a moment, in ms. */
const zoneOffset = (ms: number) => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')!.value;
  const m = /([+-])(\d\d):(\d\d)/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
};
/** The same wall-clock time n days on — an hour off n × 24 h when the days cross a DST change (late October). */
const daysOn = (at: string, n: number) => {
  const ms = Date.parse(at) + n * DAY;
  return ms + zoneOffset(Date.parse(at)) - zoneOffset(ms);
};
const tick = () => new Promise((r) => setTimeout(r, 30));

const addAutomation = async (title: string, recipe: RecipeInput, board = boardId) => {
  const id = newId();
  await t.db.insert(automations).values({
    id,
    accountId: acmeId,
    boardId: board,
    title,
    recipe: recipe as never,
    isActive: true,
    ownerId: adminId,
    createdBy: adminId,
  });
  return id;
};
const automationRow = async (id: string) => (await t.db.select().from(automations).where(eq(automations.id, id)))[0]!;
const deactivateAll = () => t.db.update(automations).set({ isActive: false }).where(eq(automations.accountId, acmeId));

const seen = new Set<string>();
const drain = async () => {
  for (let round = 0; round < 20; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.id);
      for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
    }
  }
};
const scheduleOf = async (automationId: string, itemId: string) =>
  (await t.db.select().from(automationSchedules).where(eq(automationSchedules.automationId, automationId))).find(
    (r) => r.itemId === itemId,
  );
const col = async (payload: Json) => body(await as().post(`/boards/${boardId}/columns`, payload));
const newItem = async (name: string) => body(await as().post(`/boards/${boardId}/items`, { name }));
const getItem = async (id: string) => body(await as().get(`/items/${id}`));
const setCell = (id: string, key: string, value: unknown) => as().put(`/items/${id}/cells/${key}`, { value });
/** What the board shows for a last-updated cell (null = empty). */
const shown = async (itemId: string, key: string): Promise<string | null> =>
  (await getItem(itemId)).cells[key]?.value?.at ?? null;

let a: Json; // watched
let b: Json; // not watched

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Deals', workspace_id: ws }))).id;
  a = await col({ title: 'Stage note', type: 'text' });
  b = await col({ title: 'Other', type: 'text' });
  await drain();
});
afterAll(() => t.close());

describe('date arrives on a last updated column of chosen columns', () => {
  let watch: Json;
  let id: string;
  let itemId: string;

  it('is offered by the API: a recipe on a last updated column saves', async () => {
    watch = await col({ title: 'Stage updated', type: 'last_updated', settings: { show_time: true, columns: [a.id] } });
    const res = await as().post(`/boards/${boardId}/automations`, {
      title: 'Stale stage',
      recipe: {
        trigger: { type: 'date_arrived', column: watch.id, offset_days: 3, time: '09:00' },
        actions: [{ type: 'archive_item' }],
      },
    });
    expect(res.status).toBe(201);
    await deactivateAll();
    await drain();
  });

  it('follows the last change of the chosen columns, not the item updated_at', async () => {
    id = await addAutomation('3 days after the stage note', {
      trigger: { type: 'date_arrived', column: watch.id, offset_days: 3, time: '09:00' },
      actions: [{ type: 'archive_item' }],
    });
    itemId = (await newItem('Deal 1')).id;
    await drain();
    // Nothing chosen changed yet: the cell is empty, so is the schedule.
    expect(await shown(itemId, watch.id)).toBeNull();
    expect(await scheduleOf(id, itemId)).toBeUndefined();

    await setCell(itemId, b.id, 'x');
    await drain();
    expect(await scheduleOf(id, itemId)).toBeUndefined();

    await tick();
    await setCell(itemId, a.id, 'qualified');
    await drain();
    const at = (await shown(itemId, watch.id))!;
    expect(at).toBeTruthy();
    // show_time: the very moment the board shows, + 3 days.
    expect((await scheduleOf(id, itemId))!.fireAt.getTime()).toBe(daysOn(at, 3));

    // A later change of another column moves the item (and the "any change" time), not this schedule.
    await tick();
    await setCell(itemId, b.id, 'y');
    await drain();
    expect(await shown(itemId, watch.id)).toBe(at);
    expect((await scheduleOf(id, itemId))!.fireAt.getTime()).toBe(daysOn(at, 3));

    // Another change of the chosen column re-arms it.
    await tick();
    await setCell(itemId, a.id, 'won');
    await drain();
    const at2 = (await shown(itemId, watch.id))!;
    expect(Date.parse(at2)).toBeGreaterThan(Date.parse(at));
    expect((await scheduleOf(id, itemId))!.fireAt.getTime()).toBe(daysOn(at2, 3));
  });

  it('fires when due, and the activation backfill computes the same time', async () => {
    const at = (await shown(itemId, watch.id))!;
    const fireAt = daysOn(at, 3);
    expect(await tickSchedules(t.db, new Date(fireAt - 60_000))).toBe(0);
    expect(await tickSchedules(t.db, new Date(fireAt + 1_000))).toBe(1);
    await drain();
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, id));
    expect(runs.map((r) => [r.itemId, r.status])).toEqual([[itemId, 'succeeded']]);

    // A fresh item, changed while the automation was off: the backfill reads the board's value.
    await deactivateAll();
    const other = (await newItem('Deal 2')).id;
    await setCell(other, a.id, 'new');
    await tick();
    await setCell(other, b.id, 'later');
    await drain();
    expect(await scheduleOf(id, other)).toBeUndefined();
    await t.db.update(automations).set({ isActive: true }).where(eq(automations.id, id));
    await syncAutomationSchedules(t.db, await automationRow(id));
    const otherAt = (await shown(other, watch.id))!;
    expect((await scheduleOf(id, other))!.fireAt.getTime()).toBe(daysOn(otherAt, 3));
    itemId = other;
  });

  it('choosing other columns re-arms the schedules from the new value', async () => {
    const before = (await scheduleOf(id, itemId))!.fireAt.getTime();
    expect(
      (await as().patch(`/boards/${boardId}/columns/${watch.id}`, { settings: { show_time: true, columns: [b.id] } }))
        .status,
    ).toBe(200);
    const at = (await shown(itemId, watch.id))!;
    const after = (await scheduleOf(id, itemId))!.fireAt.getTime();
    expect(after).toBe(daysOn(at, 3));
    expect(after).toBeGreaterThan(before); // b changed after a on this item
  });

  it('a column that watches the name moves with a rename', async () => {
    const byName = await col({
      title: 'Renamed',
      type: 'last_updated',
      settings: { show_time: true, columns: ['name'] },
    });
    const rid = await addAutomation('After a rename', {
      trigger: { type: 'date_arrives_before', column: byName.id, days: 1, time: '09:00' },
      actions: [{ type: 'archive_item' }],
    });
    await syncAutomationSchedules(t.db, await automationRow(rid));
    const before = (await scheduleOf(rid, itemId))!.fireAt.getTime();
    await tick();
    expect((await as().patch(`/items/${itemId}`, { name: 'Deal 2b' })).status).toBe(200);
    await drain();
    const at = (await shown(itemId, byName.id))!;
    const after = (await scheduleOf(rid, itemId))!.fireAt.getTime();
    expect(after).toBe(daysOn(at, -1));
    expect(after).toBeGreaterThan(before);
    await deactivateAll();
  });
});

describe('date arrives on a last updated column of any change', () => {
  it('follows every cell change, on the date the board shows, at the trigger time', async () => {
    const any = await col({ title: 'Updated', type: 'last_updated', settings: { mode: 'date' } });
    const id = await addAutomation('2 days after any change', {
      trigger: { type: 'date_arrived', column: any.id, offset_days: 2, time: '09:00' },
      actions: [{ type: 'archive_item' }],
    });
    const itemId = (await newItem('Deal 3')).id;
    await setCell(itemId, b.id, 'x');
    await drain();
    const at = (await shown(itemId, any.id))!;
    // No time shown: the local date of the change + 2 days, at 09:00 in the account timezone.
    const expected = zonedToUtc(addDays(dateInZone(new Date(at), TZ), 2), '09:00', TZ);
    expect((await scheduleOf(id, itemId))!.fireAt.toISOString()).toBe(expected.toISOString());

    // Any other cell moves it too.
    await tick();
    await setCell(itemId, a.id, 'y');
    await drain();
    const at2 = (await shown(itemId, any.id))!;
    expect(Date.parse(at2)).toBeGreaterThan(Date.parse(at));
    const expected2 = zonedToUtc(addDays(dateInZone(new Date(at2), TZ), 2), '09:00', TZ);
    expect((await scheduleOf(id, itemId))!.fireAt.toISOString()).toBe(expected2.toISOString());
    await deactivateAll();
  });

  it('a condition "more than N days ago" on the column is saved as the column itself', async () => {
    const any = (await body(await as().get(`/boards/${boardId}`))).columns.find(
      (c: Json) => c.type === 'last_updated' && !c.settings.columns,
    );
    const res = await as().post(`/boards/${boardId}/automations`, {
      title: 'Stale',
      recipe: {
        trigger: { type: 'every_time_period', period: 'day', time: '09:00', scope: 'each_item' },
        conditions: [{ column: any.id, operator: 'older_than_days', values: [3] }],
        actions: [{ type: 'archive_item' }],
      },
    });
    expect(res.status).toBe(201);
    const saved = JSON.stringify((await body(res)).recipe.conditions);
    expect(saved).toContain(`"column_id":"${any.id}"`);
    expect(saved).not.toContain('__updated_at__');
  });
});

/**
 * Conditions on a last-updated column ("more / less than N days ago") in every place that evaluates them: the
 * dispatch-time scan of a scheduled trigger (matchingItems), the run-time check (executeRun), the builder's test
 * preview, and the board filter. A computed column has no stored cell, so none of them may compile it to SQL —
 * they all read the value the board shows (prepareQuery sends a computed column to the in-memory path).
 */
describe('conditions on a last updated column (s4f follow-up)', () => {
  let board2: string;
  let g2: string;
  let watch2: Json; // last change of "A" only
  let any2: Json; // last change of any cell
  const ids: Record<'old' | 'mixed' | 'fresh', string> = { old: '', mixed: '', fresh: '' };
  const past = new Date(Date.now() - 10 * DAY);
  const cond = (column: string, operator: string) =>
    normalizeConditions([{ column, operator, values: [3] }], {
      columns: [{ key: column, title: column, type: 'last_updated' }],
    })!;
  const name = (id: string | null) => Object.entries(ids).find(([, v]) => v === id)?.[0];
  const runsWith = async (automationId: string, status: string) =>
    (await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)))
      .filter((r) => r.status === status)
      .map((r) => name(r.itemId))
      .sort();
  const notify = [{ type: 'notify' as const, to: '@board_owners', message: '{item.name}' }];

  beforeAll(async () => {
    await deactivateAll();
    const ws = (await body(await as().get('/workspaces'))).data[0].id;
    board2 = (await body(await as().post('/boards', { name: 'Conditions', workspace_id: ws }))).id;
    const c2 = async (payload: Json) => body(await as().post(`/boards/${board2}/columns`, payload));
    const na = await c2({ title: 'A', type: 'text' });
    const nb = await c2({ title: 'B', type: 'text' });
    watch2 = await c2({ title: 'A updated', type: 'last_updated', settings: { columns: [na.id] } });
    any2 = await c2({ title: 'Updated', type: 'last_updated', settings: {} });
    // New items land in the top group (the new one): the move goes to the other group.
    const top = (await body(await as().post(`/boards/${board2}/groups`, { title: 'Top' }))).id;
    g2 = (await body(await as().get(`/boards/${board2}`))).groups.find((g: Json) => g.id !== top).id;
    const mk = async (n: string) => (await body(await as().post(`/boards/${board2}/items`, { name: n }))).id as string;
    ids.old = await mk('old');
    ids.mixed = await mk('mixed');
    ids.fresh = await mk('fresh');
    // old: both columns changed 10 days ago (the item row's own updated_at stays recent).
    await setCell(ids.old, na.id, 'x');
    await setCell(ids.old, nb.id, 'x');
    // mixed: the chosen column 10 days ago, another column now.
    await setCell(ids.mixed, na.id, 'x');
    // fresh: both now.
    await setCell(ids.fresh, na.id, 'x');
    await setCell(ids.fresh, nb.id, 'x');
    await t.db
      .update(cells)
      .set({ updatedAt: past })
      .where(inArray(cells.itemId, [ids.old, ids.mixed]));
    await t.db
      .update(activityLog)
      .set({ createdAt: past })
      .where(and(inArray(activityLog.itemId, [ids.old, ids.mixed]), eq(activityLog.type, 'cell.changed')));
    await t.db.update(items).set({ lastCellChangeAt: past }).where(eq(items.id, ids.old));
    await setCell(ids.mixed, nb.id, 'now');
    await drain();
    // What the board shows.
    const shownAt = async (id: string, key: string) => Date.parse((await shown(id, key))!);
    const recent = Date.now() - DAY;
    expect(await shownAt(ids.old, watch2.id)).toBeLessThan(recent);
    expect(await shownAt(ids.old, any2.id)).toBeLessThan(recent);
    expect(await shownAt(ids.mixed, watch2.id)).toBeLessThan(recent);
    expect(await shownAt(ids.mixed, any2.id)).toBeGreaterThan(recent);
    expect(await shownAt(ids.fresh, watch2.id)).toBeGreaterThan(recent);
    // The item rows themselves were all updated just now.
    const rows = await t.db
      .select()
      .from(items)
      .where(inArray(items.id, Object.values(ids)));
    for (const r of rows) expect(r.updatedAt.getTime()).toBeGreaterThan(recent);
  });

  /** "Every day, if …" for each item: the scan at dispatch, then the run's own check. */
  const daily = async (column: string, operator: string) => {
    await deactivateAll();
    const id = await addAutomation(
      `daily ${operator}`,
      {
        trigger: { type: 'every_time_period', period: 'day', time: '09:00', scope: 'each_item' },
        conditions: cond(column, operator),
        actions: notify,
      } as RecipeInput,
      board2,
    );
    await syncAutomationSchedules(t.db, await automationRow(id));
    const row = (await t.db.select().from(automationSchedules).where(eq(automationSchedules.automationId, id)))[0]!;
    expect(await tickSchedules(t.db, new Date(row.fireAt.getTime() + 1_000))).toBe(1);
    await drain();
    // Items that do not match get no run at all (the scan filters them).
    expect(await runsWith(id, 'skipped')).toEqual([]);
    return runsWith(id, 'succeeded');
  };

  it('scheduled scan + run check: with chosen columns', async () => {
    expect(await daily(watch2.id, 'older_than_days')).toEqual(['mixed', 'old']);
    expect(await daily(watch2.id, 'newer_than_days')).toEqual(['fresh']);
  });

  it('scheduled scan + run check: without chosen columns', async () => {
    expect(await daily(any2.id, 'older_than_days')).toEqual(['old']);
    expect(await daily(any2.id, 'newer_than_days')).toEqual(['fresh', 'mixed']);
  });

  it('an event trigger checks the condition when the run executes', async () => {
    await deactivateAll();
    const mk = (column: string, operator: string) =>
      addAutomation(
        `moved ${operator}`,
        {
          trigger: { type: 'item_moved_to_group', group: 'any' },
          conditions: cond(column, operator),
          actions: notify,
        } as RecipeInput,
        board2,
      );
    const watchOld = await mk(watch2.id, 'older_than_days');
    const watchNew = await mk(watch2.id, 'newer_than_days');
    const anyOld = await mk(any2.id, 'older_than_days');
    const anyNew = await mk(any2.id, 'newer_than_days');
    // Moving an item changes no cell: the values stay as above.
    for (const id of Object.values(ids))
      expect((await as().post(`/items/${id}/move-to-group`, { group_id: g2 })).status).toBe(200);
    await drain();
    expect(await runsWith(watchOld, 'succeeded')).toEqual(['mixed', 'old']);
    expect(await runsWith(watchOld, 'skipped')).toEqual(['fresh']);
    expect(await runsWith(watchNew, 'succeeded')).toEqual(['fresh']);
    expect(await runsWith(anyOld, 'succeeded')).toEqual(['old']);
    expect(await runsWith(anyNew, 'succeeded')).toEqual(['fresh', 'mixed']);
    expect(await runsWith(anyNew, 'skipped')).toEqual(['old']);
    await deactivateAll();
  });

  it('the builder test preview agrees', async () => {
    const res = await as().post(`/boards/${board2}/automations`, {
      title: 'preview',
      recipe: {
        trigger: { type: 'item_moved_to_group', group: 'any' },
        conditions: [{ column: watch2.id, operator: 'older_than_days', values: [3] }],
        actions: notify,
      },
    });
    expect(res.status).toBe(201);
    const id = (await body(res)).id;
    const preview = async (item: string) =>
      (await body(await as().post(`/automations/${id}/test`, { item_id: item }))).conditions;
    expect((await preview(ids.old)).matched).toBe(true);
    expect((await preview(ids.mixed)).matched).toBe(true);
    expect((await preview(ids.fresh)).matched).toBe(false);
    await deactivateAll();
  });

  it('the board filter (server query) reads the computed value too', async () => {
    const query = async (column: string, operator: string) =>
      (
        (await body(await as().post(`/boards/${board2}/items/query`, { filter: cond(column, operator) })))
          .data as Json[]
      )
        .map((i) => name(i.id))
        .sort();
    expect(await query(watch2.id, 'older_than_days')).toEqual(['mixed', 'old']);
    expect(await query(watch2.id, 'newer_than_days')).toEqual(['fresh']);
    expect(await query(any2.id, 'older_than_days')).toEqual(['old']);
    expect(await query(any2.id, 'newer_than_days')).toEqual(['fresh', 'mixed']);
  });
});
