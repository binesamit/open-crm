// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** GET /boards/:id/activity filters: person, column, event type, dates, free text; before → after. */
let t: TestContext;
let admin: string;
let bob: string;
let bobId: string;
let acmeId: string;
let boardId: string;
let groupId: string;
let numCol: string;
let textCol: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const log = async (query = '', cookie = admin) => {
  const res = await as(cookie).get(`/boards/${boardId}/activity${query ? `?${query}` : ''}`);
  expect(res.status).toBe(200);
  return (await body(res)).data as Json[];
};

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  const board = await body(await as(admin).post('/boards', { name: 'Log', workspace_id: wsId }));
  boardId = board.id;
  groupId = board.groups[0].id;
  // Bob edits the board.
  const members = (await body(await as(admin).get('/users'))).data as Json[];
  bobId = members.find((m) => m.email === 'bob@acme.test')!.user_id;
  await as(admin).post(`/boards/${boardId}/members`, { user_id: bobId, role: 'editor' });
  numCol = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Amount', type: 'numbers' }))).id;
  textCol = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Notes', type: 'text' }))).id;

  const apple = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Apple', group_id: groupId }));
  await as(admin).put(`/items/${apple.id}/cells/${numCol}`, { value: 5 });
  await as(admin).put(`/items/${apple.id}/cells/${numCol}`, { value: 9 });
  await as(admin).patch(`/items/${apple.id}`, { name: 'Apple pie' });
  const banana = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Banana', group_id: groupId }));
  await as(bob).put(`/items/${banana.id}/cells/${textCol}`, { value: 'ripe and yellow' });
});
afterAll(() => t.close());

describe('board activity filters', () => {
  it('without filters: every event, each with its value before and after', async () => {
    const all = await log();
    expect(all.length).toBeGreaterThanOrEqual(6);
    const change = all.find((e) => e.type === 'cell.changed' && e.column_id === numCol && e.after?.value === 9)!;
    expect(change.before).toEqual({ value: 5 });
    const rename = all.find((e) => e.type === 'item.renamed')!;
    expect(rename).toMatchObject({ before: { name: 'Apple' }, after: { name: 'Apple pie' } });
  });

  it('by person', async () => {
    const byBob = await log(`actor_id=${bobId}`);
    expect(byBob.length).toBeGreaterThan(0);
    expect(byBob.every((e) => e.actor?.id === bobId)).toBe(true);
    expect(byBob.some((e) => e.column_id === textCol)).toBe(true);
    // Nobody-by-hand events: none here.
    expect(await log('actor_id=system')).toEqual([]);
  });

  it('by column', async () => {
    const num = await log(`column=${numCol}`);
    // Its two changes (and the column's own events, e.g. created).
    expect(num.filter((e) => e.type === 'cell.changed')).toHaveLength(2);
    expect(num.every((e) => e.column_id === numCol)).toBe(true);
    expect(num.some((e) => e.column_id === textCol)).toBe(false);
  });

  it('by event type (one or several)', async () => {
    expect((await log('type=item.renamed')).map((e) => e.type)).toEqual(['item.renamed']);
    const two = await log('type=item.renamed,item.created');
    expect(new Set(two.map((e) => e.type))).toEqual(new Set(['item.renamed', 'item.created']));
    expect(two).toHaveLength(3);
  });

  it('by date range (inclusive days, UTC)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect((await log(`from=${today}&to=${today}`)).length).toBe((await log()).length);
    expect(await log('from=2001-01-01&to=2001-01-31')).toEqual([]);
    // An older event shows only in its own days.
    const oldId = (await log('type=item.created')).at(-1)!.id;
    await t.db.execute(sql`update activity_log set created_at = '2020-05-10T12:00:00Z' where id = ${oldId}`);
    expect((await log('from=2020-05-10&to=2020-05-10')).map((e) => e.id)).toEqual([oldId]);
    expect((await log(`from=${today}`)).map((e) => e.id)).not.toContain(oldId);
    // A range that ends before it starts is refused.
    expect((await as(admin).get(`/boards/${boardId}/activity?from=2020-05-11&to=2020-05-10`)).status).toBe(400);
    expect((await as(admin).get(`/boards/${boardId}/activity?from=10-05-2020`)).status).toBe(400);
  });

  it('by free text: item name, values, person, column — wildcards literal', async () => {
    expect((await log('q=banana')).every((e) => e.item_name === 'Banana')).toBe(true);
    expect((await log('q=banana')).length).toBeGreaterThan(0);
    expect((await log(`q=${encodeURIComponent('yellow')}`)).map((e) => e.column_id)).toEqual([textCol]);
    expect((await log('q=amount')).every((e) => e.column_id === numCol)).toBe(true);
    expect((await log('q=bob')).every((e) => e.actor?.id === bobId)).toBe(true);
    expect(await log(`q=${encodeURIComponent('%')}`)).toEqual([]);
  });

  it('filters combine', async () => {
    expect(await log(`actor_id=${bobId}&column=${numCol}`)).toEqual([]);
    expect(await log(`column=${numCol}&q=banana`)).toEqual([]);
    expect(await log(`column=${numCol}&type=cell.changed`)).toHaveLength(2);
  });
});
