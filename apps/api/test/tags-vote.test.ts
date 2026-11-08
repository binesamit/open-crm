// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 03 §3.1 tags (account-wide, created by name) and §3.11 vote (one per user, only through the vote endpoint). */
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let acmeId: string;
let betaAdmin: string;
let betaId: string;
let boardId: string;
let item1: string;
let item2: string;
let adminId: string;
let bobId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const cellOf = async (itemId: string, key: string) =>
  (await body(await t.api(admin, acmeId).get(`/items/${itemId}`))).cells[key] as Json | undefined;
const byRule = async (column_id: string, operator: string, values: unknown[]) => {
  const filter = { kind: 'group', operator: 'and', rules: [{ kind: 'rule', column_id, operator, values }] };
  const res = await t.api(admin, acmeId).post(`/boards/${boardId}/items/query`, { filter });
  return ((await body(res)).data as Json[]).map((i) => i.name);
};
const vote = (cookie: string, itemId: string, value: boolean) =>
  t.api(cookie, acmeId).post(`/items/${itemId}/cells/votes/vote`, { vote: value });

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const account = async (slug: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name: slug, slug, first_admin_email: `admin@${slug}.test` }),
      )
    ).account.id as string;
  acmeId = await account('acme');
  betaId = await account('beta');
  admin = await join('admin@acme.test');
  betaAdmin = await join('admin@beta.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  bobId = (await body(await t.api(bob).get('/auth/me'))).user.id;

  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0];
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'רעיונות', workspace_id: ws.id }))).id;
  await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, { id: 'topics', title: 'תגיות', type: 'tags' });
  await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, { id: 'votes', title: 'הצבעה', type: 'vote' });
  item1 = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'א' }))).id;
  item2 = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'ב' }))).id;
});
afterAll(() => t.close());

describe('tags', () => {
  it('creates a tag once per name (case-insensitive, # dropped) with a palette colour', async () => {
    const res = await t.api(admin, acmeId).post('/tags', { name: '#Urgent' });
    expect(res.status).toBe(201);
    const tag = await body(res);
    expect(tag).toMatchObject({ name: 'Urgent' });
    expect(tag.color).toMatch(/^[a-z_]+$/);
    const again = await body(await t.api(admin, acmeId).post('/tags', { name: 'urgent' }));
    expect(again.id).toBe(tag.id);
    expect((await body(await t.api(bob, acmeId).get('/tags'))).data.map((x: Json) => x.name)).toEqual(['Urgent']);
  });

  it('a cell takes tag ids or names; names become account tags; text = names', async () => {
    const urgent = (await body(await t.api(admin, acmeId).get('/tags'))).data[0];
    const res = await t.api(bob, acmeId).put(`/items/${item1}/cells/topics`, {
      value: { tag_ids: [urgent.id], tags: ['לקוח', 'urgent'] },
    });
    expect(res.status).toBe(200);
    const c = await cellOf(item1, 'topics');
    const all = (await body(await t.api(admin, acmeId).get('/tags'))).data as Json[];
    expect(all.map((x) => x.name).sort()).toEqual(['Urgent', 'לקוח'].sort());
    const client = all.find((x) => x.name === 'לקוח')!;
    expect(c?.value).toEqual({ tag_ids: [urgent.id, client.id] });
    expect(c?.text).toBe('Urgent, לקוח');
  });

  it('filters by tag id and clears with an empty list', async () => {
    const client = ((await body(await t.api(admin, acmeId).get('/tags'))).data as Json[]).find(
      (x) => x.name === 'לקוח',
    )!;
    expect(await byRule('topics', 'any_of', [client.id])).toEqual(['א']);
    await t.api(admin, acmeId).put(`/items/${item2}/cells/topics`, { value: { tags: ['x'] } });
    await t.api(admin, acmeId).put(`/items/${item2}/cells/topics`, { value: { tag_ids: [] } });
    expect(await cellOf(item2, 'topics')).toBeUndefined();
  });

  it('rejects unknown ids and tags of another account; guests and viewers cannot create tags', async () => {
    const betaTag = await body(await t.api(betaAdmin, betaId).post('/tags', { name: 'beta' }));
    const res = await t.api(admin, acmeId).put(`/items/${item2}/cells/topics`, { value: { tag_ids: [betaTag.id] } });
    expect(res.status).toBe(422);
    expect((await t.api(vera, acmeId).post('/tags', { name: 'nope' })).status).toBe(403);
    expect((await body(await t.api(admin, acmeId).get('/tags'))).data.map((x: Json) => x.name)).not.toContain('beta');
  });
});

