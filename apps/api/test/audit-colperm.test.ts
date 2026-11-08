// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Audit 2026-10-10 (permissions), the three HIGH findings — a column restricted to `view` (05 §6.1) is not written
 * blind (#1), not read through a formula or a mirror (#2), and a move between boards neither carries it out nor
 * writes into a target column the actor may not edit (#3). Owners and admins keep every column.
 */
let t: TestContext;
let admin: string;
let bob: string; // member, an editor on the boards below
let acmeId: string;
let ws: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** A board of admin's with a `salary` column only owners see, and a visible `notes` column. */
const hrBoard = async (name: string) => {
  const board = await body(await as(admin).post('/boards', { name, workspace_id: ws }));
  await as(admin).post(`/boards/${board.id}/columns`, { id: 'salary', title: 'Salary', type: 'numbers' });
  await as(admin).post(`/boards/${board.id}/columns`, { id: 'due', title: 'Due', type: 'date' });
  await as(admin).post(`/boards/${board.id}/columns`, { id: 'notes', title: 'Notes', type: 'text' });
  const item = await body(
    await as(admin).post(`/boards/${board.id}/items`, {
      name: 'Dana',
      cells: { salary: 12345, due: { date: '2026-10-01' }, notes: 'ok' },
    }),
  );
  expect((await as(admin).put(`/boards/${board.id}/columns/salary/restriction`, { kind: 'view' })).status).toBe(200);
  expect((await as(admin).put(`/boards/${board.id}/columns/due/restriction`, { kind: 'view' })).status).toBe(200);
  return { boardId: board.id as string, itemId: item.id as string };
};
const adminCell = async (itemId: string, key: string) =>
  (await body(await as(admin).get(`/items/${itemId}`))).cells[key];

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
  ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('#1 a view-restricted column is not writable', () => {
  it('item update, cell PUT, create with cells, bulk set_cell / shift_dates: 404 for a member; owners write', async () => {
    const { boardId, itemId } = await hrBoard('HR 1');
    expect((await as(bob).patch(`/items/${itemId}`, { cells: { salary: 1 } })).status).toBe(404);
    expect((await as(bob).put(`/items/${itemId}/cells/salary`, { value: 1 })).status).toBe(404);
    expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'X', cells: { salary: 1 } })).status).toBe(404);
    const bulk = (action: Json) => as(bob).post(`/boards/${boardId}/items/bulk`, { item_ids: [itemId], action });
    expect((await bulk({ type: 'set_cell', column_id: 'salary', value: 1 })).status).toBe(404);
    expect((await bulk({ type: 'shift_dates', column_id: 'due', days: 3 })).status).toBe(404);
    expect((await adminCell(itemId, 'salary')).value).toBe(12345);
    expect((await adminCell(itemId, 'due')).value).toEqual({ date: '2026-10-01' });

    // Normal flows: the member writes a visible column; the admin writes the restricted one.
    expect((await as(bob).patch(`/items/${itemId}`, { cells: { notes: 'bob was here' } })).status).toBe(200);
    expect((await bulk({ type: 'set_cell', column_id: 'notes', value: 'bulk' })).status).toBe(200);
    expect((await as(admin).patch(`/items/${itemId}`, { cells: { salary: 20000 } })).status).toBe(200);
    expect((await adminCell(itemId, 'salary')).value).toBe(20000);
  });

  it('undo of a change made before the column was hidden does not write it', async () => {
    const { boardId, itemId } = await hrBoard('HR 2');
    await as(admin).put(`/boards/${boardId}/columns/salary/restriction`, { kind: null });
    expect((await as(bob).put(`/items/${itemId}/cells/salary`, { value: 1 })).status).toBe(200);
    const ev = (
      await t.db.execute<{ id: string }>(
        sql`select id from activity_log where item_id = ${itemId} and type = 'cell.changed' order by created_at desc limit 1`,
      )
    ).rows[0]!;
    await as(admin).put(`/boards/${boardId}/columns/salary/restriction`, { kind: 'view' });
    expect((await as(bob).post(`/activity/${ev.id}/undo`, {})).status).not.toBe(200);
    expect((await adminCell(itemId, 'salary')).value).toBe(1);
  });
});

describe('#2 formulas and mirrors do not read a hidden column', () => {
  it('same board: a formula over the hidden column is empty for a member, computed for the admin', async () => {
    const { boardId, itemId } = await hrBoard('HR 3');
    const res = await as(admin).post(`/boards/${boardId}/columns`, {
      id: 'double',
      title: 'Double',
      type: 'formula',
      settings: { formula: '{salary}*2' },
    });
    expect(res.status).toBe(201);
    await as(admin).post(`/boards/${boardId}/columns`, {
      id: 'plain',
      title: 'Plain',
      type: 'formula',
      settings: { formula: 'LEN({notes})' },
    });
    expect((await adminCell(itemId, 'double')).text).toBe('24690');
    const mine = (await body(await as(bob).get(`/items/${itemId}`))).cells;
    expect(mine.double?.text ?? null).toBeNull();
    expect(mine.plain.text).toBe('2'); // a formula over visible columns still works
    const rows = (await body(await as(bob).get(`/boards/${boardId}/items`))).data as Json[];
    expect(rows.find((r) => r.id === itemId)!.cells.double?.text ?? null).toBeNull();
  });

  it('another board: a mirror of the hidden column is empty for a member, shown to the admin', async () => {
    const { boardId: hr, itemId } = await hrBoard('HR 4');
    const projects = await body(await as(admin).post('/boards', { name: 'Projects', workspace_id: ws }));
    await as(admin).post(`/boards/${projects.id}/columns`, {
      id: 'rel',
      title: 'Person',
      type: 'board_relation',
      settings: { board_ids: [hr], allow_multiple: true },
    });
    await as(admin).post(`/boards/${projects.id}/columns`, {
      id: 'pay',
      title: 'Pay',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'salary' },
    });
    await as(admin).post(`/boards/${projects.id}/columns`, {
      id: 'note',
      title: 'Note',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'notes' },
    });
    const row = await body(
      await as(admin).post(`/boards/${projects.id}/items`, { name: 'P1', cells: { rel: { item_ids: [itemId] } } }),
    );
    expect(row.cells.pay.text).toBe('12,345');
    const mine = (await body(await as(bob).get(`/items/${row.id}`))).cells;
    expect(mine.pay?.text ?? null).toBeNull();
    expect(mine.note.text).toBe('ok'); // a mirror of a visible column still works
  });
});

