// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { items } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 07 §5.1: archive items, groups and boards; the archive page; restore and undo. */
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // viewer
let acmeId: string;
let wsId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const names = async () => (await body(await as(admin).get(`/boards/${boardId}/items`))).data.map((i: Json) => i.name);
const archive = async (cookie: string) => (await body(await as(cookie).get('/archive'))).data as Json[];
const newItem = async (name: string, group?: string) =>
  body(await as(admin).post(`/boards/${boardId}/items`, { name, ...(group ? { group_id: group } : {}) }));

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Arch', workspace_id: wsId }))).id;
});
afterAll(() => t.close());

describe('archive', () => {
  it('an archived item leaves the board, shows in the archive (who/when/board) and comes back', async () => {
    const item = await newItem('old lead');
    const res = await body(await as(bob).post(`/items/${item.id}/archive`));
    expect(res).toMatchObject({ ok: true, event_id: expect.any(String) });
    expect(await names()).not.toContain('old lead');
    const entry = (await archive(carol)).find((e) => e.id === item.id)!;
    expect(entry).toMatchObject({ type: 'item', name: 'old lead', board_id: boardId, archived_by: { name: 'bob' } });
    // Still readable by id (deep links), but not in the board.
    expect((await as(admin).get(`/items/${item.id}`)).status).toBe(200);
    expect((await as(carol).post(`/archive/item/${item.id}/restore`)).status).toBe(403);
    expect(await body(await as(bob).post(`/archive/item/${item.id}/restore`))).toEqual({ ok: true, board_id: boardId });
    expect(await names()).toContain('old lead');
    expect((await archive(admin)).some((e) => e.id === item.id)).toBe(false);
  });

  it('undo of an archive brings it back; archiving twice is a conflict', async () => {
    const item = await newItem('undo me');
    const { event_id } = await body(await as(admin).post(`/items/${item.id}/archive`));
    expect((await as(admin).post(`/items/${item.id}/archive`)).status).toBe(409);
    expect((await as(admin).post(`/activity/${event_id}/undo`, {})).status).toBe(200);
    expect(await names()).toContain('undo me');
  });

  it('a group archives with its items and restores with exactly those; never the last group', async () => {
    const g = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'Old' }));
    await newItem('in old 1', g.id);
    const lone = await newItem('in old archived first', g.id);
    await as(admin).post(`/items/${lone.id}/archive`);
    await new Promise((r) => setTimeout(r, 2500)); // a separate archive moment
    await as(admin).post(`/boards/${boardId}/groups/${g.id}/archive`);
    expect(await names()).not.toContain('in old 1');
    expect((await body(await as(admin).get(`/boards/${boardId}`))).groups.map((x: Json) => x.id)).not.toContain(g.id);
    expect((await archive(admin)).find((e) => e.id === g.id)).toMatchObject({ type: 'group', name: 'Old' });

    await as(admin).post(`/archive/group/${g.id}/restore`);
    expect(await names()).toContain('in old 1');
    expect(await names()).not.toContain('in old archived first');

    // Undo restores the group the same way.
    const again = await body(await as(admin).post(`/boards/${boardId}/groups/${g.id}/archive`));
    await as(admin).post(`/activity/${again.event_id}/undo`, {});
    expect(await names()).toContain('in old 1');

    const solo = await body(await as(admin).post('/boards', { name: 'Solo', workspace_id: wsId }));
    expect((await as(admin).post(`/boards/${solo.id}/groups/${solo.groups[0].id}/archive`)).status).toBe(409);
  });

  it('an item whose group was archived comes back in the first group', async () => {
    const g = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'Temp' }));
    const item = await newItem('wanderer', g.id);
    await as(admin).post(`/items/${item.id}/archive`);
    await as(admin).post(`/boards/${boardId}/groups/${g.id}/archive`);
    await as(admin).post(`/archive/item/${item.id}/restore`);
    expect((await body(await as(admin).get(`/items/${item.id}`))).group_id).not.toBe(g.id);
  });

  it('an item archives with its subitems and they come back with it, by restore and by undo (audit 2026-10-10 C2)', async () => {
    const parent = await newItem('parent with subs');
    const sub = await body(await as(admin).post(`/items/${parent.id}/subitems`, { name: 'sub of parent' }));
    const subsub = await body(await as(admin).post(`/items/${sub.id}/subitems`, { name: 'sub of sub' }));
    const archivedAt = async (id: string) => (await t.db.select().from(items).where(eq(items.id, id)))[0]!.archivedAt;
    const { event_id } = await body(await as(admin).post(`/items/${parent.id}/archive`));
    // The whole subtree is archived (it used to stay live in My Work and search).
    expect(await archivedAt(sub.id)).toBeTruthy();
    expect(await archivedAt(subsub.id)).toBeTruthy();
    await as(admin).post(`/archive/item/${parent.id}/restore`);
    expect(await archivedAt(parent.id)).toBeNull();
    expect(await archivedAt(sub.id)).toBeNull();
    expect(await archivedAt(subsub.id)).toBeNull();
    // Undo of a later archive brings the subtree back as well.
    expect(typeof event_id).toBe('string');
    const again = await body(await as(admin).post(`/items/${parent.id}/archive`));
    expect(await archivedAt(subsub.id)).toBeTruthy();
    expect((await as(admin).post(`/activity/${again.event_id}/undo`, {})).status).toBe(200);
    expect(await archivedAt(sub.id)).toBeNull();
    expect(await archivedAt(subsub.id)).toBeNull();
  });

  it('a group archives its items with their subitems, and the restore brings the subitems back (audit 2026-10-10 C2)', async () => {
    const g = await body(await as(admin).post(`/boards/${boardId}/groups`, { title: 'Deep' }));
    const parent = await newItem('deep parent', g.id);
    const sub = await body(await as(admin).post(`/items/${parent.id}/subitems`, { name: 'deep sub' }));
    const archivedAt = async (id: string) => (await t.db.select().from(items).where(eq(items.id, id)))[0]!.archivedAt;
    await as(admin).post(`/boards/${boardId}/groups/${g.id}/archive`);
    expect(await archivedAt(sub.id)).toBeTruthy();
    await as(admin).post(`/archive/group/${g.id}/restore`);
    expect(await archivedAt(parent.id)).toBeNull();
    expect(await archivedAt(sub.id)).toBeNull();
  });

  it('boards: owners archive, it leaves the sidebar, opens with archived_at, and restores', async () => {
    const b = await body(await as(admin).post('/boards', { name: 'Shelved', workspace_id: wsId }));
    expect((await as(carol).post(`/boards/${b.id}/archive`)).status).toBe(403);
    await as(admin).post(`/boards/${b.id}/archive`);
    const tree = await body(await as(admin).get(`/workspaces/${wsId}/tree`));
    expect(tree.boards.map((x: Json) => x.id)).not.toContain(b.id);
    expect((await body(await as(admin).get(`/boards/${b.id}`))).archived_at).toEqual(expect.any(String));
    expect((await archive(carol)).find((e) => e.id === b.id)).toMatchObject({ type: 'board', name: 'Shelved' });
    await as(admin).post(`/archive/board/${b.id}/restore`);
    expect((await body(await as(admin).get(`/boards/${b.id}`))).archived_at).toBeNull();
  });

  it('bulk archive is one batch; undo brings all back', async () => {
    const ids = [(await newItem('b1')).id, (await newItem('b2')).id];
    const res = await body(
      await as(admin).post(`/boards/${boardId}/items/bulk`, { item_ids: ids, action: { type: 'archive' } }),
    );
    expect(res.done).toBe(2);
    expect(await names()).not.toContain('b1');
    await as(admin).post(`/activity/${res.event_id}/undo`, {});
    expect(await names()).toEqual(expect.arrayContaining(['b1', 'b2']));
  });
});
