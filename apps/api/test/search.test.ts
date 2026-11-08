// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M4 step 6 (07 §9.1, §9.3): search everything within my access; the Inbox. */
let t: TestContext;
let admin: string;
let bob: string;
let dana: string;
let acmeId: string;
let ids: Record<'admin' | 'bob' | 'dana', string>;
let boardId: string;
let notes: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const search = async (cookie: string, q: string) => body(await as(cookie).get(`/search?q=${encodeURIComponent(q)}`));
const names = (list: Json[]) => list.map((x) => x.name);
const newItem = async (board: string, name: string, cells?: Record<string, unknown>) =>
  (await body(await as(admin).post(`/boards/${board}/items`, { name, cells }))).id as string;

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test', 'dana@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  dana = await join('dana@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test'), dana: idOf('dana@acme.test') };
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals pipeline', workspace_id: ws.id }))).id;
  notes = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Notes', type: 'text' }))).id;
});
afterAll(() => t.close());

describe('GET /search', () => {
  it('finds items by name or cell text, boards, updates and people', async () => {
    const alpha = await newItem(boardId, 'Alpha proposal');
    await newItem(boardId, 'Beta', { [notes]: 'contract renewal in May' });
    await as(admin).post(`/items/${alpha}/updates`, { body: 'please review the budget before Sunday' });

    const byName = await search(bob, 'proposal');
    expect(byName.items).toEqual([
      expect.objectContaining({
        name: 'Alpha proposal',
        board: { id: boardId, name: 'Deals pipeline' },
        matched: null,
      }),
    ]);
    expect(byName.items[0].group).toMatchObject({ title: expect.any(String), color: expect.any(String) });

    const byCell = await search(bob, 'RENEWAL');
    expect(byCell.items).toEqual([expect.objectContaining({ name: 'Beta', matched: 'contract renewal in May' })]);

    expect(names((await search(bob, 'pipeline')).boards)).toEqual(['Deals pipeline']);

    const upd = await search(bob, 'budget');
    expect(upd.updates).toEqual([
      expect.objectContaining({
        item: { id: alpha, name: 'Alpha proposal' },
        board: { id: boardId, name: 'Deals pipeline' },
        author: 'admin',
        excerpt: 'please review the budget before Sunday',
      }),
    ]);

    expect((await search(bob, 'dana')).people).toEqual([{ id: ids.dana, name: 'dana', email: 'dana@acme.test' }]);
  });

  it('needs two characters, and takes % and _ literally', async () => {
    expect(await search(bob, 'a')).toEqual({
      items: [],
      boards: [],
      updates: [],
      people: [],
      tags: [],
      files: [],
      docs: [],
      dashboards: [],
    });
    const wild = await search(bob, '%%');
    expect(wild.items).toEqual([]);
    await newItem(boardId, 'code_name x');
    expect(names((await search(bob, 'e_n')).items)).toEqual(['code_name x']);
  });

  it('never shows what I cannot read: private boards, hidden items, owner-only columns', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    const secret = (
      await body(await as(admin).post('/boards', { name: 'Secret proposals', workspace_id: ws.id, kind: 'private' }))
    ).id as string;
    await newItem(secret, 'Secret proposal');
    expect(names((await search(admin, 'proposal')).items).sort()).toEqual(['Alpha proposal', 'Secret proposal']);
    expect(names((await search(bob, 'proposal')).items)).toEqual(['Alpha proposal']);
    expect(names((await search(bob, 'proposals')).boards)).toEqual([]);

    await as(admin).put(`/boards/${boardId}/permissions`, {
      view_items: { mode: 'assigned_or_created', column_ids: 'any_people' },
    });
    expect((await search(bob, 'proposal')).items).toEqual([]);
    expect((await search(bob, 'budget')).updates).toEqual([]);
    await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'all' } });

    await as(admin).put(`/boards/${boardId}/columns/${notes}/restriction`, { kind: 'view' });
    expect((await search(bob, 'renewal')).items).toEqual([]);
    await as(admin).put(`/boards/${boardId}/columns/${notes}/restriction`, { kind: null });
    expect(names((await search(bob, 'renewal')).items)).toEqual(['Beta']);
  });

  it('a subitem opens on its parent board', async () => {
    const parent = await newItem(boardId, 'Parent');
    await as(admin).post(`/items/${parent}/subitems`, { name: 'Tiny subtask' });
    expect((await search(bob, 'subtask')).items).toEqual([
      expect.objectContaining({ name: 'Tiny subtask', board: { id: boardId, name: 'Deals pipeline' } }),
    ]);
  });
});