describe('tags in search (Ctrl+B)', () => {
  it('finds items by tag name, `#name` only through tags columns, and lists the tags', async () => {
    await t.api(admin, acmeId).patch(`/items/${item2}`, { name: 'Urgent call' }); // a name, not a tag
    const plain = await body(await t.api(admin, acmeId).get('/search?q=urgent'));
    expect(plain.items.map((i: Json) => i.name).sort()).toEqual(['Urgent call', 'א']);
    expect(plain.tags.map((x: Json) => x.name)).toEqual(['Urgent']);
    const byTag = await body(await t.api(admin, acmeId).get(`/search?q=${encodeURIComponent('#urg')}`));
    expect(byTag.items.map((i: Json) => i.name)).toEqual(['א']);
    expect(byTag.items[0].matched).toContain('Urgent');
    expect(byTag.boards).toEqual([]);
    await t.api(admin, acmeId).patch(`/items/${item2}`, { name: 'ב' });
  });

  it('finds tagged items by the tag itself (fix2): without cell text, the exact tag first, `#tag` lists more', async () => {
    // Imported / older cells may have no derived text: the tag id still finds the item.
    await t.db.execute(sql`update cells set text_value = null where item_id = ${item1}`);
    const named = (await body(await t.api(admin, acmeId).post(`/boards/${boardId}/items`, { name: 'Urgent memo' })))
      .id as string;
    const plain = await body(await t.api(admin, acmeId).get('/search?q=Urgent'));
    expect(plain.items.map((i: Json) => i.name)).toEqual(['א', 'Urgent memo']);
    expect(plain.items[0]).toMatchObject({ id: item1, matched: '#Urgent' });
    const byTag = await body(await t.api(admin, acmeId).get(`/search?q=${encodeURIComponent('#Urgent')}`));
    expect(byTag.items.map((i: Json) => i.id)).toEqual([item1]);
    // Bob (a member, the board is open to him) sees the same.
    expect((await body(await t.api(bob, acmeId).get('/search?q=%23Urgent'))).items.map((i: Json) => i.id)).toEqual([
      item1,
    ]);
    await t.api(admin, acmeId).del(`/items/${named}`);
  });
});

describe('vote', () => {
  it('one vote per user, counted; voting twice changes nothing', async () => {
    expect((await vote(bob, item1, true)).status).toBe(200);
    await vote(bob, item1, true);
    const res = await vote(admin, item1, true);
    const dto = await body(res);
    expect(dto.cells.votes).toEqual({ value: { voter_ids: [bobId, adminId] }, text: '2' });
  });

  it('takes a vote back; the last one clears the cell', async () => {
    await vote(bob, item1, false);
    expect((await cellOf(item1, 'votes'))?.value).toEqual({ voter_ids: [adminId] });
    await vote(admin, item1, false);
    expect(await cellOf(item1, 'votes')).toBeUndefined();
  });

  it('sorts and filters by the count', async () => {
    await vote(bob, item2, true);
    expect(await byRule('votes', 'greater_than', [0])).toEqual(['ב']);
  });

  it('is written only through the vote endpoint; viewers cannot vote', async () => {
    const put = await t.api(admin, acmeId).put(`/items/${item1}/cells/votes`, { value: { voter_ids: [adminId] } });
    expect(put.status).toBe(422);
    expect((await vote(vera, item1, true)).status).toBe(403);
    expect((await t.api(admin, acmeId).post(`/items/${item1}/cells/topics/vote`, { vote: true })).status).toBe(404);
  });

  it('a duplicated item starts with no votes', async () => {
    const copy = await body(await t.api(admin, acmeId).post(`/items/${item2}/duplicate`, {}));
    expect(copy.cells?.votes).toBeUndefined();
  });
});