describe('#3 move to another board respects column restrictions on both sides', () => {
  it('a hidden source column is not carried into a readable target column', async () => {
    const { itemId } = await hrBoard('HR 5');
    const mine = await body(await as(bob).post('/boards', { name: 'Bob board', workspace_id: ws }));
    await as(bob).post(`/boards/${mine.id}/columns`, { id: 'copy', title: 'Copy', type: 'numbers' });
    await as(bob).post(`/boards/${mine.id}/columns`, { id: 'text', title: 'Text', type: 'text' });
    const res = await as(bob).post(`/items/${itemId}/move-to-board`, {
      board_id: mine.id,
      mapping: { salary: 'copy', notes: 'text' },
    });
    expect(res.status).toBe(200);
    const moved = (await body(await as(bob).get(`/items/${itemId}`))).cells;
    expect(moved.copy).toBeUndefined();
    expect(moved.text.value).toBe('ok'); // visible columns move as before

    // The automatic mapping (no mapping sent) leaves it out too.
    const again = await hrBoard('HR 6');
    await as(bob).post(`/boards/${mine.id}/columns`, { id: 'salary_b', title: 'Salary', type: 'numbers' });
    expect((await as(bob).post(`/items/${again.itemId}/move-to-board`, { board_id: mine.id })).status).toBe(200);
    expect((await body(await as(bob).get(`/items/${again.itemId}`))).cells.salary_b).toBeUndefined();
  });

  it('a target column the actor may not edit is refused (403); without it the move goes through', async () => {
    const source = await body(await as(bob).post('/boards', { name: 'Bob source', workspace_id: ws }));
    await as(bob).post(`/boards/${source.id}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
    const item = await body(await as(bob).post(`/boards/${source.id}/items`, { name: 'Deal', cells: { amount: 7 } }));
    const target = await body(await as(admin).post('/boards', { name: 'Finance', workspace_id: ws }));
    await as(admin).post(`/boards/${target.id}/columns`, { id: 'budget', title: 'Budget', type: 'numbers' });
    await as(admin).post(`/boards/${target.id}/columns`, { id: 'open', title: 'Open', type: 'numbers' });
    await as(admin).put(`/boards/${target.id}/columns/budget/restriction`, { kind: 'edit' });

    const refused = await as(bob).post(`/items/${item.id}/move-to-board`, {
      board_id: target.id,
      mapping: { amount: 'budget' },
    });
    expect(refused.status).toBe(403);
    expect((await body(await as(bob).get(`/items/${item.id}`))).board_id).toBe(source.id);

    const ok = await as(bob).post(`/items/${item.id}/move-to-board`, {
      board_id: target.id,
      mapping: { amount: 'open' },
    });
    expect(ok.status).toBe(200);
    expect((await adminCell(item.id, 'open')).value).toBe(7);
  });
});

describe('follow-up: computed item names never carry a hidden column', () => {
  it('a name built on a column (or a formula over it) leaves it out once hidden, and shows it again after', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'HR names', workspace_id: ws }));
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'code', title: 'Code', type: 'text' });
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'pay', title: 'Pay', type: 'numbers' });
    await as(admin).post(`/boards/${board.id}/columns`, {
      id: 'twice',
      title: 'Twice',
      type: 'formula',
      settings: { formula: '{pay}*2' },
    });
    const set = await as(admin).put(`/boards/${board.id}/name-source`, {
      mode: 'template',
      template: '{code} {pay} {twice}',
      empty_text: 'New',
    });
    expect(set.status).toBe(200);
    const item = await body(await as(admin).post(`/boards/${board.id}/items`, { cells: { code: 'E-1', pay: 500 } }));
    const nameFor = async (who: string) => (await body(await as(who).get(`/items/${item.id}`))).name as string;
    expect(await nameFor(bob)).toContain('500');

    expect((await as(admin).put(`/boards/${board.id}/columns/pay/restriction`, { kind: 'view' })).status).toBe(200);
    expect(await nameFor(bob)).toContain('E-1');
    expect(await nameFor(bob)).not.toContain('500');
    expect(await nameFor(bob)).not.toContain('1000');
    // New writes keep it out too.
    await as(admin).patch(`/items/${item.id}`, { cells: { pay: 700 } });
    expect(await nameFor(bob)).not.toContain('700');

    await as(admin).put(`/boards/${board.id}/columns/pay/restriction`, { kind: null });
    expect(await nameFor(bob)).toContain('700');
  });
});