describe('GET /me/inbox', () => {
  it('updates on items I follow and mentions of me, not my own; a mentions-only view', async () => {
    const followed = await newItem(boardId, 'Followed');
    await as(bob).post(`/items/${followed}/updates`, { body: 'אני עוקב' }); // writing follows (D15)
    await as(admin).post(`/items/${followed}/updates`, { body: 'עדכון מאדמין' });
    const other = await newItem(boardId, 'Elsewhere');
    await as(dana).post(`/items/${other}/updates`, { body: `[@Bob](user:${ids.bob}) תסתכל` });
    // Being mentioned made Bob follow "Elsewhere" (D15); an item he never touched stays out.
    await as(dana).post(`/items/${await newItem(boardId, 'Untouched')}/updates`, { body: 'לא קשור לבוב' });

    const inbox = (await body(await as(bob).get('/me/inbox'))).data as Json[];
    const texts = inbox.map((e) => e.body_html);
    expect(texts.some((h) => h.includes('עדכון מאדמין'))).toBe(true);
    expect(texts.some((h) => h.includes('תסתכל'))).toBe(true);
    expect(texts.some((h) => h.includes('אני עוקב'))).toBe(false); // mine
    expect(texts.some((h) => h.includes('לא קשור לבוב'))).toBe(false); // not followed, no mention
    const mention = inbox.find((e) => e.body_html.includes('תסתכל'))!;
    expect(mention).toMatchObject({
      mention: true,
      item: { id: other, name: 'Elsewhere' },
      board: { id: boardId },
      author: { id: ids.dana, name: 'dana' },
      parent_update_id: null,
    });
    expect(inbox[0]!.created_at >= inbox[inbox.length - 1]!.created_at).toBe(true);

    const only = (await body(await as(bob).get('/me/inbox?mentions=1'))).data as Json[];
    expect(only.every((e) => e.mention)).toBe(true);
    expect(only.some((e) => e.body_html.includes('תסתכל'))).toBe(true);

    await as(bob).put(`/items/${followed}/follow`, { following: false });
    const after = (await body(await as(bob).get('/me/inbox'))).data as Json[];
    expect(after.some((e) => e.body_html.includes('עדכון מאדמין'))).toBe(false);
  });
  it('V marks one read (and its bell notification); "mark all" empties it; read ones on request', async () => {
    const item = await newItem(boardId, 'Clearing');
    await as(bob).post(`/items/${item}/updates`, { body: 'בוב עוקב' });
    const first = await body(await as(admin).post(`/items/${item}/updates`, { body: `[@Bob](user:${ids.bob}) ראשון` }));
    await as(admin).post(`/items/${item}/updates`, { body: 'שני' });
    const inbox = async (q = '') =>
      ((await body(await as(bob).get(`/me/inbox${q}`))).data as Json[]).map((e) => e.body_html);
    const count = async () => (await body(await as(bob).get('/me/inbox/count'))).unread as number;
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(2);
    const bellBefore = (await body(await as(bob).get('/me/notifications'))).data as Json[];
    expect(bellBefore.find((n) => n.update_id === first.id)?.read_at).toBeNull();

    expect(await body(await as(bob).post('/me/inbox/read', { ids: [first.id] }))).toEqual({
      ok: true,
      unread: before - 1,
    });
    expect((await inbox()).some((h) => h.includes('ראשון'))).toBe(false);
    expect((await inbox()).some((h) => h.includes('שני'))).toBe(true);
    const withRead = (await body(await as(bob).get('/me/inbox?read=1'))).data as Json[];
    expect(withRead.find((e) => e.id === first.id)).toMatchObject({ read: true });
    const bellAfter = (await body(await as(bob).get('/me/notifications'))).data as Json[];
    expect(bellAfter.find((n) => n.update_id === first.id)?.read_at).not.toBeNull();

    expect(await body(await as(bob).post('/me/inbox/read', { all: true }))).toEqual({ ok: true, unread: 0 });
    expect(await inbox()).toEqual([]);
    expect(
      (await body(await as(bob).get('/me/notifications'))).data.every((n: Json) => !n.update_id || n.read_at),
    ).toBe(true);
    // Something new after "mark all" shows again.
    await as(admin).post(`/items/${item}/updates`, { body: 'שלישי' });
    expect(await inbox()).toEqual([expect.stringContaining('שלישי')]);
    expect(await count()).toBe(1);
    // Someone else's update ids are ignored; the other account sees nothing.
    expect((await as(bob).post('/me/inbox/read', { ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] })).status).toBe(200);
    expect((await as(bob).post('/me/inbox/read', {})).status).toBe(400);
  });
});

describe('search: files, archive, recent (M4.5 stage 6)', () => {
  const upload = async (name: string) => {
    const pre = await body(await as(admin).post('/files/presign', { name, size: 100, mime: 'application/pdf' }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 100, 'application/pdf');
    await as(admin).post(`/files/${pre.file_id}/complete`);
    return pre.file_id as string;
  };

  it('finds files in file columns and in updates, on items I may see', async () => {
    const files = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Docs', type: 'file' }))).id;
    const item = await newItem(boardId, 'With files');
    await as(admin).post(`/items/${item}/cells/${files}/files`, { file_ids: [await upload('quarterly-report.pdf')] });
    await as(admin).post(`/items/${item}/updates`, { body: 'attached', file_ids: [await upload('report-draft.pdf')] });
    const r = await search(bob, 'report');
    expect(r.files.map((f: Json) => [f.name, f.in_update]).sort()).toEqual([
      ['quarterly-report.pdf', false],
      ['report-draft.pdf', true],
    ]);
    expect(r.files[0]).toMatchObject({ item: { id: item, name: 'With files' }, board: { id: boardId } });
  });

  it('archived items only with "include archive"', async () => {
    const item = await newItem(boardId, 'Zephyr archived');
    await as(admin).post(`/items/${item}/archive`, {});
    expect((await search(bob, 'zephyr')).items).toEqual([]);
    const withArchive = await body(await as(bob).get(`/search?q=zephyr&archived=1`));
    expect(withArchive.items).toEqual([expect.objectContaining({ id: item, archived: true })]);
  });

  it('recent searches are kept on the server, newest first, per user', async () => {
    await as(bob).post('/search/recent', { q: 'alpha' });
    await as(bob).post('/search/recent', { q: 'beta' });
    expect((await body(await as(bob).post('/search/recent', { q: 'alpha' }))).data).toEqual(['alpha', 'beta']);
    expect((await body(await as(bob).get('/search/recent'))).data).toEqual(['alpha', 'beta']);
    expect((await body(await as(dana).get('/search/recent'))).data).toEqual([]);
    expect((await body(await as(bob).del('/search/recent'))).data).toEqual([]);
  });
});
