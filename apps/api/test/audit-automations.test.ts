// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type RecipeInput } from '@bines/shared';
import { activityLog, automationRuns, automations, automationSchedules, items, notifications } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { syncAutomationSchedules, tickSchedules } from '../src/modules/automations/engine/schedules';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Audit 2026-10-10, automations round 2: #4 a paused period trigger, #6 `@actor` across a chain, #7 the creator of
 * an automation's item, #8 a no-op `set_column`.
 */
let t: TestContext;
let admin: string;
let bob: string;
let adminId: string;
let bobId: string;
let acmeId: string;
let boardId: string;
let statusKey: string;
let textKey: string;
let dateKey: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie = admin) => t.api(cookie, acmeId);

const addAutomation = async (title: string, recipe: RecipeInput) => {
  const id = newId();
  await t.db.insert(automations).values({
    id,
    accountId: acmeId,
    boardId,
    title,
    recipe: recipe as never,
    isActive: true,
    ownerId: adminId,
    createdBy: adminId,
  });
  return id;
};
const deactivateAll = () => t.db.update(automations).set({ isActive: false }).where(eq(automations.accountId, acmeId));
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
const newItem = async (name: string, cells: Json = {}) =>
  body(await as().post(`/boards/${boardId}/items`, { name, cells }));
const notificationsOf = (itemId: string) =>
  t.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.itemId, itemId), eq(notifications.type, 'automation')));

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
  await as().post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Audit', workspace_id: wsId }))).id;
  for (const [title, type] of [
    ['סטטוס', 'status'],
    ['טקסט', 'text'],
    ['תאריך', 'date'],
  ])
    await as().post(`/boards/${boardId}/columns`, { title, type });
  const board = await body(await as().get(`/boards/${boardId}`));
  statusKey = board.columns.find((c: Json) => c.type === 'status').id;
  textKey = board.columns.find((c: Json) => c.type === 'text').id;
  dateKey = board.columns.find((c: Json) => c.type === 'date').id;
  await drain();
});
afterAll(() => t.close());

