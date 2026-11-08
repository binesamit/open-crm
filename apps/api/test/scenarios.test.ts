// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, scenarioRuns } from '../src/db/schema';
import { dispatchEvent } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * phase 3 — scenarios: a graph of the automations' trigger and actions. Issues keep it off; once on, an
 * event runs it (filter → router → actions, a wait goes on later); each step is in the run log; it never hears its
 * own writes; only who may manage automations changes it; a test run works while it is off.
 */
let t: TestContext;
let admin: string;
let bob: string;
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

const setup = async (name: string) => {
  const board = await body(await as(admin).post('/boards', { name, workspace_id: ws }));
  const stage = await body(
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'stage', title: 'Stage', type: 'status' }),
  );
  await as(admin).post(`/boards/${board.id}/columns`, { id: 'budget', title: 'Budget', type: 'numbers' });
  await as(admin).post(`/boards/${board.id}/columns`, { id: 'note', title: 'Note', type: 'text' });
  const labels = stage.settings.labels as Json[];
  return { boardId: board.id as string, label: (id: number) => labels.find((l) => l.id === id)!.label as string };
};

/** Dispatches the activity rows of an item written since `since` (tests have no queue: runs happen inline). */
const seen = new Set<string>();
const drain = async (itemId: string) => {
  const rows = await t.db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.itemId, itemId)))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    await dispatchEvent(t.deps, r.id);
  }
};
const runsOf = (scenarioId: string) =>
  t.db.select().from(scenarioRuns).where(eq(scenarioRuns.scenarioId, scenarioId)).orderBy(asc(scenarioRuns.createdAt));

const rule = (column_id: string, operator: string, values: unknown[] = []) => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id, operator, values, negate: false }],
});

const graphFor = (label: (id: number) => string) => ({
  nodes: [
    { id: 't', kind: 'trigger', x: 0, y: 0, trigger: { type: 'status_changed', column: 'stage', labels: [label(1)] } },
    { id: 'f', kind: 'filter', x: 0, y: 0, conditions: rule('note', 'is_not_empty') },
    {
      id: 'r',
      kind: 'router',
      x: 0,
      y: 0,
      mode: 'first',
      branches: [{ id: 'big', label: 'Big', conditions: rule('budget', 'greater_than', [100]) }],
    },
    { id: 'a1', kind: 'action', x: 0, y: 0, action: { type: 'set_column', column: 'note', value: 'big deal' } },
    { id: 'a2', kind: 'action', x: 0, y: 10, action: { type: 'set_column', column: 'note', value: 'small deal' } },
    { id: 'w', kind: 'wait', x: 0, y: 0, minutes: 5 },
    { id: 'a3', kind: 'action', x: 0, y: 0, action: { type: 'set_column', column: 'budget', value: '1' } },
  ],
  edges: [
    { id: 'e1', from: 't', to: 'f' },
    { id: 'e2', from: 'f', to: 'r' },
    { id: 'e3', from: 'r', to: 'a1', branch: 'big' },
    { id: 'e4', from: 'r', to: 'a2', branch: 'else' },
    { id: 'e5', from: 'a1', to: 'w' },
    { id: 'e6', from: 'w', to: 'a3' },
  ],
});

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

