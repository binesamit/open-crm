// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type RecipeInput } from '@bines/shared';
import { activityLog, automationRuns, automations } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * r19relfilter (the planning notes "RELATION-FILTERS"): a relation column offers only items matching a shared view of the
 * linked board or a filter of its own; existing links that stop matching stay and are marked (per viewer);
 * new human links must match (`relation_not_in_filter`); automations / bulk fills link-and-note / drop.
 */
let t: TestContext;
let admin: string;
let bob: string;
let adminId: string;
let bobId: string;
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
const addItem = async (boardId: string, name: string, cells?: Json, cookie = admin) =>
  as(cookie).post(`/boards/${boardId}/items`, { name, ...(cells ? { cells } : {}) });
const item = async (boardId: string, name: string, cells?: Json) => body(await addItem(boardId, name, cells));
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const linked = async (id: string, key: string) => ((await getItem(id)).cells[key]?.value?.item_ids ?? []) as string[];
const link = (id: string, key: string, value: Json | null, cookie = admin) =>
  value === null ? as(cookie).del(`/items/${id}/cells/${key}`) : as(cookie).put(`/items/${id}/cells/${key}`, { value });
const updateColumn = (boardId: string, key: string, settings: Json) =>
  as(admin).patch(`/boards/${boardId}/columns/${key}`, { settings });
const search = async (target: string, source: string, key: string, q = '', cookie = admin) =>
  body(
    await as(cookie).get(
      `/boards/${target}/items/search?q=${encodeURIComponent(q)}&source_board_id=${source}&column_id=${key}`,
    ),
  );
const matches = async (boardId: string, key: string, cookie = admin) =>
  body(await as(cookie).get(`/boards/${boardId}/columns/${key}/relation-matches`));
const names = (r: Json) => (r.data as Json[]).map((x) => x.name).sort();

const statusRule = (key: string, label: string) => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id: key, operator: 'any_of', values: [label], negate: false }],
});

let deals: Json;
let clients: Json;
let rel: string; // deals → clients
let status: string; // clients' status column
let owner: string; // clients' people column
let active: Json;
let levi: Json;
let cohen: Json;
let view: Json;

beforeAll(async () => {
  t = await createTestContext();
  const ownerCookie = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(ownerCookie).post('/platform/accounts', {
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
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  adminId = users.find((u) => u.email === 'admin@acme.test')!.user_id;
  bobId = users.find((u) => u.email === 'bob@acme.test')!.user_id;

  deals = await newBoard('Deals');
  clients = await newBoard('Clients');
  status = (
    await body(
      await as(admin).post(`/boards/${clients.id}/columns`, {
        title: 'State',
        type: 'status',
        settings: {
          labels: [
            { id: 1, label: 'Active', color: 'forest', index: 0 },
            { id: 2, label: 'Inactive', color: 'gray', index: 1 },
          ],
        },
      }),
    )
  ).id;
  owner = (await body(await as(admin).post(`/boards/${clients.id}/columns`, { title: 'Owner', type: 'people' }))).id;
  rel = (
    await body(
      await as(admin).post(`/boards/${deals.id}/columns`, {
        title: 'Client',
        type: 'board_relation',
        settings: { board_ids: [clients.id], allow_multiple: true },
      }),
    )
  ).id;
  const person = (id: string) => ({ persons_and_teams: [{ id, kind: 'person' }] });
  active = await item(clients.id, 'Active Ltd', { [status]: { index: 1 }, [owner]: person(adminId) });
  levi = await item(clients.id, 'Levi & Co', { [status]: { index: 1 }, [owner]: person(bobId) });
  cohen = await item(clients.id, 'Cohen Inc', { [status]: { index: 2 } });
  view = await body(
    await as(admin).post(`/boards/${clients.id}/views`, {
      name: 'Active clients',
      type: 'table',
      visibility: 'shared',
      settings: { query: { filter: statusRule(status, 'Active') } },
    }),
  );
});
afterAll(() => t.close());

describe('settings', () => {
  it('refuses a view of another board, an unknown column and an unknown operator; drops non-linked boards', async () => {
    const other = await newBoard('Other');
    const otherView = await body(
      await as(admin).post(`/boards/${other.id}/views`, { name: 'x', type: 'table', visibility: 'shared' }),
    );
    let res = await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: otherView.id } },
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.details.reason).toBe('view_not_found');

    res = await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'filter', filter: statusRule('nope', 'Active') } },
    });
    expect(res.status).toBe(422);
    expect((await body(res)).error.code).toBe('unknown_column');

    res = await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [other.id]: { mode: 'filter', filter: statusRule(status, 'Active') } },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.choice_filter).toBeUndefined();
  });

  it('refuses a private view', async () => {
    const mine = await body(
      await as(admin).post(`/boards/${clients.id}/views`, { name: 'mine', type: 'table', visibility: 'private' }),
    );
    const res = await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: mine.id } },
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.details.reason).toBe('view_not_shared');
  });

  it('saves a view-based filter', async () => {
    const res = await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      allow_multiple: true,
      choice_filter: { [clients.id]: { mode: 'view', view_id: view.id } },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.choice_filter[clients.id]).toEqual({ mode: 'view', view_id: view.id });
  });
});