describe('audit 2026-10-10 — automations round 2', () => {
  it('#4 a daily trigger re-enabled after a pause is armed for the next moment, not the one that passed', async () => {
    const id = await addAutomation('Daily', {
      trigger: { type: 'every_time_period', period: 'day', time: '09:00' },
      actions: [{ type: 'notify', to: '@board_owners', message: 'בוקר' }],
    });
    const row = (await t.db.select().from(automations).where(eq(automations.id, id)))[0]!;
    await syncAutomationSchedules(t.db, row, new Date('2099-03-02T06:00:00Z'));
    const scheduleOf = async () =>
      (
        await t.db
          .select()
          .from(automationSchedules)
          .where(and(eq(automationSchedules.automationId, id), isNull(automationSchedules.itemId)))
      )[0]!;
    expect((await scheduleOf()).fireAt.toISOString()).toBe('2099-03-02T07:00:00.000Z'); // 09:00 Jerusalem
    // Paused for two days: the moment passed while the row kept `fired_at = null`. Re-enabled at 13:30 on the 4th:
    // the same hash, so it used to return early and fire a minute later. Now it is re-armed for the 5th.
    await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
    await t.db.update(automations).set({ isActive: true }).where(eq(automations.id, id));
    await syncAutomationSchedules(t.db, row, new Date('2099-03-04T10:30:00Z'));
    expect((await scheduleOf()).fireAt.toISOString()).toBe('2099-03-05T07:00:00.000Z');
    expect((await scheduleOf()).firedAt).toBeNull();
    await deactivateAll();
  });

  it('#6 `@actor` across a chain is the person who started it, not the previous automation’s owner', async () => {
    const board = await body(await as().get(`/boards/${boardId}`));
    const labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels as Json[];
    const done = labels.find((l) => l.is_done)!;
    const first = await addAutomation('A: status → date', {
      trigger: { type: 'status_changed', column: statusKey, labels: [done.label] },
      actions: [{ type: 'set_date', column: dateKey, value: 'today' }],
    });
    const second = await addAutomation('B: date → notify actor', {
      trigger: { type: 'column_changed', column: dateKey },
      actions: [{ type: 'notify', to: '@actor', message: 'התאריך השתנה: {item.name}' }],
    });
    const item = await newItem('Chain');
    await drain();
    // Bob (a member, not the automations' owner) changes the status.
    expect((await as(bob).put(`/items/${item.id}/cells/${statusKey}`, { value: { index: done.id } })).status).toBe(200);
    await drain();
    expect((await runsOf(first)).map((r) => [r.status, r.skipReason, r.error])).toEqual([['succeeded', null, null]]);
    expect((await runsOf(second)).map((r) => [r.status, r.skipReason, r.error])).toEqual([['succeeded', null, null]]);
    const rows = await notificationsOf(item.id);
    expect(rows.map((r) => r.userId)).toEqual([bobId]); // used to be [adminId]
    expect(rows.map((r) => r.userId)).not.toContain(adminId);
    await deactivateAll();
  });

  it('#7 an item an automation creates is the automation’s, not its owner’s', async () => {
    const id = await addAutomation('Clone', {
      trigger: { type: 'item_created' },
      actions: [{ type: 'create_item', board: boardId, name: 'נוצר על ידי אוטומציה: {item.name}' }],
    });
    const item = await newItem('Origin');
    await drain();
    expect((await runsOf(id)).map((r) => r.status)).toEqual(['succeeded']);
    const made = (await t.db.select().from(items).where(eq(items.boardId, boardId))).find(
      (i) => i.name === 'נוצר על ידי אוטומציה: Origin',
    );
    expect(made).toBeDefined();
    expect(made!.creatorType).toBe('automation');
    expect((await t.db.select().from(items).where(eq(items.id, item.id)))[0]!.creatorType).toBe('user');
    await deactivateAll();
  });

  it('#8 `set_column` with the value already there is a skip, and `column_changed` stays quiet', async () => {
    const setter = await addAutomation('Set x', {
      trigger: { type: 'item_created' },
      actions: [{ type: 'set_column', column: textKey, value: 'x' }],
    });
    const listener = await addAutomation('On text', {
      trigger: { type: 'column_changed', column: textKey },
      actions: [{ type: 'notify', to: '@board_owners', message: 'טקסט: {item.name}' }],
    });
    const already = await newItem('Already x', { [textKey]: 'x' });
    const fresh = await newItem('Fresh');
    await drain();
    const setRuns = await runsOf(setter);
    expect(setRuns.find((r) => r.itemId === already.id)).toMatchObject({ status: 'skipped' });
    expect((setRuns.find((r) => r.itemId === already.id)!.actionsLog as Json[])[0]).toMatchObject({
      status: 'skipped',
      reason: 'unchanged',
    });
    expect(setRuns.find((r) => r.itemId === fresh.id)).toMatchObject({ status: 'succeeded' });
    // The listener heard the real change only (the item created with x: the creation's cell event is no change).
    // The listener heard each real change once: the creation with x (a cell event from empty to x) for the first
    // item, the automation's write for the second — never the no-op write.
    const heard = (await runsOf(listener)).map((r) => r.itemId);
    expect(heard.filter((x) => x === already.id)).toHaveLength(1);
    expect(heard.filter((x) => x === fresh.id)).toHaveLength(1);
    expect(await notificationsOf(already.id)).toHaveLength(1);
    expect(await notificationsOf(fresh.id)).toHaveLength(1);
    // A no-op write by a person: no notification either.
    expect((await as().put(`/items/${fresh.id}/cells/${textKey}`, { value: 'x' })).status).toBe(200);
    await drain();
    expect(await notificationsOf(fresh.id)).toHaveLength(1);
    expect((await runsOf(listener)).map((r) => r.itemId).filter((x) => x === fresh.id)).toHaveLength(1);
    await deactivateAll();
  });
});

