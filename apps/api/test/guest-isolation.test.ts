// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * 09 §10 with guests (M7): two guests invited to one shareable board on "only what they created or are
 * assigned to" — each sees only their items in list, get, query, count, search, column values, updates, SSE,
 * export; hidden = 404. What they may edit is the board's permissions (a restricted column → 403).
 */
let t: TestContext;
let admin: string;
let bob: string; // member, not subscribed to the shareable board
let g1: string;
let g2: string;
let acmeId: string;
let boardId: string;
let peopleKey: string;
let statusKey: string;
let noteKey: string;
let internalKey: string;
const item: Record<string, string> = {};
const user: Record<string, string> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const names = async (cookie: string) =>
  ((await body(await as(cookie).get(`/boards/${boardId}/items`))).data as Json[]).map((i) => i.name).sort();
const assign = (id: string) => ({ [peopleKey]: { persons_and_teams: [{ id, kind: 'person' }] } });

/** The board's SSE channel; collects event payloads. */
const openEvents = async (cookie: string) => {
  const res = await t.app.request(`/api/v1/boards/${boardId}/events?account_id=${acmeId}`, {
    headers: { origin: WEB_ORIGIN, cookie },
  });
  expect(res.status).toBe(200);
  const events: Json[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;
  void (async () => {
    while (!done) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const data = buf
          .slice(0, cut)
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        buf = buf.slice(cut + 2);
        if (data) events.push(JSON.parse(data));
      }
    }
  })();
  return {
    events,
    close: async () => {
      done = true;
      await reader.cancel().catch(() => {});
    },
  };
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');

  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  const internalId = (await body(await as(admin).post('/boards', { name: 'Internal', workspace_id: ws.id }))).id;
  const ticket = (await body(await as(admin).post(`/boards/${internalId}/items`, { name: 'secret ticket' }))).id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Requests', workspace_id: ws.id, kind: 'shareable' })))
    .id;
  const col = async (title: string, type: string, settings?: Json) =>
    (await body(await as(admin).post(`/boards/${boardId}/columns`, { title, type, settings }))).id as string;
  peopleKey = await col('Person', 'people');
  internalKey = await col('Internal ticket', 'board_relation', { board_ids: [internalId] });
  statusKey = await col('Status', 'status');
  noteKey = await col('Note', 'text');
  await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'assigned_or_created' } });

  // Guests are invited to the board — nothing else.
  for (const email of ['g1@one.test', 'g2@two.test']) {
    const res = await as(admin).post('/users/invite', { emails: [email], role: 'guest', board_ids: [boardId] });
    expect(res.status).toBe(200);
  }
  g1 = await join('g1@one.test');
  g2 = await join('g2@two.test');
  for (const u of (await body(await as(admin).get('/users'))).data as Json[]) user[u.email] = u.user_id;

  const create = async (name: string, cells: Json) =>
    (await body(await as(admin).post(`/boards/${boardId}/items`, { name, cells }))).id as string;
  item.r1 = await create('R1 one', {
    ...assign(user['g1@one.test']!),
    [internalKey]: { item_ids: [ticket] },
    [noteKey]: 'note one',
  });
  item.r2 = await create('R2 two', { ...assign(user['g2@two.test']!), [noteKey]: 'note two' });
  item.r3 = await create('R3 nobody', {});
});
afterAll(() => t.close());

describe('guests are invited to a board — nothing else needed', () => {
  it('the invitation subscribes them; a guest only to shareable boards', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    const main = (await body(await as(admin).post('/boards', { name: 'Main', workspace_id: ws.id }))).id;
    const res = await as(admin).post('/users/invite', { emails: ['g3@x.test'], role: 'guest', board_ids: [main] });
    expect(res.status).toBe(422);
    const tree = await body(await as(g1).get(`/workspaces/${ws.id}/tree`));
    expect((tree.boards as Json[]).map((b) => b.name)).toEqual(['Requests']);
  });
});

