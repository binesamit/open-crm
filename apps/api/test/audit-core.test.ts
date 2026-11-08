// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITEM_DEPTH_MAX, newId } from '@bines/shared';
import { boards, columnConversions, columns, items } from '../src/db/schema';
import { STALE_CONVERSION_MS, sweepStaleConversions } from '../src/modules/conversions/conversions.service';
import { setColumnConverting } from '../src/modules/conversions/conversions.repo';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Audit 2026-10-10, core round 2: the hierarchy depth rule (C4), item positions that tie (C5), a position anchor
 * from elsewhere (C6) and a conversion a dead process left running (C7).
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let wsId: string;
let boardId: string;
let groupId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = () => t.api(admin, acmeId);
const newItem = async (name: string, extra: Json = {}, board = boardId) =>
  as().post(`/boards/${board}/items`, { name, ...extra });
const subitem = (parentId: string, name: string) => as().post(`/items/${parentId}/subitems`, { name });
const names = async () => (await body(await as().get(`/boards/${boardId}/items`))).data.map((i: Json) => i.name);

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
  wsId = (await body(await as().get('/workspaces'))).data[0].id;
  const board = await body(await as().post('/boards', { name: 'Core', workspace_id: wsId }));
  boardId = board.id;
  groupId = board.groups[0].id;
});
afterAll(() => t.close());

describe('hierarchy depth (C4)', () => {
  it('a new board allows sub-subitems (max 2 = depth 0..2); a stored 6 is read as 5 and never hits the items CHECK', async () => {
    expect((await body(await as().get(`/boards/${boardId}`))).hierarchy_depth_max).toBe(2);
    const top = await body(await newItem('top'));
    const d1 = await body(await subitem(top.id, 'd1'));
    const d2 = await body(await subitem(d1.id, 'd2'));
    const tooDeep = await subitem(d2.id, 'd3');
    expect(tooDeep.status).toBe(422);
    expect((await body(tooDeep)).error?.code ?? (await body(tooDeep)).code).toBe('depth_exceeded');

    await t.db.update(boards).set({ hierarchyDepthMax: 6 }).where(eq(boards.id, boardId));
    expect((await body(await as().get(`/boards/${boardId}`))).hierarchy_depth_max).toBe(ITEM_DEPTH_MAX);
    let parent = d2.id;
    for (let depth = 3; depth <= ITEM_DEPTH_MAX; depth++) {
      const res = await subitem(parent, `d${depth}`);
      expect(res.status, `depth ${depth}`).toBe(201);
      parent = (await body(res)).id;
    }
    // Depth 6 would violate `ck_items_depth`: a clean refusal, not a 500.
    const past = await subitem(parent, 'd6');
    expect(past.status).toBe(422);
    await t.db.update(boards).set({ hierarchyDepthMax: 2 }).where(eq(boards.id, boardId));
  });
});

describe('item positions (C5, C6)', () => {
  it('two rows with the same key keep one order, and a drop between them is not a 500', async () => {
    const a = await body(await newItem('tie a'));
    const b = await body(await newItem('tie b'));
    // The tie older concurrent appends produced: both rows carry a's key.
    await t.db
      .update(items)
      .set({ position: a.position as string })
      .where(eq(items.id, b.id));
    const order = () => names().then((n: string[]) => n.filter((x) => x.startsWith('tie')));
    const first = await order();
    expect(first).toEqual(await order()); // stable between loads (id breaks the tie)
    const between = await newItem('tie c', { position: { after_id: a.id } });
    expect(between.status, JSON.stringify(await between.clone().json())).toBe(201);
    expect((await order()).length).toBe(3);
  });

  it('an anchor that is not a live top-level item of the group is refused', async () => {
    const other = await body(await as().post('/boards', { name: 'Other', workspace_id: wsId }));
    const foreign = await body(await newItem('foreign', {}, other.id));
    expect((await newItem('x', { position: { after_id: foreign.id } })).status).toBe(400);
    const top = await body(await newItem('anchor parent'));
    const sub = await body(await subitem(top.id, 'anchor sub'));
    expect((await newItem('y', { position: { after_id: sub.id } })).status).toBe(400);
    expect((await newItem('z', { position: { after_id: top.id }, group_id: groupId })).status).toBe(201);
  });
});

describe('stale conversions (C7)', () => {
  it('a conversion left running by a dead process is failed and its column unlocked; a fresh one stays', async () => {
    const col = await body(await as().post(`/boards/${boardId}/columns`, { title: 'Amount', type: 'text' }));
    // The route answers the column's key; the lock lives on its row id.
    const colId = (await t.db.select().from(columns).where(eq(columns.boardId, boardId))).find(
      (c) => c.key === col.id,
    )!.id;
    const row = (id: string, createdAt: Date) => ({
      id,
      accountId: acmeId,
      boardId,
      columnId: colId,
      fromType: 'text',
      toType: 'numbers',
      status: 'running',
      createdAt,
    });
    const stale = newId();
    const fresh = newId();
    await t.db
      .insert(columnConversions)
      .values([row(stale, new Date(Date.now() - STALE_CONVERSION_MS - 60_000)), row(fresh, new Date())]);
    await setColumnConverting(t.db, colId, stale);
    const item = await body(await newItem('locked'));
    expect((await as().put(`/items/${item.id}/cells/${col.id}`, { value: 'x' })).status).toBe(423);

    expect(await sweepStaleConversions(t.db)).toEqual([stale]);
    const rows = await t.db.select().from(columnConversions).where(eq(columnConversions.boardId, boardId));
    expect(rows.find((r) => r.id === stale)).toMatchObject({ status: 'failed', error: 'stale' });
    expect(rows.find((r) => r.id === fresh)).toMatchObject({ status: 'running' });
    expect((await t.db.select().from(columns).where(eq(columns.id, colId)))[0]!.convertingId).toBeNull();
    expect((await as().put(`/items/${item.id}/cells/${col.id}`, { value: 'x' })).status).toBe(200);
  });
});
