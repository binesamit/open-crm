// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * r23ui: "last updated" shows who / when / both, with or without the time, and can count only the changes of
 * chosen columns (a cleared value and a rename included).
 * The creation log can show the time too.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let ws: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);
const col = async (board: Json, payload: Json) => body(await as().post(`/boards/${board.id}/columns`, payload));
const getItem = async (id: string) => body(await as().get(`/items/${id}`));
const boardItem = async (boardId: string, id: string) =>
  (await body(await as().get(`/boards/${boardId}/items`))).data.find((i: Json) => i.id === id);
const setCell = async (itemId: string, key: string, value: unknown) =>
  value === null ? as().del(`/items/${itemId}/cells/${key}`) : as().put(`/items/${itemId}/cells/${key}`, { value });
const tick = () => new Promise((r) => setTimeout(r, 25));

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
  ws = (await body(await as().get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('last updated of chosen columns', () => {
  let board: Json;
  let a: Json;
  let b: Json;
  let watch: Json;
  let any: Json;
  let itemId: string;

  it('is empty until a chosen column changes; other columns do not move it', async () => {
    board = await body(await as().post('/boards', { name: 'Deals', workspace_id: ws }));
    a = await col(board, { title: 'Stage note', type: 'text' });
    b = await col(board, { title: 'Other', type: 'text' });
    watch = await col(board, {
      title: 'Stage updated',
      type: 'last_updated',
      settings: { mode: 'date', show_time: true, columns: [a.id] },
    });
    any = await col(board, { title: 'Updated', type: 'last_updated', settings: { mode: 'both' } });
    expect(watch.settings.columns).toEqual([a.id]);

    itemId = (await body(await as().post(`/boards/${board.id}/items`, { name: 'Deal 1' }))).id;
    expect((await getItem(itemId)).cells[watch.id] ?? null).toBeNull();

    expect((await setCell(itemId, b.id, 'x')).status).toBe(200);
    const afterB = await getItem(itemId);
    expect(afterB.cells[watch.id] ?? null).toBeNull();
    // The "any column" one moved, and says who.
    expect(afterB.cells[any.id].value.by).toBeTruthy();
    expect(afterB.cells[any.id].text).toContain(' · ');
  });

  it('follows the chosen column — set, then cleared — and ignores later changes elsewhere', async () => {
    await tick();
    await setCell(itemId, a.id, 'qualified');
    const set = (await getItem(itemId)).cells[watch.id];
    expect(set.value.by).toBeTruthy();
    // show_time: "DD/MM/YYYY HH:MM" (no name: mode = date).
    expect(set.text).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2}/);

    await tick();
    await setCell(itemId, b.id, 'y');
    const later = await getItem(itemId);
    expect(later.cells[watch.id].value.at).toBe(set.value.at);
    expect(Date.parse(later.cells[any.id].value.at)).toBeGreaterThan(Date.parse(set.value.at));

    // A cleared value is a change too (the cell row is gone; the activity log has it).
    await tick();
    expect((await setCell(itemId, a.id, null)).status).toBeLessThan(300);
    const cleared = (await getItem(itemId)).cells[watch.id];
    expect(Date.parse(cleared.value.at)).toBeGreaterThan(Date.parse(set.value.at));

    // The whole-board read computes the same value as the single item.
    expect((await boardItem(board.id, itemId)).cells[watch.id].value).toEqual(cleared.value);
  });

  it('can watch the name: a rename moves it', async () => {
    const byName = await col(board, { title: 'Renamed', type: 'last_updated', settings: { columns: ['name'] } });
    const before = (await getItem(itemId)).cells[byName.id].value;
    await tick();
    expect((await as().patch(`/items/${itemId}`, { name: 'Deal 1b' })).status).toBe(200);
    const after = (await getItem(itemId)).cells[byName.id].value;
    expect(Date.parse(after.at)).toBeGreaterThan(Date.parse(before.at));
  });

  it('shows only who, or the creation time', async () => {
    const who = await col(board, { title: 'By', type: 'last_updated', settings: { mode: 'person' } });
    const created = await col(board, { title: 'Created', type: 'creation_log', settings: { show_time: true } });
    const item = await getItem(itemId);
    expect(item.cells[who.id].text).toBeTruthy();
    expect(item.cells[who.id].text).not.toMatch(/\d{2}\/\d{2}/);
    expect(item.cells[created.id].text).toMatch(/\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2}/);
  });
});
