// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M8 ד7 (03 §3.2, D25): the dependency column — links, kind / lag, cycles, shifting per mode, one-step undo. */
let t: TestContext;
let admin: string;
let viewer: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newBoard = async (name: string) => body(await as(admin).post('/boards', { name, workspace_id: wsId }));
const addItem = async (boardId: string, name: string, cells?: Json) =>
  body(await as(admin).post(`/boards/${boardId}/items`, { name, ...(cells ? { cells } : {}) }));
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const put = (id: string, key: string, value: unknown, cookie = admin) =>
  as(cookie).put(`/items/${id}/cells/${key}`, { value });
const span = async (id: string, key = 'tl') => (await getItem(id)).cells[key]?.value as Json | undefined;

/** A board with a timeline and a dependency column in `mode`, and items a → b → c (each depends on the one before). */
const setup = async (mode: 'strict' | 'flexible' | 'visual') => {
  const board = await newBoard(`Deps ${mode}`);
  await as(admin).post(`/boards/${board.id}/columns`, { id: 'tl', title: 'Timeline', type: 'timeline' });
  const dep = await body(
    await as(admin).post(`/boards/${board.id}/columns`, {
      id: 'deps',
      title: 'Depends on',
      type: 'dependency',
      settings: { mode, date_column_id: 'tl' },
    }),
  );
  const a = await addItem(board.id, 'A', { tl: { from: '2026-10-01', to: '2026-10-03' } });
  const b = await addItem(board.id, 'B', { tl: { from: '2026-10-06', to: '2026-10-07' } });
  const c = await addItem(board.id, 'C', { tl: { from: '2026-10-10', to: '2026-10-12' } });
  expect((await put(b.id, 'deps', { item_ids: [a.id] })).status).toBe(200);
  expect((await put(c.id, 'deps', { item_ids: [b.id] })).status).toBe(200);
  return { board, dep, a, b, c };
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['viewer@acme.test'], role: 'viewer' });
  viewer = await join('viewer@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('dependency column', () => {
  it('is created, configured and validated like any column; a viewer cannot change it', async () => {
    const board = await newBoard('Deps CRUD');
    const created = await as(admin).post(`/boards/${board.id}/columns`, { title: 'Deps', type: 'dependency' });
    expect(created.status).toBe(201);
    const col = await body(created);
    expect(col.type).toBe('dependency');
    expect(col.settings.mode).toBe('flexible');
    const patched = await as(admin).patch(`/boards/${board.id}/columns/${col.id}`, { settings: { mode: 'strict' } });
    expect(patched.status).toBe(200);
    expect((await body(patched)).settings.mode).toBe('strict');
    expect(
      (await as(admin).patch(`/boards/${board.id}/columns/${col.id}`, { settings: { mode: 'sideways' } })).status,
    ).toBe(400);
    expect((await as(viewer).post(`/boards/${board.id}/columns`, { title: 'X', type: 'dependency' })).status).toBe(403);
  });

  it('stores kind and lag per link, refuses other boards, itself and loops', async () => {
    const { board, a, b, c } = await setup('visual');
    const res = await put(b.id, 'deps', { item_ids: [a.id], kind: { [a.id]: 'SS' }, lag_days: { [a.id]: 2 } });
    expect(res.status).toBe(200);
    expect((await body(res)).cells.deps.value).toEqual({
      item_ids: [a.id],
      kind: { [a.id]: 'SS' },
      lag_days: { [a.id]: 2 },
    });
    expect((await getItem(b.id)).cells.deps.value.kind).toEqual({ [a.id]: 'SS' });

    const other = await newBoard('Elsewhere');
    const foreign = await addItem(other.id, 'Foreign');
    expect((await put(b.id, 'deps', { item_ids: [foreign.id] })).status).toBe(422);
    const self = await put(b.id, 'deps', { item_ids: [b.id] });
    expect(self.status).toBe(422);
    expect((await body(self)).error.code).toBe('dependency_cycle');
    // a → c closes a → c → b → a.
    const loop = await put(a.id, 'deps', { item_ids: [c.id] });
    expect(loop.status).toBe(422);
    expect((await body(loop)).error.code).toBe('dependency_cycle');
    expect((await put(b.id, 'deps', { item_ids: [a.id], kind: { [a.id]: 'XX' } })).status).toBe(422);
    // A viewer cannot link.
    expect((await put(c.id, 'deps', { item_ids: [a.id] }, viewer)).status).toBe(403);
    expect(board.id).toBeTruthy();
  });

  it('strict: moving a predecessor shifts the whole chain, and one undo puts all of it back', async () => {
    const { a, b, c } = await setup('strict');
    const res = await body(await put(a.id, 'tl', { from: '2026-10-03', to: '2026-10-05' }));
    expect(res.shifted_item_ids.sort()).toEqual([b.id, c.id].sort());
    expect(await span(b.id)).toEqual({ from: '2026-10-08', to: '2026-10-09' });
    expect(await span(c.id)).toEqual({ from: '2026-10-12', to: '2026-10-14' });
    // Back again (strict follows both ways).
    const back = await body(await put(a.id, 'tl', { from: '2026-10-01', to: '2026-10-03' }));
    expect(back.shifted_item_ids).toHaveLength(2);
    expect(await span(b.id)).toEqual({ from: '2026-10-06', to: '2026-10-07' });

    const moved = await body(await put(a.id, 'tl', { from: '2026-10-11', to: '2026-10-13' }));
    expect((await as(admin).post(`/activity/${moved.event_id}/undo`, {})).status).toBe(200);
    expect(await span(a.id)).toEqual({ from: '2026-10-01', to: '2026-10-03' });
    expect(await span(b.id)).toEqual({ from: '2026-10-06', to: '2026-10-07' });
    expect(await span(c.id)).toEqual({ from: '2026-10-10', to: '2026-10-12' });
  });

  it('flexible: shifts only on overlap, never pulls back', async () => {
    const { a, b, c } = await setup('flexible');
    const small = await body(await put(a.id, 'tl', { from: '2026-10-01', to: '2026-10-04' }));
    expect(small.shifted_item_ids).toBeUndefined();
    const big = await body(await put(a.id, 'tl', { from: '2026-10-01', to: '2026-10-08' }));
    expect(big.shifted_item_ids.sort()).toEqual([b.id, c.id].sort());
    expect(await span(b.id)).toEqual({ from: '2026-10-09', to: '2026-10-10' });
    expect(await span(c.id)).toEqual({ from: '2026-10-11', to: '2026-10-13' });
    const back = await body(await put(a.id, 'tl', { from: '2026-09-01', to: '2026-09-02' }));
    expect(back.shifted_item_ids).toBeUndefined();
    expect(await span(b.id)).toEqual({ from: '2026-10-09', to: '2026-10-10' });
  });

  it('flexible: a new link that is already broken moves the item after its predecessor', async () => {
    const { a, c } = await setup('flexible');
    // c depends on b; now also on a with a 20-day lag → c must start after 2026-10-23.
    const res = await body(await put(c.id, 'deps', { item_ids: [a.id], lag_days: { [a.id]: 20 } }));
    expect(res.cells.tl.value).toEqual({ from: '2026-10-24', to: '2026-10-26' });
  });

  it('visual: arrows only, nothing moves', async () => {
    const { a, b } = await setup('visual');
    const res = await body(await put(a.id, 'tl', { from: '2026-11-01', to: '2026-11-08' }));
    expect(res.shifted_item_ids).toBeUndefined();
    expect(await span(b.id)).toEqual({ from: '2026-10-06', to: '2026-10-07' });
  });

  it('moves a date column too (a dependency on a date column)', async () => {
    const board = await newBoard('Deps date');
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'due', title: 'Due', type: 'date' });
    await as(admin).post(`/boards/${board.id}/columns`, {
      id: 'deps',
      title: 'Deps',
      type: 'dependency',
      settings: { mode: 'strict' },
    });
    const a = await addItem(board.id, 'A', { due: { date: '2026-10-01' } });
    const b = await addItem(board.id, 'B', { due: { date: '2026-10-05' } });
    await put(b.id, 'deps', { item_ids: [a.id] });
    await put(a.id, 'due', { date: '2026-10-03' });
    expect((await getItem(b.id)).cells.due.value.date).toBe('2026-10-07');
  });
});

