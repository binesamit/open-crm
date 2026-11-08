// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type RecipeInput } from '@bines/shared';
import { activityLog, automationRuns, automations, automationSchedules, notifications } from '../src/db/schema';
import { failStaleRuns, STALE_RUN_MS } from '../src/modules/automations/automations.repo';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { syncAutomationSchedules, tickSchedules } from '../src/modules/automations/engine/schedules';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M6 stage 2 — the engine end to end: activity row → dispatch → run → actions through the services. */
let t: TestContext;
let admin: string;
let adminId: string;
let acmeId: string;
let boardId: string;
let otherBoardId: string;
let groups: { id: string; title: string }[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

let statusKey: string;
let dateKey: string;
let peopleKey: string;
const labelIndex = (board: Json, text: string) =>
  board.columns.find((c: Json) => c.id === statusKey).settings.labels.find((l: Json) => l.label === text).id;

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
const deactivateAll = () => t.db.update(automations).set({ isActive: false }).where(eq(automations.accountId, acmeId));

/** Dispatches every activity row not seen yet and runs what it causes — repeatedly, so chains play out. */
const seen = new Set<string>();
const drain = async () => {
  const runs: string[] = [];
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
      for (const runId of await dispatchEvent(t.deps, r.id)) {
        runs.push(runId);
        await executeRun(t.deps, runId);
      }
    }
  }
  return runs;
};
const runsOf = (automationId: string) =>
  t.db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(asc(automationRuns.createdAt));
const newItem = async (name: string, board = boardId) => body(await as().post(`/boards/${board}/items`, { name }));
const getItem = async (id: string) => body(await as().get(`/items/${id}`));
const setCell = (id: string, key: string, value: unknown) => as().put(`/items/${id}/cells/${key}`, { value });

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
  admin = await join('admin@acme.test');
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  otherBoardId = (await body(await as().post('/boards', { name: 'Tasks', workspace_id: wsId }))).id;
  for (const b of [boardId, otherBoardId])
    for (const [title, type] of [
      ['סטטוס', 'status'],
      ['תאריך', 'date'],
      ['אחראי', 'people'],
    ])
      await as().post(`/boards/${b}/columns`, { title, type });
  await as().post(`/boards/${boardId}/groups`, { title: 'סגורים' });
  const board = await body(await as().get(`/boards/${boardId}`));
  statusKey = board.columns.find((c: Json) => c.type === 'status').id;
  dateKey = board.columns.find((c: Json) => c.type === 'date').id;
  peopleKey = board.columns.find((c: Json) => c.type === 'people').id;
  groups = board.groups;
  expect(groups.length).toBeGreaterThan(1);
  await drain(); // setup events: nothing listens yet
});
afterAll(() => t.close());

