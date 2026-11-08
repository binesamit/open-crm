// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 07 §3.4–3.7: move items and groups between boards with a column mapping; item ↔ subitem; undo. */
let t: TestContext;
let admin: string;
let carol: string; // viewer
let acmeId: string;
let a: Json; // source board
let b: Json; // target board
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const col = async (board: Json, title: string, type: string) =>
  body(await as(admin).post(`/boards/${board.id}/columns`, { title, type }));

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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  a = await body(await as(admin).post('/boards', { name: 'Source', workspace_id: ws.id }));
  b = await body(await as(admin).post('/boards', { name: 'Target', workspace_id: ws.id }));
});
afterAll(() => t.close());

describe('move an item to another board', () => {
  let item: Json;
  let budgetA: Json;
  let budgetB: Json;
  let notes: Json;

  it('keeps the id; mapped cells follow, unmapped are dropped; subitems and updates come along', async () => {
    budgetA = await col(a, 'Budget', 'numbers');
    notes = await col(a, 'Notes', 'text');
    budgetB = await col(b, 'Budget', 'numbers');
    item = await body(
      await as(admin).post(`/boards/${a.id}/items`, { name: 'Deal', cells: { [budgetA.id]: 5, [notes.id]: 'hi' } }),
    );
    await as(admin).post(`/items/${item.id}/subitems`, { name: 'Step 1' });
    await as(admin).post(`/items/${item.id}/updates`, { body: 'context' });

    // A bad mapping (different type) is refused; viewers cannot move.
    expect(
      (await as(admin).post(`/items/${item.id}/move-to-board`, { board_id: b.id, mapping: { [notes.id]: budgetB.id } }))
        .status,
    ).toBe(422);
    expect((await as(carol).post(`/items/${item.id}/move-to-board`, { board_id: b.id, mapping: {} })).status).toBe(403);
    expect((await as(admin).post(`/items/${item.id}/move-to-board`, { board_id: a.id, mapping: {} })).status).toBe(400);

    const res = await body(
      await as(admin).post(`/items/${item.id}/move-to-board`, {
        board_id: b.id,
        mapping: { [budgetA.id]: budgetB.id, [notes.id]: null },
      }),
    );
    expect(res).toMatchObject({ ok: true, dropped: 1 });
    const moved = await getItem(item.id);
    expect(moved).toMatchObject({ board_id: b.id, group_id: b.groups[0].id });
    expect(moved.cells[budgetB.id].value).toEqual(5);
    expect(moved.cells[notes.id]).toBeUndefined();
    expect((await body(await as(admin).get(`/items/${item.id}/updates`))).data).toHaveLength(1);
    const subB = (await body(await as(admin).get(`/boards/${b.id}`))).subitems_board_id;
    const subs = (await body(await as(admin).get(`/boards/${subB}/items`))).data as Json[];
    expect(subs.map((s) => [s.name, s.parent_item_id])).toEqual([['Step 1', item.id]]);
    expect((await body(await as(admin).get(`/boards/${a.id}/items`))).data).toEqual([]);

    // Undo puts it back exactly: board, group, the dropped value, the subitem's board.
    await as(admin).post(`/activity/${res.event_id}/undo`, {});
    const back = await getItem(item.id);
    expect(back).toMatchObject({ board_id: a.id, group_id: a.groups[0].id });
    expect(back.cells[notes.id].value).toEqual('hi');
    expect(back.cells[budgetA.id].value).toEqual(5);
    const subA = (await body(await as(admin).get(`/boards/${a.id}`))).subitems_board_id;
    expect((await body(await as(admin).get(`/boards/${subA}/items`))).data.map((s: Json) => s.name)).toEqual([
      'Step 1',
    ]);
  });

  it('moves a group (same id) with its items to the other board, and back by undo', async () => {
    const g = await body(await as(admin).post(`/boards/${a.id}/groups`, { title: 'Wave 2' }));
    const i1 = await body(await as(admin).post(`/boards/${a.id}/items`, { name: 'G1', group_id: g.id }));
    const res = await body(
      await as(admin).post(`/boards/${a.id}/groups/${g.id}/move-to-board`, { board_id: b.id, mapping: {} }),
    );
    expect((await body(await as(admin).get(`/boards/${b.id}`))).groups.map((x: Json) => x.id)).toContain(g.id);
    expect((await getItem(i1.id)).board_id).toBe(b.id);
    await as(admin).post(`/activity/${res.event_id}/undo`, {});
    expect((await body(await as(admin).get(`/boards/${a.id}`))).groups.map((x: Json) => x.id)).toContain(g.id);
    expect(await getItem(i1.id)).toMatchObject({ board_id: a.id, group_id: g.id });
  });
});