describe('timeline / gantt / workload views', () => {
  it('are saved like any view, with their settings', async () => {
    const board = await newBoard('Views M8');
    const cases: [string, Json][] = [
      ['timeline', { timeline: { zoom: 'month', group_by: '__none__' } }],
      ['gantt', { gantt: { dependency_column_id: 'deps', show_critical: true } }],
      ['workload', { workload: { measure: 'column', capacity: 6, capacity_overrides: { u1: 4 } } }],
    ];
    for (const [type, settings] of cases) {
      const res = await as(admin).post(`/boards/${board.id}/views`, { name: type, type, settings });
      expect(res.status).toBe(201);
      const view = await body(res);
      expect(view.type).toBe(type);
      expect(view.settings[type]).toMatchObject(settings[type]);
    }
    const bad = await as(admin).post(`/boards/${board.id}/views`, {
      name: 'bad',
      type: 'workload',
      settings: { workload: { measure: 'hours' } },
    });
    expect(bad.status).toBe(400);
  });
});

describe('working days', () => {
  /** A timeline counted in working days (Israeli holidays by default) that keeps its working days on a move. */
  const workBoard = async (mode: 'strict' | 'flexible') => {
    const board = await newBoard(`Deps workdays ${mode}`);
    await as(admin).post(`/boards/${board.id}/columns`, {
      id: 'tl',
      title: 'Timeline',
      type: 'timeline',
      settings: { duration: 'workdays', keep_workdays: true },
    });
    await as(admin).post(`/boards/${board.id}/columns`, {
      id: 'deps',
      title: 'Depends on',
      type: 'dependency',
      settings: { mode, date_column_id: 'tl' },
    });
    return board;
  };

  it('a new link pushes the dependent to the next working day (over Rosh Hashana)', async () => {
    const board = await workBoard('flexible');
    const a = await addItem(board.id, 'A', { tl: { from: '2026-09-08', to: '2026-09-10' } });
    const b = await addItem(board.id, 'B', { tl: { from: '2026-09-11', to: '2026-09-11' } });
    expect((await put(b.id, 'deps', { item_ids: [a.id] })).status).toBe(200);
    // Fri 11, Sat 12 and Sun 13/09 (Rosh Hashana II) are no working days → Mon 14/09.
    expect(await span(b.id)).toMatchObject({ from: '2026-09-14', to: '2026-09-14' });
  });

  it('strict: a dependent moves as many working days as its predecessor, keeping its working days', async () => {
    const board = await workBoard('strict');
    const a = await addItem(board.id, 'A', { tl: { from: '2026-09-06', to: '2026-09-08' } });
    const b = await addItem(board.id, 'B', { tl: { from: '2026-09-17', to: '2026-09-20' } });
    expect((await put(b.id, 'deps', { item_ids: [a.id] })).status).toBe(200);
    expect((await put(a.id, 'tl', { from: '2026-09-06', to: '2026-09-09' })).status).toBe(200);
    // One working day later: from Thu 17/09, Sun 20/09 is only half a day (erev Yom Kippur) and Mon 21/09 is Yom
    // Kippur → Tue 22/09; its 1½ working days (Thu + the half day) end on Wed 23/09.
    expect(await span(b.id)).toMatchObject({ from: '2026-09-22', to: '2026-09-23' });
  });

  it('WORKDAYS / ADD_WORKDAYS formulas follow the account calendar', async () => {
    const board = await newBoard('Formula workdays');
    for (const [id, formula] of [
      ['wd', 'WORKDAYS("2026-09-24","2026-09-10")'],
      ['next', 'ADD_WORKDAYS("2026-09-10",1)'],
    ])
      await as(admin).post(`/boards/${board.id}/columns`, { id, title: id, type: 'formula', settings: { formula } });
    const item = await getItem((await addItem(board.id, 'F')).id);
    // 11 weekdays − Rosh Hashana II − Yom Kippur − ½ erev Yom Kippur; Thu 10/09 + 1 → Mon 14/09.
    expect(item.cells.wd.value).toEqual({ result: 8.5 });
    expect(item.cells.next.value).toEqual({ result: '2026-09-14' });
  });

  it('bulk "shift dates" counts the column\'s working days', async () => {
    const board = await workBoard('flexible');
    const a = await addItem(board.id, 'A', { tl: { from: '2026-12-31', to: '2026-12-31' } });
    const res = await as(admin).post(`/boards/${board.id}/items/bulk`, {
      item_ids: [a.id],
      action: { type: 'shift_dates', column_id: 'tl', days: 1 },
    });
    expect(res.status).toBe(200);
    // Thu 31/12 + 1 working day → Sun 03/01/2027.
    expect(await span(a.id)).toMatchObject({ from: '2027-01-03', to: '2027-01-03' });
  });
});
