// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * a workflow move may need the item's subitems: at least N of them with some sub-board columns filled
 * (optionally all of them, counting only those that match "only if"). The popup adds and fills in subitems in the
 * same write as the move — one batch, one undo. A popup button may ask the same.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let ws: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

// Labels: 0 In progress, 1 Done, 2 Blocked (the defaults).
const setup = async (name: string) => {
  const board = await body(await as(admin).post('/boards', { name, workspace_id: ws }));
  const stage = await body(
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'stage', title: 'Stage', type: 'status' }),
  );
  // The first subitem creates the sub-board; an amount column is added on it.
  const seed = (await body(await as(admin).post(`/boards/${board.id}/items`, { name: 'Seed' }))).id as string;
  expect((await as(admin).post(`/items/${seed}/subitems`, { name: 'seed sub' })).status).toBe(201);
  const subId = (await body(await as(admin).get(`/boards/${board.id}`))).subitems_board_id as string;
  expect(
    (await as(admin).post(`/boards/${subId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' })).status,
  ).toBe(201);
  return { boardId: board.id as string, subId, settings: stage.settings as Json };
};
const setWorkflow = async (boardId: string, settings: Json, transitions: Json[]) =>
  as(admin).patch(`/boards/${boardId}/columns/stage`, {
    settings: { ...settings, workflow: { enabled: true, free_start: true, transitions } },
  });
const newItem = async (boardId: string) =>
  (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Task', cells: { stage: { index: 0 } } })))
    .id as string;
const stageOf = async (itemId: string) => (await body(await as(admin).get(`/items/${itemId}`))).cells.stage?.value;
const subitemsOf = async (subId: string, parentId: string) =>
  ((await body(await as(admin).get(`/boards/${subId}/items`))).data as Json[]).filter(
    (x) => x.parent_item_id === parentId,
  );

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
  ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('workflow: subitems a move needs', () => {
  it('blocks the move until enough subitems have the required values', async () => {
    const { boardId, settings } = await setup('WS 1');
    expect(
      (await setWorkflow(boardId, settings, [{ from: 0, to: 1, subitems: { min: 1, required: ['amount'] } }])).status,
    ).toBe(200);
    const id = await newItem(boardId);

    const none = await as(admin).patch(`/items/${id}`, { cells: { stage: { index: 1 } } });
    expect(none.status).toBe(409);
    const d = (await body(none)).error.details;
    expect(d).toMatchObject({ reason: 'subitems', min: 1, have: 0, columns: [{ id: 'amount', title: 'Amount' }] });

    // A subitem without the amount does not count.
    const sub = (await body(await as(admin).post(`/items/${id}/subitems`, { name: 'Line 1' }))).id as string;
    const empty = await as(admin).patch(`/items/${id}`, { cells: { stage: { index: 1 } } });
    expect(empty.status).toBe(409);
    expect((await body(empty)).error.details).toMatchObject({ reason: 'subitems', have: 0, incomplete: 1 });

    // Filled in from the popup, with the move: passes.
    const ok = await as(admin).patch(`/items/${id}`, {
      cells: { stage: { index: 1 } },
      subitems: { update: [{ id: sub, cells: { amount: 120 } }] },
    });
    expect(ok.status).toBe(200);
    expect(await stageOf(id)).toEqual({ index: 1 });
  });

  it('adds subitems with the move in one write, and one undo takes all of it back', async () => {
    const { boardId, subId, settings } = await setup('WS 2');
    await setWorkflow(boardId, settings, [{ from: 0, to: 1, subitems: { min: 2, required: ['amount'] } }]);
    const id = await newItem(boardId);

    // One complete subitem is not enough: nothing of the refused write stays.
    const short = await as(admin).patch(`/items/${id}`, {
      cells: { stage: { index: 1 } },
      subitems: { create: [{ name: 'A', cells: { amount: 1 } }] },
    });
    expect(short.status).toBe(409);
    expect(await subitemsOf(subId, id)).toHaveLength(0);
    expect(await stageOf(id)).toEqual({ index: 0 });

    const ok = await as(admin).patch(`/items/${id}`, {
      cells: { stage: { index: 1 } },
      subitems: {
        create: [
          { name: 'A', cells: { amount: 1 } },
          { name: 'B', cells: { amount: 2 } },
        ],
      },
    });
    expect(ok.status).toBe(200);
    const created = await subitemsOf(subId, id);
    expect(created.map((x) => x.name).sort()).toEqual(['A', 'B']);
    expect(created.every((x) => x.cells.amount?.value === 2 || x.cells.amount?.value === 1)).toBe(true);

    const undo = await as(admin).post(`/activity/${(await body(ok)).event_id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(await stageOf(id)).toEqual({ index: 0 });
    expect(await subitemsOf(subId, id)).toHaveLength(0);
  });

  it('"all" needs every subitem complete; "only if" leaves the others out', async () => {
    const { boardId, settings } = await setup('WS 3');
    await setWorkflow(boardId, settings, [{ from: 0, to: 1, subitems: { min: 1, required: ['amount'], all: true } }]);
    const id = await newItem(boardId);
    await as(admin).post(`/items/${id}/subitems`, { name: 'Full', cells: { amount: 5 } });
    const half = (await body(await as(admin).post(`/items/${id}/subitems`, { name: 'Half' }))).id as string;
    const blocked = await as(admin).patch(`/items/${id}`, { cells: { stage: { index: 1 } } });
    expect(blocked.status).toBe(409);
    expect((await body(blocked)).error.details).toMatchObject({
      reason: 'subitems',
      all: true,
      have: 1,
      incomplete: 1,
    });

    // Count only subitems whose status is not "Blocked" (2): the half one is set to Blocked and drops out.
    const onlyIf = {
      kind: 'group',
      operator: 'and',
      rules: [{ kind: 'rule', column_id: 'status', operator: 'not_any_of', values: [2] }],
    };
    expect(
      (
        await setWorkflow(boardId, settings, [
          { from: 0, to: 1, subitems: { min: 1, required: ['amount'], all: true, conditions: onlyIf } },
        ])
      ).status,
    ).toBe(200);
    await as(admin).patch(`/items/${half}`, { cells: { status: { index: 2 } } });
    expect((await as(admin).patch(`/items/${id}`, { cells: { stage: { index: 1 } } })).status).toBe(200);
  });

  it('a rule on a sub-board column that does not exist is refused when saved', async () => {
    const { boardId, settings } = await setup('WS 4');
    const res = await setWorkflow(boardId, settings, [{ from: 0, to: 1, subitems: { min: 1, required: ['nope'] } }]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await body(res))).toContain('workflow_unknown_column:nope');
  });

  it('a popup button adds subitems with the click and checks its own minimum', async () => {
    const { boardId, subId } = await setup('WS 5');
    expect(
      (
        await as(admin).post(`/boards/${boardId}/columns`, {
          id: 'ask',
          title: 'Ask',
          type: 'button',
          settings: {
            action: {
              kind: 'popup',
              popup: {
                fields: [],
                subitems: { fields: [{ column_id: 'name', required: true }, { column_id: 'amount' }], min: 1 },
              },
            },
          },
        })
      ).status,
    ).toBe(201);
    const id = await newItem(boardId);
    const missing = await as(admin).post(`/items/${id}/buttons/ask`, {});
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await body(missing))).toContain('popup_subitems');
    // Only the popup's own sub-board columns.
    const foreign = await as(admin).post(`/items/${id}/buttons/ask`, {
      subitems: { create: [{ name: 'X', cells: { date: { date: '2026-11-01' } } }] },
    });
    expect(foreign.status).toBe(422);
    const ok = await as(admin).post(`/items/${id}/buttons/ask`, {
      subitems: { create: [{ name: 'Line', cells: { amount: 7 } }] },
    });
    expect(ok.status).toBe(200);
    const subs = await subitemsOf(subId, id);
    expect(subs.map((x) => [x.name, x.cells.amount?.value])).toEqual([['Line', 7]]);
  });
});
