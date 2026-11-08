// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * round 2 — a move's conditions on other columns ("finance status = paid in full"): a blocked move names
 * each condition that is not met with the item's value now, and the move's own message; values set in the same
 * write (the popup) count. A subitems rule may ask every counted subitem to meet conditions too (`each`).
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let ws: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const and = (rules: Json[]) => ({ kind: 'group', operator: 'and', negate: false, rules });
const or = (rules: Json[]) => ({ kind: 'group', operator: 'or', negate: false, rules });
const rule = (column_id: string, operator: string, values: unknown[] = []) => ({
  kind: 'rule',
  column_id,
  operator,
  values,
  negate: false,
});

// Labels of a new status column: 0 In progress, 1 Done, 2 Blocked (the defaults).
const setup = async (name: string) => {
  const board = await body(await as(admin).post('/boards', { name, workspace_id: ws }));
  const stage = await body(
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'stage', title: 'Stage', type: 'status' }),
  );
  const finance = await body(
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'finance', title: 'Finance', type: 'status' }),
  );
  expect(
    (await as(admin).post(`/boards/${board.id}/columns`, { id: 'total', title: 'Total', type: 'numbers' })).status,
  ).toBe(201);
  const doneLabel = (finance.settings.labels as { id: number; label: string }[]).find((l) => l.id === 1)!.label;
  return { boardId: board.id as string, settings: stage.settings as Json, doneLabel };
};
const setWorkflow = async (boardId: string, settings: Json, transitions: Json[]) =>
  as(admin).patch(`/boards/${boardId}/columns/stage`, {
    settings: { ...settings, workflow: { enabled: true, free_start: true, transitions } },
  });
const newItem = async (boardId: string, cells: Json = {}) =>
  (
    await body(
      await as(admin).post(`/boards/${boardId}/items`, { name: 'Deal', cells: { stage: { index: 0 }, ...cells } }),
    )
  ).id as string;
const stageOf = async (itemId: string) => (await body(await as(admin).get(`/items/${itemId}`))).cells.stage?.value;

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

describe('workflow: conditions on other columns ( round 2)', () => {
  it('names each condition not met, with the value now and the move’s own message', async () => {
    const { boardId, settings, doneLabel } = await setup('WC 1');
    expect(
      (
        await setWorkflow(boardId, settings, [
          {
            from: 0,
            to: 1,
            conditions: and([rule('finance', 'any_of', ['1']), rule('total', 'greater_than', [0])]),
            message: 'No closing before full payment',
          },
        ])
      ).status,
    ).toBe(200);
    const id = await newItem(boardId, { finance: { index: 0 }, total: 500 });

    const res = await as(admin).patch(`/items/${id}`, { cells: { stage: { index: 1 } } });
    expect(res.status).toBe(409);
    const d = (await body(res)).error.details;
    expect(d.reason).toBe('conditions');
    expect(d.message).toBe('No closing before full payment');
    expect(d.any).toBe(false);
    // Only the finance status fails (the total is above 0).
    expect(d.failed).toHaveLength(1);
    expect(d.failed[0]).toMatchObject({
      column_id: 'finance',
      title: 'Finance',
      operator: 'any_of',
      values: [doneLabel],
    });
    expect(typeof d.failed[0].current).toBe('string');
    expect(d.failed[0].current).not.toBe(doneLabel);
    expect(await stageOf(id)).toEqual({ index: 0 });

    // Set in the same write (the popup): the move passes.
    const ok = await as(admin).patch(`/items/${id}`, { cells: { finance: { index: 1 }, stage: { index: 1 } } });
    expect(ok.status).toBe(200);
    expect(await stageOf(id)).toEqual({ index: 1 });
  });

  it('lists every part of an "or" and says one is enough; an empty value reads as empty', async () => {
    const { boardId, settings } = await setup('WC 2');
    await setWorkflow(boardId, settings, [
      { from: 0, to: 1, conditions: or([rule('finance', 'any_of', ['1']), rule('total', 'is_not_empty')]) },
    ]);
    const id = await newItem(boardId);
    const res = await as(admin).patch(`/items/${id}`, { cells: { stage: { index: 1 } } });
    expect(res.status).toBe(409);
    const d = (await body(res)).error.details;
    expect(d.any).toBe(true);
    expect(d.message).toBeUndefined();
    expect(d.failed.map((f: Json) => f.column_id)).toEqual(['finance', 'total']);
    expect(d.failed[1]).toMatchObject({ operator: 'is_not_empty', current: null });

    // One of them is enough.
    expect((await as(admin).patch(`/items/${id}`, { cells: { total: 3, stage: { index: 1 } } })).status).toBe(200);
  });

  it('a subitems rule may ask every counted subitem to meet conditions (each)', async () => {
    const { boardId, settings } = await setup('WC 3');
    const id = await newItem(boardId);
    const first = (await body(await as(admin).post(`/items/${id}/subitems`, { name: 'Line 1' }))).id as string;
    const subId = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id as string;
    expect(
      (await as(admin).post(`/boards/${subId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' })).status,
    ).toBe(201);
    await setWorkflow(boardId, settings, [
      { from: 0, to: 1, subitems: { min: 1, required: [], each: and([rule('amount', 'greater_than', [0])]) } },
    ]);

    const res = await as(admin).patch(`/items/${id}`, { cells: { stage: { index: 1 } } });
    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toMatchObject({ reason: 'subitems', have: 0, failing: 1 });

    // Filled in from the popup with the move: the subitem meets the condition, and the move passes.
    const ok = await as(admin).patch(`/items/${id}`, {
      cells: { stage: { index: 1 } },
      subitems: { update: [{ id: first, cells: { amount: 10 } }] },
    });
    expect(ok.status).toBe(200);
    expect(await stageOf(id)).toEqual({ index: 1 });
  });

  it('keeps the message and the each conditions in the saved workflow', async () => {
    const { boardId, settings } = await setup('WC 4');
    const each = and([rule('name', 'is_not_empty')]);
    await setWorkflow(boardId, settings, [
      { from: 0, to: 1, message: '  Pay first  ', subitems: { min: 1, required: [], each } },
    ]);
    const col = ((await body(await as(admin).get(`/boards/${boardId}`))).columns as Json[]).find(
      (c) => c.id === 'stage',
    )!;
    const move = col.settings.workflow.transitions[0];
    expect(move.message).toBe('Pay first');
    expect(move.subitems.each).toMatchObject({ kind: 'group', rules: [{ column_id: 'name' }] });
  });
});
