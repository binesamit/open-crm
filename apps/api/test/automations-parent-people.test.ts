// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, automationRuns, automations, notifications } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * "when a subitem's status changes → notify <a people column of the PARENT's board>" found nobody
 * (the engine read the subitem's cells). The recipients of notify / send_email / assign now come from the parent's
 * cell when the column is the parent board's; the save-time check and the title say so.
 */
let t: TestContext;
let admin: string;
let adminId: string;
let bobId: string;
let acmeId: string;
let boardId: string;
let subBoardId: string;
let parentId: string;
let subId: string;
let manager: string;
let clientMail: string;
let budget: string;
let subStatus: string;
let subOwner: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const userId = async (cookie: string) => (await body(await t.api(cookie).get('/auth/me'))).user.id as string;

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
const runsOf = (automationId: string) =>
  t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
const setCell = (id: string, key: string, value: unknown) => as().put(`/items/${id}/cells/${key}`, { value });
const create = (recipe: Json) => as().post(`/boards/${boardId}/automations`, { recipe });
const off = (id: string) => as().post(`/automations/${id}/deactivate`, {});
/** The status cell set to the sub-board status column's n-th label. */
const statusTo = async (n: number, itemId = subId) => {
  const cols = (await body(await as().get(`/boards/${subBoardId}`))).columns as Json[];
  const labels = cols.find((x) => x.id === subStatus)!.settings.labels as Json[];
  expect((await setCell(itemId, subStatus, { index: labels[n]!.id })).status).toBe(200);
};
/** An automation inserted directly (email actions are a plan feature; a recipe the save-time check refuses). */
const insert = async (title: string, recipe: Json) => {
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
const automationNotes = (itemId: string) =>
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
  adminId = await userId(admin);
  await as().post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bobId = await userId(await join('bob@acme.test'));
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Projects', workspace_id: wsId }))).id;
  manager = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'מנהל', type: 'people' }))).id;
  clientMail = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'Client', type: 'email' }))).id;
  budget = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'Budget', type: 'numbers' }))).id;
  parentId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Tower' }))).id;
  subId = (await body(await as().post(`/items/${parentId}/subitems`, { name: 'Foundations' }))).id;
  subBoardId = (await body(await as().get(`/items/${subId}`))).board_id;
  const subCols = (await body(await as().get(`/boards/${subBoardId}`))).columns as Json[];
  subStatus = subCols.find((c) => c.type === 'status')!.id;
  subOwner = subCols.find((c) => c.type === 'people')!.id;
  await setCell(parentId, manager, { persons_and_teams: [{ id: bobId, kind: 'person' }] });
  await setCell(parentId, clientMail, { email: 'client@outside.test', text: 'Client' });
  await drain(); // setup events: nothing listens yet
});
afterAll(() => t.close());

describe('subitem triggers → people columns of the parent board', () => {
  it('notify: a subitem status change notifies the parent’s people column; the title names the parent board', async () => {
    const res = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
      actions: [{ type: 'notify', to: `column:${manager}`, message: '{item.name} changed' }],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    expect(a.title).toContain('מנהל');
    expect(a.title).toContain('Projects');
    await statusTo(0);
    await drain();
    const [run] = await runsOf(a.id);
    expect(run).toMatchObject({ status: 'succeeded' });
    const rows = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.itemId, subId), eq(notifications.type, 'automation')));
    expect(rows.map((r) => r.userId)).toEqual([bobId]);
    await off(a.id);
  });

  it('send_email: the parent’s people column and the parent’s email column are recipients', async () => {
    const id = newId();
    // Inserted directly: email actions are a plan feature (plan-features.test.ts covers that gate).
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 'Mail',
      recipe: {
        trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
        actions: [
          {
            type: 'send_email',
            to: [`column:${manager}`, `column:${clientMail}`],
            subject: 'S: {item.name}',
            body_html: 'B',
          },
        ],
      } as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    await statusTo(1);
    await drain();
    expect(t.lastMailTo('bob@acme.test').subject).toBe('S: Foundations');
    expect(t.lastMailTo('client@outside.test').subject).toBe('S: Foundations');
    await off(id);
  });

  it('assign: the parent’s manager is assigned to the subitem', async () => {
    const res = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
      actions: [{ type: 'assign', column: subOwner, who: `column:${manager}` }],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    await statusTo(2);
    await drain();
    const sub = await body(await as().get(`/items/${subId}`));
    expect(sub.cells[subOwner].value.persons_and_teams).toEqual([{ id: bobId, kind: 'person' }]);
    await off(a.id);
  });

  it('save-time checks: a column on neither board, or not a people column, is refused', async () => {
    const missing = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
      actions: [{ type: 'notify', to: 'column:nope', message: 'x' }],
    });
    expect(missing.status).toBe(422);
    expect((await body(missing)).error.details.issues[0]).toMatchObject({
      path: 'actions.0.to',
      code: 'column_not_found',
    });
    const notPeople = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
      actions: [{ type: 'notify', to: ['@actor', `column:${budget}`], message: 'x' }],
    });
    expect(notPeople.status).toBe(422);
    expect((await body(notPeople)).error.details.issues[0]).toMatchObject({
      path: 'actions.0.to.1',
      code: 'not_a_people_column',
    });
  });
});