describe('automation engine (04 §5)', () => {
  it('status changes → move to group + set date, written as the automation', async () => {
    const board = await body(await as().get(`/boards/${boardId}`));
    const doneLabel = board.columns
      .find((c: Json) => c.id === statusKey)
      .settings.labels.find((l: Json) => l.is_done).label;
    const target = groups[groups.length - 1]!;
    const id = await addAutomation('Done → closed', {
      trigger: { type: 'status_changed', column: statusKey, labels: [doneLabel] },
      actions: [
        { type: 'move_to_group', group: target.id },
        { type: 'set_date', column: dateKey, value: 'today+3d' },
      ],
    });
    const item = await newItem('Lead A');
    expect((await setCell(item.id, statusKey, { index: labelIndex(board, doneLabel) })).status).toBe(200);
    await drain();

    const after = await getItem(item.id);
    expect(after.group_id).toBe(target.id);
    expect(after.cells[dateKey].value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'succeeded', depth: 1, itemId: item.id });
    expect(run!.actionsLog).toMatchObject([
      { type: 'move_to_group', status: 'ok' },
      { type: 'set_date', status: 'ok' },
    ]);
    // The automation's own writes carry its identity (migration 0017 trigger).
    const moved = (
      await t.db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.itemId, item.id), eq(activityLog.type, 'item.moved_to_group')))
    )[0]!;
    expect(moved).toMatchObject({ actorType: 'automation', automationId: id });
    expect((moved.payload.meta as Json).automation).toMatchObject({ automation_id: id, run_id: run!.id, depth: 1 });
    await deactivateAll();
  });

  it('item created → set status + assign the creator; template names resolve', async () => {
    const board = await body(await as().get(`/boards/${boardId}`));
    const first = board.columns.find((c: Json) => c.id === statusKey).settings.labels[0].label;
    await addAutomation('New lead', {
      trigger: { type: 'item_created' },
      actions: [
        { type: 'set_status', column: statusKey, label: first },
        { type: 'assign', column: peopleKey, who: '@creator' },
        { type: 'set_item_name', name: 'ליד: {item.name}' },
      ],
    });
    const item = await newItem('Dana');
    await drain();
    const after = await getItem(item.id);
    expect(after.name).toBe('ליד: Dana');
    expect(after.cells[statusKey].text).toBe(first);
    expect(after.cells[peopleKey].value.persons_and_teams).toEqual([{ id: adminId, kind: 'person' }]);
    await deactivateAll();
  });

  it('conditions that do not match skip the run and say why', async () => {
    const id = await addAutomation('Only urgent', {
      trigger: { type: 'item_created' },
      conditions: {
        kind: 'group',
        operator: 'and',
        negate: false,
        rules: [{ kind: 'rule', column_id: 'name', operator: 'contains_text', values: ['דחוף'], negate: false }],
      },
      actions: [{ type: 'archive_item' }],
    });
    const calm = await newItem('רגיל');
    const urgent = await newItem('דחוף מאוד');
    await drain();
    const runs = await runsOf(id);
    expect(runs.find((r) => r.itemId === calm.id)).toMatchObject({ status: 'skipped', skipReason: 'conditions' });
    expect(runs.find((r) => r.itemId === urgent.id)).toMatchObject({ status: 'succeeded' });
    expect((await as().get(`/items/${urgent.id}`)).status).toBe(200); // archived items stay readable
    expect((await getItem(urgent.id)).archived_at ?? 'archived').toBeTruthy();
    await deactivateAll();
  });

  it('notify reaches the board owner even when the owner is the automation owner', async () => {
    await addAutomation('Ping', {
      trigger: { type: 'item_created' },
      actions: [{ type: 'notify', to: '@board_owners', message: 'ליד חדש: {item.name} ({board.name})' }],
    });
    const item = await newItem('Notify me');
    await drain();
    const rows = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.itemId, item.id), eq(notifications.type, 'automation')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: adminId });
    expect((rows[0]!.payload as Json).excerpt).toBe('ליד חדש: Notify me (Leads)');
    await deactivateAll();
  });

  it('an item_deleted run still has the item: notify renders its name, an update on it is skipped (audit 2026-10-10 #2)', async () => {
    const id = await addAutomation('Gone', {
      trigger: { type: 'item_deleted' },
      actions: [
        { type: 'notify', to: '@board_owners', message: 'נמחק: {item.name}' },
        { type: 'create_update', body: 'לא ייכתב' },
      ],
    });
    const item = await newItem('Short lived');
    await drain();
    expect((await as().del(`/items/${item.id}`)).status).toBe(200);
    await drain();
    const run = (await runsOf(id)).find((r) => r.itemId === item.id);
    expect(run).toBeDefined();
    // Used to be `skipped nothing_to_do`: the snapshot was null (findItem filters the trash), notify skipped `no_item`.
    expect((run!.actionsLog as Json[]).map((l) => [l.type, l.status, l.reason ?? null])).toEqual([
      ['notify', 'ok', null],
      ['create_update', 'skipped', 'item_gone'],
    ]);
    const rows = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.itemId, item.id), eq(notifications.type, 'automation')));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as Json).excerpt).toBe('נמחק: Short lived');
    await deactivateAll();
  });

  it('a run a dead worker left `running` ends as failed on the next tick (audit 2026-10-10 #3)', async () => {
    const id = await addAutomation('Stale', { trigger: { type: 'item_created' }, actions: [{ type: 'archive_item' }] });
    const stale = newId();
    const fresh = newId();
    const row = (runId: string, startedAt: Date) => ({
      id: runId,
      accountId: acmeId,
      automationId: id,
      status: 'running' as const,
      startedAt,
    });
    await t.db
      .insert(automationRuns)
      .values([row(stale, new Date(Date.now() - STALE_RUN_MS - 60_000)), row(fresh, new Date(Date.now() - 1_000))]);
    const failed = await failStaleRuns(t.db, new Date(Date.now() - STALE_RUN_MS));
    expect(failed.map((r) => r.id)).toEqual([stale]);
    const runs = await runsOf(id);
    expect(runs.find((r) => r.id === stale)).toMatchObject({ status: 'failed', error: 'stale' });
    expect(runs.find((r) => r.id === stale)!.finishedAt).toBeTruthy();
    expect(runs.find((r) => r.id === fresh)).toMatchObject({ status: 'running', finishedAt: null });
    await deactivateAll();
  });

  it('create item on another board with mapping, fixed values and a connection back', async () => {
    const rel = await body(
      await as().post(`/boards/${boardId}/columns`, {
        title: 'משימות',
        type: 'board_relation',
        settings: { board_ids: [otherBoardId] },
      }),
    );
    const other = await body(await as().get(`/boards/${otherBoardId}`));
    const otherDate = other.columns.find((c: Json) => c.type === 'date').id;
    const otherStatus = other.columns.find((c: Json) => c.type === 'status');
    const label = otherStatus.settings.labels[1].label;
    const id = await addAutomation('Make a task', {
      trigger: { type: 'item_created' },
      actions: [
        {
          type: 'create_item',
          board: otherBoardId,
          name: 'משימה — {item.name}',
          mapping: { [otherDate]: dateKey },
          fixed: { [otherStatus.id]: label },
          connect_column: rel.id,
        },
      ],
    });
    const lead = await newItem('Lead B');
    await setCell(lead.id, dateKey, { date: '2026-11-01' });
    // The create ran on item.created — before the date was set: mapping copies what the item had then.
    await drain();
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'succeeded' });
    const createdId = (run!.actionsLog as Json[])[0]!.output.item_id;
    const task = await getItem(createdId);
    expect(task).toMatchObject({ name: 'משימה — Lead B', board_id: otherBoardId });
    expect(task.cells[otherStatus.id].text).toBe(label);
    expect((await getItem(lead.id)).cells[rel.id].value.item_ids).toEqual([createdId]);
    await deactivateAll();
  });

  it('loop protection: a ping-pong chain stops when A comes back to the same item within 10 s', async () => {
    const board = await body(await as().get(`/boards/${boardId}`));
    const [l0, l1] = board.columns.find((c: Json) => c.id === statusKey).settings.labels as Json[];
    const a = await addAutomation('A', {
      trigger: { type: 'status_changed', column: statusKey, labels: [l0!.label] },
      actions: [{ type: 'set_status', column: statusKey, label: l1!.label }],
    });
    const b = await addAutomation('B', {
      trigger: { type: 'status_changed', column: statusKey, labels: [l1!.label] },
      actions: [{ type: 'set_status', column: statusKey, label: l0!.label }],
    });
    const item = await newItem('Ping-pong');
    await drain();
    await setCell(item.id, statusKey, { index: l0!.id });
    await drain();
    const all = [...(await runsOf(a)), ...(await runsOf(b))]
      .filter((r) => r.itemId === item.id)
      .sort((x, y) => x.depth - y.depth);
    expect(all.map((r) => [r.automationId, r.depth, r.status, r.skipReason])).toEqual([
      [a, 1, 'succeeded', null],
      [b, 2, 'succeeded', null],
      [a, 3, 'skipped', 'self_loop'],
    ]);
    expect(all[2]!.chain).toEqual([a, b]);
    await deactivateAll();
  });

  it('loop protection: nothing runs past depth 5', async () => {
    const id = await addAutomation('Deep', {
      trigger: { type: 'column_changed', column: 'name' },
      actions: [{ type: 'archive_item' }],
    });
    const item = await newItem('Deep');
    await drain();
    // An event written by the 5th automation of some chain.
    const eventId = newId();
    await t.db.insert(activityLog).values({
      id: eventId,
      accountId: acmeId,
      boardId,
      itemId: item.id,
      type: 'item.renamed',
      actorId: adminId,
      actorType: 'automation',
      payload: { before: { name: 'x' }, after: { name: 'Deep' }, meta: { automation: { depth: 5, chain: [] } } },
    });
    seen.add(eventId);
    expect(await dispatchEvent(t.deps, eventId)).toEqual([]);
    expect(await runsOf(id)).toMatchObject([{ status: 'skipped', skipReason: 'max_depth', depth: 6 }]);
    await deactivateAll();
  });

  it('is idempotent per event, and a broken recipe deactivates itself', async () => {
    const id = await addAutomation('Missing label', {
      trigger: { type: 'item_created' },
      actions: [{ type: 'set_status', column: statusKey, label: 'אין תווית כזו' }],
    });
    await newItem('Broken');
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'item.created')))
      .orderBy(asc(activityLog.createdAt));
    const last = rows[rows.length - 1]!.id;
    seen.add(last);
    const first = await dispatchEvent(t.deps, last);
    expect(first).toHaveLength(1);
    expect(await dispatchEvent(t.deps, last)).toEqual([]); // redelivered job: no second run
    await executeRun(t.deps, first[0]!);
    expect(await executeRun(t.deps, first[0]!)).toBeNull(); // already claimed
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: 'failed', error: 'label_not_found:אין תווית כזו' });
    const row = (await t.db.select().from(automations).where(eq(automations.id, id)))[0]!;
    expect(row).toMatchObject({ isActive: false, deactivatedReason: 'label_not_found:אין תווית כזו' });
    await drain();
  });

  it('never fires on its own writes', async () => {
    const id = await addAutomation('Rename on rename', {
      trigger: { type: 'column_changed', column: 'name' },
      actions: [{ type: 'set_item_name', name: '{item.name}!' }],
    });
    const item = await newItem('Echo');
    await drain();
    await as().patch(`/items/${item.id}`, { name: 'Echo 2' });
    await drain();
    expect((await getItem(item.id)).name).toBe('Echo 2!');
    expect(await runsOf(id)).toHaveLength(1);
    await deactivateAll();
  });

  describe('scheduled triggers (04 §5.6)', () => {
    const scheduleOf = async (automationId: string, itemId: string | null) =>
      (await t.db.select().from(automationSchedules).where(eq(automationSchedules.automationId, automationId))).find(
        (r) => r.itemId === itemId,
      );
    const automationRow = async (id: string) =>
      (await t.db.select().from(automations).where(eq(automations.id, id)))[0]!;

    it('date arrives: the row follows the cell, the tick fires it, the run acts', async () => {
      const board = await body(await as().get(`/boards/${boardId}`));
      const labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels as Json[];
      const id = await addAutomation('Due', {
        trigger: { type: 'date_arrived', column: dateKey, offset_days: 0, time: '09:00' },
        actions: [{ type: 'set_status', column: statusKey, label: labels[2]!.label }],
      });
      const item = await newItem('With a date');
      await setCell(item.id, dateKey, { date: '2099-01-10' });
      await drain();
      const row = await scheduleOf(id, item.id);
      expect(row).toMatchObject({ kind: 'date', firedAt: null });
      expect(row!.fireAt.toISOString()).toBe('2099-01-10T07:00:00.000Z'); // 09:00 Israel (winter)

      // Editing the date re-arms; clearing it removes the row.
      await setCell(item.id, dateKey, { date: '2099-02-01' });
      await drain();
      expect((await scheduleOf(id, item.id))!.fireAt.toISOString()).toBe('2099-02-01T07:00:00.000Z');

      // Not due yet: nothing fires.
      expect(await tickSchedules(t.db, new Date('2099-02-01T06:59:00Z'))).toBe(0);
      expect(await tickSchedules(t.db, new Date('2099-02-01T07:00:30Z'))).toBe(1);
      expect(await tickSchedules(t.db, new Date('2099-02-01T07:01:30Z'))).toBe(0); // fired once
      await drain();
      expect((await getItem(item.id)).cells[statusKey].text).toBe(labels[2]!.label);
      expect((await runsOf(id)).filter((r) => r.itemId === item.id)).toMatchObject([{ status: 'succeeded' }]);

      await setCell(item.id, dateKey, null);
      await drain();
      expect(await scheduleOf(id, item.id)).toBeUndefined();
      await deactivateAll();
    });

    it('a past date does not fire; archiving removes the row; activation backfills', async () => {
      const id = await addAutomation('Past', {
        trigger: { type: 'date_arrived', column: dateKey, offset_days: 0, time: '09:00' },
        actions: [{ type: 'archive_item' }],
      });
      const old = await newItem('Long ago');
      await setCell(old.id, dateKey, { date: '2020-01-01' });
      const future = await newItem('Later');
      await drain();
      expect((await scheduleOf(id, old.id))!.firedAt).not.toBeNull(); // > 24 h late: armed as already fired
      expect(await scheduleOf(id, future.id)).toBeUndefined();

      // A date written while the automation was off is picked up when it is (re)synced.
      await deactivateAll();
      await setCell(future.id, dateKey, { date: '2099-05-05' });
      await drain();
      await t.db.update(automations).set({ isActive: true }).where(eq(automations.id, id));
      await syncAutomationSchedules(t.db, await automationRow(id));
      expect(await scheduleOf(id, future.id)).toMatchObject({ firedAt: null });

      await as().post(`/items/${future.id}/archive`);
      await drain();
      expect(await scheduleOf(id, future.id)).toBeUndefined();
      await deactivateAll();
    });

    it('every day: one run per item that meets the conditions, then the row moves to tomorrow', async () => {
      const id = await addAutomation('Daily', {
        trigger: { type: 'every_time_period', period: 'day', time: '10:00', scope: 'each_item' },
        conditions: {
          kind: 'group',
          operator: 'and',
          negate: false,
          rules: [{ kind: 'rule', column_id: 'name', operator: 'contains_text', values: ['יומי'], negate: false }],
        },
        actions: [{ type: 'set_item_name', name: '{item.name} ✓' }],
      });
      const yes = await newItem('יומי א');
      const no = await newItem('אחר');
      await drain();
      await syncAutomationSchedules(t.db, await automationRow(id), new Date('2099-03-01T00:00:00Z'));
      const row = await scheduleOf(id, null);
      expect(row!.fireAt.toISOString()).toBe('2099-03-01T08:00:00.000Z');
      expect(await tickSchedules(t.db, new Date('2099-03-01T08:00:10Z'))).toBe(1);
      await drain();
      expect((await getItem(yes.id)).name).toBe('יומי א ✓');
      expect((await getItem(no.id)).name).toBe('אחר');
      const runs = await runsOf(id);
      expect(runs.map((r) => r.itemId)).toEqual([yes.id]); // conditions filtered at dispatch: no run rows for the rest
      expect(await scheduleOf(id, null)).toMatchObject({ firedAt: null });
      expect((await scheduleOf(id, null))!.fireAt.toISOString()).toBe('2099-03-02T08:00:00.000Z');
      await deactivateAll();
    });
  });
});