describe('audit 2026-10-10 — automation lows (#13, #15, #16, #17)', () => {
  it('#13 send_email is tried three times: a mailer that fails twice still delivers', async () => {
    const id = await addAutomation('Mail', {
      trigger: { type: 'item_created' },
      actions: [{ type: 'send_email', to: '@board_owners', subject: 'נוצר {item.name}', body_html: '<p>היי</p>' }],
    });
    // The transport behind `deps.mailer` (the capturing wrapper calls it per send).
    const transport = t.mailer as { send: (m: never) => Promise<void> };
    const real = transport.send;
    let calls = 0;
    transport.send = async (m) => {
      calls++;
      if (calls < 3) throw new Error('smtp down');
      return real.call(transport, m);
    };
    try {
      await newItem('Mailed');
      await drain();
    } finally {
      transport.send = real;
    }
    expect(calls).toBe(3);
    expect((await runsOf(id)).map((r) => [r.status, r.error])).toEqual([['succeeded', null]]);
    await deactivateAll();
  });

  it('#15 a period tick whose owner cannot act leaves one skipped run, not nothing', async () => {
    const id = await addAutomation('Daily orphan', {
      trigger: { type: 'every_time_period', period: 'day', time: '10:00', scope: 'each_item' },
      actions: [{ type: 'set_item_name', name: '{item.name} ✓' }],
    });
    await newItem('Orphaned');
    await drain();
    // The owner is no member of the account (the platform owner here): the automation cannot act for them.
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const ownerId = (await body(await t.api(owner).get('/auth/me'))).user.id as string;
    await t.db.update(automations).set({ ownerId }).where(eq(automations.id, id));
    const row = (await t.db.select().from(automations).where(eq(automations.id, id)))[0]!;
    await syncAutomationSchedules(t.db, row, new Date('2099-04-01T00:00:00Z'));
    expect(await tickSchedules(t.db, new Date('2099-04-01T08:00:10Z'))).toBe(1);
    await drain();
    expect((await runsOf(id)).map((r) => [r.status, r.skipReason, r.itemId])).toEqual([
      ['skipped', 'owner_inactive', null],
    ]);
    await deactivateAll();
  });

  it('#16 `who: @creator` fires only when the creator is assigned (resolved on the item by the runner)', async () => {
    await as().post(`/boards/${boardId}/columns`, { title: 'אחראי', type: 'people' });
    const board = await body(await as().get(`/boards/${boardId}`));
    const peopleKey = board.columns.find((c: Json) => c.type === 'people').id;
    const id = await addAutomation('Creator assigned', {
      trigger: { type: 'person_assigned', column: peopleKey, who: '@creator' },
      actions: [{ type: 'notify', to: '@board_owners', message: 'היוצר שובץ: {item.name}' }],
    });
    // Bob creates the item; the admin assigns themself (no), then Bob (yes).
    const item = await body(await as(bob).post(`/boards/${boardId}/items`, { name: 'By Bob' }));
    await drain();
    const assign = (ids: string[]) =>
      as().put(`/items/${item.id}/cells/${peopleKey}`, {
        value: { persons_and_teams: ids.map((x) => ({ id: x, kind: 'person' })) },
      });
    expect((await assign([adminId])).status).toBe(200);
    await drain();
    expect((await runsOf(id)).map((r) => [r.status, r.skipReason])).toEqual([['skipped', 'who_mismatch']]);
    expect((await assign([adminId, bobId])).status).toBe(200);
    await drain();
    expect((await runsOf(id)).map((r) => [r.status, r.skipReason])).toEqual([
      ['skipped', 'who_mismatch'],
      ['succeeded', null],
    ]);
    await deactivateAll();
  });

  it('#17 create_subitem writes the subitem with its cells in one go: no separate cell events', async () => {
    // The sub-board exists once a subitem does; give it a text column for the automation to fill.
    const parent = await newItem('Parent');
    const first = await body(await as().post(`/items/${parent.id}/subitems`, { name: 'First' }));
    const subBoardId = (await body(await as().get(`/items/${first.id}`))).board_id as string;
    await as().post(`/boards/${subBoardId}/columns`, { title: 'הערה', type: 'text' });
    const subText = (await body(await as().get(`/boards/${subBoardId}`))).columns.find((c: Json) => c.type === 'text')
      .id as string;
    await drain();
    const id = await addAutomation('Subitem with cells', {
      trigger: { type: 'item_created' },
      actions: [{ type: 'create_subitem', name: 'משימה של {item.name}', fixed: { [subText]: 'מוכן' } }],
    });
    const item = await newItem('With sub');
    await drain();
    expect((await runsOf(id)).map((r) => [r.status, r.error])).toEqual([['succeeded', null]]);
    const made = (await t.db.select().from(items).where(eq(items.parentItemId, item.id)))[0]!;
    expect(made.name).toBe('משימה של With sub');
    expect((await body(await as().get(`/items/${made.id}`))).cells[subText]).toMatchObject({ value: 'מוכן' });
    // One transaction, one batch: the creation and its cell carry the same batch id (used to be a second write
    // with its own batch, so `subitem_created` saw an empty subitem and the cell fired on its own).
    const events = await t.db
      .select({ type: activityLog.type, batchId: activityLog.batchId })
      .from(activityLog)
      .where(and(eq(activityLog.itemId, made.id), eq(activityLog.accountId, acmeId)));
    expect(events.map((e) => e.type).sort()).toEqual(['cell.changed', 'item.created']);
    expect(events[0]!.batchId).toBeTruthy();
    expect(new Set(events.map((e) => e.batchId)).size).toBe(1);
    await deactivateAll();
  });
});