describe('bulk move to board', () => {
  it('moves the selection with one mapping, as one batch; undo brings all back', async () => {
    const x = await body(await as(admin).post(`/boards/${a.id}/items`, { name: 'X' }));
    const y = await body(await as(admin).post(`/boards/${a.id}/items`, { name: 'Y' }));
    const res = await body(
      await as(admin).post(`/boards/${a.id}/items/bulk`, {
        item_ids: [x.id, y.id],
        action: { type: 'move_to_board', board_id: b.id, mapping: {} },
      }),
    );
    expect(res).toMatchObject({ done: 2, skipped: 0 });
    expect((await getItem(x.id)).board_id).toBe(b.id);
    await as(admin).post(`/activity/${res.event_id}/undo`, {});
    expect((await getItem(x.id)).board_id).toBe(a.id);
    expect((await getItem(y.id)).board_id).toBe(a.id);
  });
});

describe('move with conversion (04 §6.2)', () => {
  it('text → long text, a status by its label text, a date → a timeline; undo restores', async () => {
    const notes = await col(a, 'Remarks', 'text');
    const stageA = await body(
      await as(admin).post(`/boards/${a.id}/columns`, {
        title: 'Stage',
        type: 'status',
        settings: { labels: [{ id: 4, label: 'Won', color: 'forest', index: 0 }] },
      }),
    );
    const when = await col(a, 'When', 'date');
    const remarksB = await col(b, 'Remarks', 'long_text');
    const stageB = await body(
      await as(admin).post(`/boards/${b.id}/columns`, {
        title: 'Stage',
        type: 'status',
        settings: {
          labels: [
            { id: 0, label: 'Lost', color: 'crimson', index: 0 },
            { id: 7, label: 'won', color: 'forest', index: 1 },
          ],
        },
      }),
    );
    const span = await col(b, 'Span', 'timeline');
    const item = await body(
      await as(admin).post(`/boards/${a.id}/items`, {
        name: 'Converted',
        cells: { [notes.id]: 'remember', [stageA.id]: { index: 4 }, [when.id]: { date: '2026-10-03' } },
      }),
    );
    const res = await as(admin).post(`/items/${item.id}/move-to-board`, {
      board_id: b.id,
      mapping: { [notes.id]: remarksB.id, [stageA.id]: stageB.id, [when.id]: span.id },
    });
    expect(res.status).toBe(200);
    const result = await body(res);
    expect(result).toMatchObject({ dropped: 0 });
    const moved = await getItem(item.id);
    expect(moved.cells[remarksB.id].value).toEqual({ text: 'remember' });
    expect(moved.cells[stageB.id]).toMatchObject({ value: { index: 7 }, text: 'won' });
    expect(moved.cells[span.id].value).toEqual({ from: '2026-10-03', to: '2026-10-03' });

    const ev = result.event_id as string;
    expect((await as(admin).post(`/activity/${ev}/undo`, {})).status).toBe(200);
    const back = await getItem(item.id);
    expect(back.board_id).toBe(a.id);
    expect(back.cells[stageA.id].value).toEqual({ index: 4 });
    expect(back.cells[notes.id].value).toBe('remember');
  });
});

describe('convert item ↔ subitem', () => {
  it('an item becomes a subitem of another (its cells mapped), and back to an item; undo restores', async () => {
    const parent = await body(await as(admin).post(`/boards/${a.id}/items`, { name: 'Parent' }));
    const child = await body(await as(admin).post(`/boards/${a.id}/items`, { name: 'Loose' }));
    expect((await as(admin).post(`/items/${child.id}/convert`, { parent_item_id: child.id, mapping: {} })).status).toBe(
      400,
    );
    const res = await body(
      await as(admin).post(`/items/${child.id}/convert`, { parent_item_id: parent.id, mapping: {} }),
    );
    const sub = await getItem(child.id);
    expect(sub).toMatchObject({ parent_item_id: parent.id, depth: 1, group_id: null });

    await as(admin).post(`/items/${child.id}/convert`, { group_id: a.groups[0].id, mapping: {} });
    expect(await getItem(child.id)).toMatchObject({ board_id: a.id, depth: 0, parent_item_id: null });

    // Undo of the first conversion (the value changed since → force).
    const conflict = await as(admin).post(`/activity/${res.event_id}/undo`, {});
    expect(conflict.status).toBe(409);
    expect((await as(admin).post(`/activity/${res.event_id}/undo`, { force: true })).status).toBe(200);
    // Back where it started (its original group).
    expect(await getItem(child.id)).toMatchObject({ board_id: a.id, depth: 0, group_id: child.group_id });
  });
});