describe('working days in automations', () => {
  it('set_date "+1wd" skips the weekend and holidays; "N working days before" arms on a working day', async () => {
    const board = await body(await as().get(`/boards/${boardId}`));
    const doneLabel = board.columns
      .find((c: Json) => c.id === statusKey)
      .settings.labels.find((l: Json) => l.is_done).label;
    const id = await addAutomation('Done → next working day', {
      trigger: { type: 'status_changed', column: statusKey, labels: [doneLabel] },
      actions: [{ type: 'set_date', column: dateKey, value: `column:${dateKey}+1wd` }],
    });
    const item = await newItem('Working days');
    await setCell(item.id, dateKey, { date: '2026-12-31' });
    await drain();
    expect((await setCell(item.id, statusKey, { index: labelIndex(board, doneLabel) })).status).toBe(200);
    await drain();
    // Thu 31/12/2026 + 1 working day (Fri + Sat weekend) → Sun 03/01/2027.
    expect((await getItem(item.id)).cells[dateKey].value.date).toBe('2027-01-03');
    expect((await runsOf(id))[0]).toMatchObject({ status: 'succeeded' });
    await deactivateAll();

    const before = await addAutomation('1 working day before', {
      trigger: { type: 'date_arrives_before', column: dateKey, days: 1, workdays: true, time: '09:00' },
      actions: [{ type: 'archive_item' }],
    });
    const due = await newItem('Due after Yom Kippur');
    await setCell(due.id, dateKey, { date: '2026-09-22' });
    await drain();
    const row = (
      await t.db.select().from(automationSchedules).where(eq(automationSchedules.automationId, before))
    ).find((r) => r.itemId === due.id);
    // Tue 22/09: Mon 21/09 is Yom Kippur, Sun 20/09 only half a day → Thu 17/09, 09:00 Israel (06:00Z).
    expect(row!.fireAt.toISOString()).toBe('2026-09-17T06:00:00.000Z');
    await deactivateAll();
  });
});