describe('isolation (09 §10)', () => {
  it('1. each guest lists only their items; the owner sees everything', async () => {
    expect(await names(g1)).toEqual(['R1 one']);
    expect(await names(g2)).toEqual(['R2 two']);
    expect(await names(admin)).toEqual(['R1 one', 'R2 two', 'R3 nobody']);
    expect((await as(bob).get(`/boards/${boardId}/items`)).status).toBe(404); // not subscribed to a shareable board
  });

  it('2. another guest’s item is 404 — get, updates, cells', async () => {
    expect((await as(g1).get(`/items/${item.r1}`)).status).toBe(200);
    expect((await as(g1).get(`/items/${item.r2}`)).status).toBe(404);
    expect((await as(g1).get(`/items/${item.r3}`)).status).toBe(404);
    expect((await as(g1).get(`/items/${item.r2}/updates`)).status).toBe(404);
    expect((await as(g1).post(`/items/${item.r2}/updates`, { body: 'hi' })).status).toBe(404);
    expect((await as(g1).put(`/items/${item.r2}/cells/${noteKey}`, { value: 'x' })).status).toBe(404);
  });

  it('search, query, count and column values stay inside their items', async () => {
    const search = async (cookie: string, q: string) =>
      ((await body(await as(cookie).get(`/search?q=${encodeURIComponent(q)}`))).items as Json[]).map((i) => i.name);
    expect(await search(g1, 'one')).toEqual(['R1 one']);
    expect(await search(g1, 'two')).toEqual([]);
    expect(await search(g1, 'note')).toEqual(['R1 one']);
    expect((await body(await as(g1).get(`/boards/${boardId}/items/count`))).count).toBe(1);
    const q = (await body(await as(g2).post(`/boards/${boardId}/items/query`, {}))).data as Json[];
    expect(q.map((i) => i.id)).toEqual([item.r2]);
    const values = JSON.stringify(await body(await as(g1).get(`/boards/${boardId}/columns/${noteKey}/values`)));
    expect(values).toContain('note one');
    expect(values).not.toContain('note two');
  });

  it('3. a column restricted to edit is 403 for the guest', async () => {
    await as(admin).put(`/boards/${boardId}/columns/${statusKey}/restriction`, { kind: 'edit' });
    expect((await as(g1).put(`/items/${item.r1}/cells/${statusKey}`, { value: { index: 1 } })).status).toBe(403);
    await as(admin).put(`/boards/${boardId}/columns/${statusKey}/restriction`, { kind: null });
  });

  it('4. a relation to an internal item shows empty to the guest', async () => {
    const cell = async (cookie: string) => (await body(await as(cookie).get(`/items/${item.r1}`))).cells[internalKey];
    expect(JSON.stringify((await cell(g1)) ?? null)).not.toContain('secret ticket');
    expect(JSON.stringify(await cell(admin))).toContain('secret ticket');
  });

  it('a guest’s own new item is theirs; subitems follow their top-level item', async () => {
    await as(g1).post(`/boards/${boardId}/items`, { name: 'G1 request' });
    expect(await names(g1)).toEqual(['G1 request', 'R1 one']);
    expect(await names(g2)).toEqual(['R2 two']);
    const sub = (await body(await as(admin).post(`/items/${item.r2}/subitems`, { name: 'R2 sub' }))).id;
    expect((await as(g2).get(`/items/${sub}`)).status).toBe(200);
    expect((await as(g1).get(`/items/${sub}`)).status).toBe(404);
  });

  it('5. SSE: events of another guest’s items never reach them', async () => {
    const s = await openEvents(g1);
    await settle();
    await as(admin).patch(`/items/${item.r2}`, { name: 'R2 two!' });
    await as(admin).patch(`/items/${item.r1}`, { name: 'R1 one!' });
    await settle(500);
    const text = JSON.stringify(s.events);
    expect(text).toContain(item.r1);
    expect(text).not.toContain(item.r2);
    await s.close();
  });

  it('export holds only what the guest sees', async () => {
    const res = await as(g1).post(`/boards/${boardId}/export`, { format: 'csv' });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain('R1 one');
    expect(csv).not.toContain('R2 two');
  });
});
