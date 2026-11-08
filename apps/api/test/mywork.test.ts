// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, dateInZone } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M4 step 5 (07 §9.2, 06 §2.23): My Work — my items by deadline, across boards, within my access. */
let t: TestContext;
let admin: string;
let bob: string;
let dana: string; // in team Sales
let acmeId: string;
let ids: Record<'admin' | 'bob' | 'dana', string>;
let salesId: string;
let boardId: string;
let keys: Record<'owner' | 'due' | 'due2' | 'status', string>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const today = dateInZone(new Date(), 'Asia/Jerusalem');

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const work = async (cookie: string) => body(await as(cookie).get('/me/work'));
/** `{ section: [names] }` for the non-empty sections. */
const sections = (w: Json) =>
  Object.fromEntries(
    (w.sections as Json[]).filter((s) => s.items.length).map((s) => [s.key, s.items.map((i: Json) => i.name)]),
  );
const person = (id: string) => ({ persons_and_teams: [{ kind: 'person', id }] });
const item = async (board: string, name: string, cells: Record<string, unknown>) =>
  (await body(await as(admin).post(`/boards/${board}/items`, { name, cells }))).id as string;
const column = async (board: string, title: string, type: string) =>
  (await body(await as(admin).post(`/boards/${board}/columns`, { title, type }))).id as string;

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
  salesId = (await body(await as(admin).post('/teams', { name: 'Sales', member_ids: [ids.dana] }))).id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: ws.id }))).id;
  keys = {
    owner: await column(boardId, 'Owner', 'people'),
    due: await column(boardId, 'Due', 'date'),
    due2: await column(boardId, 'Follow-up', 'date'),
    status: await column(boardId, 'Stage', 'status'),
  };
  const due = (d: number) => ({ date: addDays(today, d) });
  await item(boardId, 'Overdue', { [keys.owner]: person(ids.bob), [keys.due]: due(-2) });
  await item(boardId, 'Today', { [keys.owner]: person(ids.bob), [keys.due]: due(0), [keys.due2]: due(-5) });
  await item(boardId, 'Later', { [keys.owner]: person(ids.bob), [keys.due]: due(40) });
  await item(boardId, 'Undated', { [keys.owner]: person(ids.bob) });
  await item(boardId, 'Done', { [keys.owner]: person(ids.bob), [keys.due]: due(0), [keys.status]: { index: 1 } });
  await item(boardId, 'Not mine', { [keys.owner]: person(ids.admin), [keys.due]: due(0) });
  await item(boardId, 'Team task', {
    [keys.owner]: { persons_and_teams: [{ kind: 'team', id: salesId }] },
    [keys.due]: due(1),
  });
});
afterAll(() => t.close());

describe('GET /me/work', () => {
  it('buckets my items by the board’s first date column; done items hidden', async () => {
    const w = await work(bob);
    expect(w.today).toBe(today);
    expect(sections(w)).toEqual({
      past: ['Overdue'],
      today: ['Today'],
      later: ['Later'],
      no_date: ['Undated'],
    });
    expect(w.truncated).toBe(false);
    expect(w.settings).toEqual({ hide_done: true, group_by: 'date', subitems: true, boards: {} });
    expect(w.boards).toEqual([
      expect.objectContaining({
        id: boardId,
        name: 'Deals',
        hidden: false,
        can_edit: true,
        date_column: expect.objectContaining({ id: keys.due, type: 'date' }),
        status_column: expect.objectContaining({ id: keys.status, type: 'status' }),
        people_column: expect.objectContaining({ id: keys.owner }),
        date_choices: [
          { key: keys.due, title: 'Due' },
          { key: keys.due2, title: 'Follow-up' },
        ],
      }),
    ]);
    const today_ = (w.sections as Json[]).find((s) => s.key === 'today')!.items[0];
    expect(today_).toMatchObject({ board_id: boardId, date: today, group: { title: expect.any(String) } });
    expect(Object.keys(today_.cells).sort()).toEqual([keys.due, keys.owner].sort());
  });

  it('includes items assigned to my team', async () => {
    const w = await work(dana);
    expect(Object.values(sections(w)).flat()).toEqual(['Team task']);
  });

  it('only boards I can read; archived and deleted items drop out', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    const secret = (
      await body(await as(admin).post('/boards', { name: 'Secret', workspace_id: ws.id, kind: 'private' }))
    ).id as string;
    const owner2 = await column(secret, 'Owner', 'people');
    await item(secret, 'Hidden from bob', { [owner2]: person(ids.bob) });
    const gone = await item(boardId, 'Gone', { [keys.owner]: person(ids.bob) });
    const archived = await item(boardId, 'Archived', { [keys.owner]: person(ids.bob) });
    await as(admin).del(`/items/${gone}`);
    await as(admin).post(`/items/${archived}/archive`);
    const names = Object.values(sections(await work(bob))).flat();
    expect(names).not.toContain('Hidden from bob');
    expect(names).not.toContain('Gone');
    expect(names).not.toContain('Archived');
    expect(Object.values(sections(await work(admin))).flat()).toContain('Not mine');
  });
});