/**
 * Prod (depth 2): the run item is a sub-subitem — its parent is a subitem on the same sub-board (no such
 * column), so the engine climbs on to the board item whose board has the column. `{parent.*}` stays the direct parent.
 */
describe('sub-subitem triggers → people columns of the board item two levels up', () => {
  let subSubId: string;
  beforeAll(async () => {
    subSubId = (await body(await as().post(`/items/${subId}/subitems`, { name: 'Rebar' }))).id;
    await drain();
  });

  it('notify: a sub-subitem status change notifies the main item’s people column; {parent.*} is the subitem', async () => {
    const res = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any', level: 'sub_subitem' },
      actions: [{ type: 'notify', to: `column:${manager}`, message: '{item.name} of {parent.name}' }],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    await statusTo(0, subSubId);
    await drain();
    const [run] = await runsOf(a.id);
    expect(run).toMatchObject({ status: 'succeeded' });
    expect((run!.actionsLog as Json[])[0]).toMatchObject({ type: 'notify', status: 'ok' });
    const rows = await automationNotes(subSubId);
    expect(rows.map((r) => r.userId)).toEqual([bobId]);
    expect(JSON.stringify(rows[0]!.payload)).toContain('Rebar of Foundations');
    await off(a.id);
  });

  it('send_email (any level): the main item’s people and email columns are recipients', async () => {
    const id = await insert('Mail 2', {
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
      actions: [
        {
          type: 'send_email',
          to: [`column:${manager}`, `column:${clientMail}`],
          subject: 'D2: {item.name}',
          body_html: 'B',
        },
      ],
    });
    await statusTo(1, subSubId);
    await drain();
    expect(t.lastMailTo('bob@acme.test').subject).toBe('D2: Rebar');
    expect(t.lastMailTo('client@outside.test').subject).toBe('D2: Rebar');
    await off(id);
  });

  it('assign: the main item’s manager is assigned to the sub-subitem', async () => {
    const res = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any', level: 'sub_subitem' },
      actions: [{ type: 'assign', column: subOwner, who: `column:${manager}` }],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    await statusTo(2, subSubId);
    await drain();
    const item = await body(await as().get(`/items/${subSubId}`));
    expect(item.cells[subOwner].value.persons_and_teams).toEqual([{ id: bobId, kind: 'person' }]);
    await off(a.id);
  });

  it('depth 1 still reads the direct parent', async () => {
    const res = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any', level: 'subitem' },
      actions: [{ type: 'notify', to: `column:${manager}`, message: 'depth one' }],
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    await statusTo(0, subId);
    await drain();
    const [run] = await runsOf(a.id);
    expect((run!.actionsLog as Json[])[0]).toMatchObject({ type: 'notify', status: 'ok' });
    expect(
      (await automationNotes(subId))
        .filter((r) => JSON.stringify(r.payload).includes('depth one'))
        .map((r) => r.userId),
    ).toEqual([bobId]);
    await off(a.id);
  });

  it('a column on no ancestor’s board → nobody_assigned (never an error)', async () => {
    const id = await insert('Nobody', {
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
      actions: [{ type: 'notify', to: 'column:nope', message: 'x' }],
    });
    await statusTo(0, subSubId);
    await drain();
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.actionsLog as Json[])[0]).toMatchObject({
      type: 'notify',
      status: 'skipped',
      reason: 'nobody_assigned',
    });
    await off(id);
  });

  it('a fixed person who is no member here → no_recipients (a real problem)', async () => {
    const id = await insert('Gone', {
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any' },
      actions: [{ type: 'notify', to: 'user:01ZZZZZZZZZZZZZZZZZZZZZZZZ', message: 'x' }],
    });
    await statusTo(1, subSubId);
    await drain();
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect((runs[0]!.actionsLog as Json[])[0]).toMatchObject({
      type: 'notify',
      status: 'skipped',
      reason: 'no_recipients',
    });
    await off(id);
  });

  it('save-time check: a sub-subitem trigger may name the board’s people column', async () => {
    const ok = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any', level: 'sub_subitem' },
      actions: [{ type: 'notify', to: `column:${manager}`, message: 'x' }],
    });
    expect(ok.status).toBe(201);
    await off((await body(ok)).id);
    const bad = await create({
      trigger: { type: 'subitem_status_changed', column: subStatus, labels: 'any', level: 'sub_subitem' },
      actions: [{ type: 'notify', to: `column:${budget}`, message: 'x' }],
    });
    expect(bad.status).toBe(422);
    expect((await body(bad)).error.details.issues[0]).toMatchObject({ code: 'not_a_people_column' });
  });
});