describe('scenarios', () => {
  it('issues keep it off; on, a status change runs filter → router → action → wait → action', async () => {
    const { boardId, label } = await setup('SC 1');
    const created = await body(await as(admin).post(`/boards/${boardId}/scenarios`, { name: 'Leads' }));
    expect(created.is_active).toBe(false);
    expect(created.issues.map((i: Json) => i.code)).toContain('no_trigger');
    expect((await as(admin).put(`/scenarios/${created.id}/active`, { active: true })).status).toBe(400);
    const saved = await body(await as(admin).patch(`/scenarios/${created.id}`, { graph: graphFor(label) }));
    expect(saved.issues).toEqual([]);
    expect((await as(admin).put(`/scenarios/${created.id}/active`, { active: true })).status).toBe(200);

    // Big budget: the first branch, then the wait (no queue in tests: it goes on at once) and the last action.
    const big = await body(
      await as(bob).post(`/boards/${boardId}/items`, { name: 'Big', cells: { budget: 500, note: 'x' } }),
    );
    await as(bob).put(`/items/${big.id}/cells/stage`, { value: { index: 1 } });
    await drain(big.id);
    const item = await body(await as(admin).get(`/items/${big.id}`));
    expect(item.cells.note.value).toBe('big deal');
    expect(item.cells.budget.value).toBe(1);
    const [run] = await runsOf(created.id);
    expect(run!.status).toBe('succeeded');
    const steps = run!.steps as Json[];
    expect(steps.map((s) => `${s.node_id}:${s.status}`)).toEqual(['f:ok', 'r:ok', 'a1:ok', 'w:waiting', 'a3:ok']);
    expect(steps.find((s) => s.node_id === 'r')!.branches).toEqual(['big']);

    // Its own writes (note, budget) never run it again.
    await drain(big.id);
    expect(await runsOf(created.id)).toHaveLength(1);

    // Small budget: "otherwise". No note: the filter stops it (skipped).
    const small = await body(
      await as(bob).post(`/boards/${boardId}/items`, { name: 'Small', cells: { budget: 5, note: 'x' } }),
    );
    await as(bob).put(`/items/${small.id}/cells/stage`, { value: { index: 1 } });
    await drain(small.id);
    expect((await body(await as(admin).get(`/items/${small.id}`))).cells.note.value).toBe('small deal');
    const empty = await body(await as(bob).post(`/boards/${boardId}/items`, { name: 'Empty' }));
    await as(bob).put(`/items/${empty.id}/cells/stage`, { value: { index: 1 } });
    await drain(empty.id);
    const runs = await body(await as(admin).get(`/scenarios/${created.id}/runs`));
    expect(runs.data[0].status).toBe('skipped');
    expect(runs.data[0].steps[0]).toMatchObject({ node_id: 'f', status: 'skipped' });
    expect(runs.data.map((r: Json) => r.item_name)).toEqual(['Empty', 'Small', 'Big']);
  });

  it('only who may manage automations changes it; a member reads it; a test run works while it is off', async () => {
    const { boardId, label } = await setup('SC 2');
    const s = await body(
      await as(admin).post(`/boards/${boardId}/scenarios`, { name: 'Test me', graph: graphFor(label) }),
    );
    // Bob (an editor) may manage automations, but not someone else's scenario.
    expect((await as(bob).patch(`/scenarios/${s.id}`, { name: 'Mine' })).status).toBe(403);
    const list = await body(await as(bob).get(`/boards/${boardId}/scenarios`));
    expect(list.data[0]).toMatchObject({ name: 'Test me', can_manage: false });
    const item = await body(
      await as(admin).post(`/boards/${boardId}/items`, { name: 'T', cells: { budget: 1, note: 'n' } }),
    );
    const run = await body(await as(admin).post(`/scenarios/${s.id}/test`, { item_id: item.id }));
    expect(run.status).toBe('succeeded');
    expect((await body(await as(admin).get(`/items/${item.id}`))).cells.note.value).toBe('small deal');
    expect((await as(admin).del(`/scenarios/${s.id}`)).status).toBe(200);
    expect((await as(admin).get(`/scenarios/${s.id}`)).status).toBe(404);
  });

  it('refuses a filter on an unknown column and an action not offered in scenarios', async () => {
    const { boardId, label } = await setup('SC 3');
    const g = graphFor(label);
    const bad = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'f' ? { ...n, conditions: rule('nope', 'is_empty') } : n)),
    };
    expect((await as(admin).post(`/boards/${boardId}/scenarios`, { name: 'Bad', graph: bad })).status).toBe(422);
    const sms = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'a3' ? { ...n, action: { type: 'send_sms', column: 'note', message: 'hi' } } : n,
      ),
    };
    const s = await body(await as(admin).post(`/boards/${boardId}/scenarios`, { name: 'SMS', graph: sms }));
    expect(s.issues).toEqual([{ node_id: 'a3', code: 'action_unsupported' }]);
  });
});