describe('picker and marks', () => {
  it('offers only matching items, with the view name and the name matches it hides', async () => {
    const r = await search(clients.id, deals.id, rel);
    expect(names(r)).toEqual(['Active Ltd', 'Levi & Co']);
    expect(r.filter).toMatchObject({ source: 'view', label: 'Active clients', invalid: null });
    const q = await search(clients.id, deals.id, rel, 'cohen');
    expect(q.data).toEqual([]);
    expect(q.hidden_by_filter).toBe(1);
    // Without the column the search is the plain one.
    const plain = body(await as(admin).get(`/boards/${clients.id}/items/search?q=`));
    expect(((await plain).data as Json[]).length).toBe(3);
  });

  it('a new link that does not match is refused; a matching one is made', async () => {
    const deal = await item(deals.id, 'Deal 1');
    const bad = await link(deal.id, rel, { item_ids: [cohen.id] });
    expect(bad.status).toBe(422);
    const err = (await body(bad)).error;
    expect(err.code).toBe('relation_not_in_filter');
    expect(err.details.names).toEqual(['Cohen Inc']);
    expect((await link(deal.id, rel, { item_ids: [levi.id] })).status).toBe(200);
    // Creating an item with a non-matching link through the API is refused too.
    expect((await addItem(deals.id, 'Deal x', { [rel]: { item_ids: [cohen.id] } })).status).toBe(422);
  });

  it('a linked item that stops matching stays linked and is marked; it can still be unlinked', async () => {
    const deal = await item(deals.id, 'Deal 2', { [rel]: { item_ids: [levi.id, active.id] } });
    expect((await as(admin).put(`/items/${levi.id}/cells/${status}`, { value: { index: 2 } })).status).toBe(200);
    expect(await linked(deal.id, rel)).toEqual([levi.id, active.id]);
    const m = await matches(deals.id, rel);
    expect(m.unmatched).toEqual([levi.id]);
    expect(m.filters[0]).toMatchObject({ board_id: clients.id, label: 'Active clients' });
    // Saving another link keeps the old non-matching one (existing links are never checked).
    const other = await item(clients.id, 'New Active', { [status]: { index: 1 } });
    expect((await link(deal.id, rel, { item_ids: [levi.id, active.id, other.id] })).status).toBe(200);
    // Removing it works.
    expect((await link(deal.id, rel, { item_ids: [active.id, other.id] })).status).toBe(200);
    // Back to active: the mark goes by itself.
    await as(admin).put(`/items/${levi.id}/cells/${status}`, { value: { index: 1 } });
    expect((await matches(deals.id, rel)).unmatched).toEqual([]);
  });

  it('the board filter "has a link that does not match" runs on the server', async () => {
    const deal = await item(deals.id, 'Deal 3', { [rel]: { item_ids: [levi.id] } });
    await as(admin).put(`/items/${levi.id}/cells/${status}`, { value: { index: 2 } });
    const rule = (operator: string) => ({
      filter: {
        kind: 'group',
        operator: 'and',
        negate: false,
        rules: [{ kind: 'rule', column_id: rel, operator, values: [], negate: false }],
      },
    });
    const has = await body(await as(admin).post(`/boards/${deals.id}/items/query`, rule('has_unmatched_link')));
    expect((has.data as Json[]).map((x) => x.id)).toContain(deal.id);
    expect((has.data as Json[]).every((x) => x.cells[rel]?.value.item_ids.includes(levi.id))).toBe(true);
    const none = await body(await as(admin).post(`/boards/${deals.id}/items/query`, rule('no_unmatched_link')));
    expect((none.data as Json[]).map((x) => x.id)).not.toContain(deal.id);
    await as(admin).put(`/items/${levi.id}/cells/${status}`, { value: { index: 1 } });
  });

  it('an item just created from the picker is linked even when it does not match', async () => {
    const deal = await item(deals.id, 'Deal 4');
    const fresh = await item(clients.id, 'Brand new'); // no status → not in the view
    expect((await link(deal.id, rel, { item_ids: [fresh.id] })).status).toBe(422);
    expect((await link(deal.id, rel, { item_ids: [fresh.id], new_item_ids: [fresh.id] })).status).toBe(200);
    expect((await matches(deals.id, rel)).unmatched).toContain(fresh.id);
    // Someone else's item does not get the exemption.
    const deal2 = await item(deals.id, 'Deal 5');
    const res = await link(deal2.id, rel, { item_ids: [cohen.id], new_item_ids: [cohen.id] });
    expect(res.status).toBe(200); // cohen was created by admin within the window — allowed for admin…
    const asBob = await link(deal2.id, rel, { item_ids: [cohen.id, active.id], new_item_ids: [active.id] }, bob);
    expect(asBob.status).toBe(200); // cohen is an existing link now, active matches
    const bobBad = await link(
      (await item(deals.id, 'Deal 6')).id,
      rel,
      { item_ids: [cohen.id], new_item_ids: [cohen.id] },
      bob,
    );
    expect(bobBad.status).toBe(422); // …but not for bob, who did not create it
  });

  it('a filter with "me" matches per viewer (people column)', async () => {
    expect(
      (
        await updateColumn(deals.id, rel, {
          board_ids: [clients.id],
          choice_filter: {
            [clients.id]: {
              mode: 'filter',
              filter: {
                kind: 'group',
                operator: 'and',
                negate: false,
                rules: [{ kind: 'rule', column_id: owner, operator: 'any_of', values: ['me'], negate: false }],
              },
            },
          },
          choice_caption: 'My clients',
        })
      ).status,
    ).toBe(200);
    const mine = await search(clients.id, deals.id, rel);
    expect(names(mine)).toEqual(['Active Ltd']);
    expect(mine.filter).toMatchObject({ source: 'filter', label: 'My clients' });
    expect(names(await search(clients.id, deals.id, rel, '', bob))).toEqual(['Levi & Co']);
    // The marks too: a deal linked to both shows a different unmatched item to each.
    await item(deals.id, 'Shared deal', { [rel]: { item_ids: [active.id] } });
    const bobDeal = await body(await addItem(deals.id, 'Bob deal', { [rel]: { item_ids: [levi.id] } }, bob));
    expect(bobDeal.id).toBeTruthy();
    expect((await matches(deals.id, rel)).unmatched).toContain(levi.id);
    expect((await matches(deals.id, rel)).unmatched).not.toContain(active.id);
    const bobMarks = (await matches(deals.id, rel, bob)).unmatched;
    expect(bobMarks).toContain(active.id);
    expect(bobMarks).not.toContain(levi.id);
  });

  it('API enforcement can be turned off; undo puts back a non-matching link', async () => {
    await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: view.id } },
      choice_filter_api: false,
    });
    const deal = await item(deals.id, 'Deal 7');
    expect((await link(deal.id, rel, { item_ids: [cohen.id] })).status).toBe(200);
    await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: view.id } },
    });
    const res = await link(deal.id, rel, null);
    const eventId = (await body(res)).event_id as string;
    expect(await linked(deal.id, rel)).toEqual([]);
    expect((await as(admin).post(`/activity/${eventId}/undo`, {})).status).toBe(200);
    expect(await linked(deal.id, rel)).toEqual([cohen.id]);
  });

  it('a bulk fill leaves out non-matching links and counts them', async () => {
    const a = await item(deals.id, 'Bulk A');
    const b = await item(deals.id, 'Bulk B');
    const res = await body(
      await as(admin).post(`/boards/${deals.id}/items/bulk`, {
        item_ids: [a.id, b.id],
        action: { type: 'set_cell', column_id: rel, value: { item_ids: [active.id, cohen.id] } },
      }),
    );
    expect(res.done).toBe(2);
    expect(res.links_dropped).toBe(2);
    expect(await linked(a.id, rel)).toEqual([active.id]);
  });

  it('a deleted view stops filtering and says so', async () => {
    const temp = await body(
      await as(admin).post(`/boards/${clients.id}/views`, {
        name: 'Temp',
        type: 'table',
        visibility: 'shared',
        settings: { query: { filter: statusRule(status, 'Active') } },
      }),
    );
    await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: temp.id } },
    });
    expect((await as(admin).del(`/views/${temp.id}`)).status).toBeLessThan(300);
    const r = await search(clients.id, deals.id, rel);
    expect(r.filter).toMatchObject({ invalid: 'view_missing' });
    expect(r.data.length).toBeGreaterThanOrEqual(3);
    expect((await matches(deals.id, rel)).unmatched).toEqual([]);
    // Saving other settings keeps the stale choice (it is shown to be re-picked).
    const res = await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: temp.id } },
      allow_multiple: true,
    });
    expect(res.status).toBe(200);
    await updateColumn(deals.id, rel, {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: view.id } },
    });
  });
});

describe('automations', () => {
  it('link a non-matching item and note it in the run log', async () => {
    const seen = new Set<string>(
      (await t.db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.accountId, acmeId))).map(
        (r) => r.id,
      ),
    );
    const id = newId();
    const recipe: RecipeInput = {
      trigger: { type: 'item_created' },
      actions: [{ type: 'set_column', column: rel, value: cohen.id }],
    } as RecipeInput;
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId: deals.id,
      title: 'Link cohen',
      recipe: recipe as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    const deal = await item(deals.id, 'Auto deal');
    for (let round = 0; round < 5; round++) {
      const rows = await t.db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.accountId, acmeId))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
      const fresh = rows.filter((r) => !seen.has(r.id));
      if (!fresh.length) break;
      for (const r of fresh) {
        seen.add(r.id);
        for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
      }
    }
    expect(await linked(deal.id, rel)).toEqual([cohen.id]);
    const [run] = await t.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, id)));
    expect(run!.status).toBe('succeeded');
    const log = run!.actionsLog as Json[];
    expect(log[0]!.warnings).toEqual([`relation_not_in_filter:${rel}:Cohen Inc`]);
    await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
  });
});