describe('customize', () => {
  it('shows done items, uses another date column, hides a board — kept per user', async () => {
    let s = await body(await as(bob).patch('/me/work/settings', { hide_done: false }));
    expect(s.hide_done).toBe(false);
    expect(sections(await work(bob)).today).toEqual(['Done', 'Today']);

    s = await body(await as(bob).patch('/me/work/settings', { boards: { [boardId]: { date_column: keys.due2 } } }));
    expect(s.boards[boardId]).toEqual({ date_column: keys.due2 });
    const w = await work(bob);
    expect(w.boards[0].date_column.id).toBe(keys.due2);
    expect(sections(w).past).toEqual(['Today']); // its follow-up date is 5 days ago

    await as(bob).patch('/me/work/settings', { boards: { [boardId]: { hidden: true } } });
    const hidden = await work(bob);
    expect(hidden.boards[0]).toMatchObject({ id: boardId, hidden: true });
    expect(Object.values(sections(hidden)).flat()).toEqual([]);

    await as(bob).patch('/me/work/settings', { boards: { [boardId]: null }, hide_done: true, group_by: 'board' });
    const back = await work(bob);
    expect(back.settings).toEqual({ hide_done: true, group_by: 'board', subitems: true, boards: {} });
    expect(sections(back).today).toEqual(['Today']);
    expect((await work(dana)).settings.group_by).toBe('date'); // another user's are untouched
    expect((await as(bob).patch('/me/work/settings', { group_by: 'nope' })).status).toBe(400);
  });

  it('only my chosen people column counts on a board', async () => {
    const reviewer = await column(boardId, 'Reviewer', 'people');
    await item(boardId, 'To review', { [reviewer]: person(ids.bob) });
    expect(Object.values(sections(await work(bob))).flat()).toContain('To review');
    await as(bob).patch('/me/work/settings', { boards: { [boardId]: { people_column: keys.owner } } });
    const w = await work(bob);
    expect(Object.values(sections(w)).flat()).not.toContain('To review');
    expect(w.boards[0]).toMatchObject({ people_choice: keys.owner });
    expect(w.boards[0].people_choices.map((c: Json) => c.key)).toEqual([keys.owner, reviewer]);
    await as(bob).patch('/me/work/settings', { boards: { [boardId]: null } });
  });

  it('subitems assigned to me show under their parent (and can be left out)', async () => {
    const parent = await item(boardId, 'Parent deal', {});
    await as(admin).post(`/items/${parent}/subitems`, { name: 'Sub task' });
    const subBoard = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id as string;
    const subOwner = await column(subBoard, 'Owner', 'people');
    const subs = (await body(await as(admin).get(`/boards/${subBoard}/items`))).data as Json[];
    await as(admin).put(`/items/${subs[0]!.id}/cells/${subOwner}`, { value: person(ids.bob) });

    const w = await work(bob);
    const row = (w.sections as Json[]).flatMap((x) => x.items).find((i: Json) => i.name === 'Sub task');
    expect(row).toMatchObject({ parent: { id: parent, name: 'Parent deal' }, board_id: subBoard });
    expect(w.boards.find((b: Json) => b.id === subBoard)).toMatchObject({ open_board_id: boardId, subitems: true });

    await as(bob).patch('/me/work/settings', { subitems: false });
    expect(Object.values(sections(await work(bob))).flat()).not.toContain('Sub task');
    await as(bob).patch('/me/work/settings', { subitems: true });
  });

  it('needs an account', async () => {
    expect((await t.api(bob).get('/me/work')).status).toBe(400);
  });
});
