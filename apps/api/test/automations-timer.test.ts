// SPDX-License-Identifier: AGPL-3.0-only
import { asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type RecipeInput } from '@bines/shared';
import { activityLog, automationRuns, automations } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Plan — whose timer a start / stop time tracking automation runs, its fallbacks and skips. */
let t: TestContext;
let admin: string;
let dani: string;
let adminId: string;
let daniId: string;
let gilId: string;
let guestId: string;
let viewerId: string;
let acmeId: string;
let wsId: string;
let boardId: string;
let statusKey: string;
let peopleKey: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie = admin) => t.api(cookie, acmeId);

const join = async (email: string, role: 'member' | 'guest' | 'viewer' = 'member') => {
  await as().post('/users/invite', { emails: [email], role });
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return { cookie, id: (await body(await t.api(cookie).get('/auth/me'))).user.id as string };
};

/** Stored straight in the table: what an automation saved before "whose timer" existed looks like. */
const addAutomation = async (title: string, recipe: RecipeInput, board = boardId) => {
  const id = newId();
  await t.db.insert(automations).values({
    id,
    accountId: acmeId,
    boardId: board,
    title,
    recipe: recipe as never,
    isActive: true,
    ownerId: adminId,
    createdBy: adminId,
  });
  return id;
};
const deactivateAll = () => t.db.update(automations).set({ isActive: false }).where(eq(automations.accountId, acmeId));

const seen = new Set<string>();
/** Optionally re-labels the fresh rows' actor type first (a form / an agent / the API made the change). */
const drain = async (actorType?: 'form' | 'agent' | 'api') => {
  for (let round = 0; round < 20; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.id);
      if (actorType && round === 0) await t.db.update(activityLog).set({ actorType }).where(eq(activityLog.id, r.id));
      for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
    }
  }
};
const lastRun = async (automationId: string) =>
  (
    await t.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.createdAt))
      .limit(1)
  )[0]!;
const lastAction = async (automationId: string) => (await lastRun(automationId)).actionsLog[0] as Json;

const newItem = async (name: string, board = boardId) =>
  (await body(await as().post(`/boards/${board}/items`, { name }))).id as string;
const runnersOf = async (itemId: string) =>
  (((await body(await as().get(`/items/${itemId}`))).cells.time?.value?.runners ?? []) as Json[])
    .map((r) => r.user_id as string)
    .sort();
const sorted = (...ids: string[]) => [...ids].sort();
let label = 0;
/** A status change by `cookie` (the trigger of every automation here). */
const touch = async (itemId: string, cookie = dani) => {
  label = label === 0 ? 1 : 0;
  expect((await as(cookie).put(`/items/${itemId}/cells/${statusKey}`, { value: { index: label } })).status).toBe(200);
};
const startRecipe = (extra: Json = {}): RecipeInput =>
  ({
    trigger: { type: 'status_changed', column: statusKey, labels: 'any' },
    actions: [{ type: 'start_time_tracking', column: 'time', ...extra }],
  }) as RecipeInput;
const stopRecipe = (extra: Json = {}): RecipeInput =>
  ({
    trigger: { type: 'status_changed', column: statusKey, labels: 'any' },
    actions: [{ type: 'stop_time_tracking', column: 'time', ...extra }],
  }) as RecipeInput;
const stopAll = async (itemId: string) => {
  const id = await addAutomation('stop all', stopRecipe({ who: '@all' }));
  await touch(itemId, admin);
  await drain();
  await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
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
  {
    const token = t.inviteTokenFor('admin@acme.test');
    admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
    await t.api(admin).post('/invitations/accept', { token });
    adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  }
  ({ cookie: dani, id: daniId } = await join('dani@acme.test'));
  ({ id: gilId } = await join('gil@acme.test'));
  ({ id: guestId } = await join('guest@client.test', 'guest'));
  ({ id: viewerId } = await join('viewer@acme.test', 'viewer'));
  wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Work', workspace_id: wsId }))).id;
  await as().post(`/boards/${boardId}/columns`, { title: 'סטטוס', type: 'status' });
  await as().post(`/boards/${boardId}/columns`, { title: 'אחראי', type: 'people' });
  await as().post(`/boards/${boardId}/columns`, { id: 'time', title: 'זמן', type: 'time_tracking' });
  const board = await body(await as().get(`/boards/${boardId}`));
  statusKey = board.columns.find((c: Json) => c.type === 'status').id;
  peopleKey = board.columns.find((c: Json) => c.type === 'people').id;
  await drain();
}, 600_000);
afterAll(() => t.close());

describe('whose timer', { timeout: 300_000 }, () => {
  it('an automation saved without the option keeps running the owner’s timer, whoever made the change', async () => {
    await deactivateAll();
    const item = await newItem('legacy');
    const start = await addAutomation('legacy start', startRecipe());
    await touch(item);
    await drain();
    expect(await runnersOf(item)).toEqual([adminId]);
    expect(await lastAction(start)).toMatchObject({ status: 'ok' });
    await deactivateAll();
    const stop = await addAutomation('legacy stop', stopRecipe());
    await touch(item);
    await drain();
    expect(await runnersOf(item)).toEqual([]);
    expect(await lastAction(stop)).toMatchObject({ status: 'ok' });
    await touch(item);
    await drain();
    expect(await lastAction(stop)).toMatchObject({ status: 'skipped', reason: 'not_running' });
  });

  it('new automations default to whoever made the change; saved ones keep theirs on update', async () => {
    await deactivateAll();
    const created = await body(
      await as().post(`/boards/${boardId}/automations`, { recipe: startRecipe(), is_active: false }),
    );
    expect(created.recipe.actions[0]).toMatchObject({ type: 'start_time_tracking', who: '@actor' });
    const legacy = await addAutomation('legacy', startRecipe());
    const res = await as().patch(`/automations/${legacy}`, {
      recipe: {
        ...startRecipe(),
        actions: [
          { type: 'start_time_tracking', column: 'time' },
          { type: 'stop_time_tracking', column: 'time' },
        ],
      },
    });
    expect(res.status).toBe(200);
    const actions = (await body(res)).recipe.actions as Json[];
    expect(actions[0]!.who).toBeUndefined(); // the one saved before: still the owner's
    expect(actions[1]!.who).toBe('@actor'); // the new one: the default for new actions
    await deactivateAll();
  });

  it('@actor: the timer of the person who made the change (and through the API: the token’s user)', async () => {
    await deactivateAll();
    const item = await newItem('actor');
    const id = await addAutomation('actor start', startRecipe({ who: '@actor' }));
    await touch(item, dani);
    await drain();
    expect(await runnersOf(item)).toEqual([daniId]);
    await touch(item, admin);
    await drain('api');
    expect(await runnersOf(item)).toEqual(sorted(adminId, daniId));
    await touch(item, dani);
    await drain();
    expect(await lastAction(id)).toMatchObject({ status: 'skipped', reason: 'already_running' });
    await deactivateAll();
    await stopAll(item);
    expect(await runnersOf(item)).toEqual([]);
  });

  it('nobody made the change (a form, an agent): the fallback people column, else skipped with the reason', async () => {
    await deactivateAll();
    const item = await newItem('form');
    await as().put(`/items/${item}/cells/${peopleKey}`, {
      value: { persons_and_teams: [{ id: gilId, kind: 'person' }] },
    });
    await drain();
    const bare = await addAutomation('no fallback', startRecipe({ who: '@actor' }));
    await touch(item, dani);
    await drain('form');
    expect(await lastAction(bare)).toMatchObject({ status: 'skipped', reason: 'no_person_made_the_change' });
    await deactivateAll();
    const withFallback = await addAutomation(
      'fallback',
      startRecipe({ who: '@actor', fallback: `column:${peopleKey}` }),
    );
    await touch(item, dani);
    await drain('agent'); // an agent's service user is not a person who tracks time
    expect(await lastAction(withFallback)).toMatchObject({ status: 'ok' });
    expect(await runnersOf(item)).toEqual([gilId]);
    await deactivateAll();
    await stopAll(item);
    // The fallback column empty: skipped, with the reason.
    await as().put(`/items/${item}/cells/${peopleKey}`, { value: null });
    await drain();
    await t.db.update(automations).set({ isActive: true }).where(eq(automations.id, withFallback));
    await touch(item, dani);
    await drain('form');
    expect(await lastAction(withFallback)).toMatchObject({
      status: 'skipped',
      reason: 'no_person_made_the_change_and_fallback_empty',
    });
    await deactivateAll();
  });

  it('a people column: everyone in it; a fixed person; guests and viewers are skipped with the reason', async () => {
    await deactivateAll();
    const item = await newItem('people');
    await as().put(`/items/${item}/cells/${peopleKey}`, {
      value: {
        persons_and_teams: [
          { id: daniId, kind: 'person' },
          { id: gilId, kind: 'person' },
        ],
      },
    });
    await drain();
    const col = await addAutomation('column', startRecipe({ who: `column:${peopleKey}` }));
    await touch(item, admin);
    await drain();
    expect(await runnersOf(item)).toEqual(sorted(daniId, gilId));
    expect((await lastAction(col)).output).toMatchObject({ users: expect.arrayContaining([daniId, gilId]) });
    await deactivateAll();
    await stopAll(item);

    await addAutomation('fixed', startRecipe({ who: `user:${gilId}` }));
    await touch(item, dani);
    await drain();
    expect(await runnersOf(item)).toEqual([gilId]);
    await deactivateAll();
    await stopAll(item);

    const guest = await addAutomation('guest', startRecipe({ who: `user:${guestId}` }));
    await touch(item, dani);
    await drain();
    expect(await lastAction(guest)).toMatchObject({ status: 'skipped', reason: 'guest' });
    await deactivateAll();
    const viewer = await addAutomation('viewer', startRecipe({ who: `user:${viewerId}` }));
    await touch(item, dani);
    await drain();
    expect(await lastAction(viewer)).toMatchObject({ status: 'skipped', reason: 'no_edit_rights' });
    expect(await runnersOf(item)).toEqual([]);
    await deactivateAll();
  });

  it('someone who cannot see the board is skipped; "allow other users: none" still applies', async () => {
    await deactivateAll();
    const priv = (await body(await as().post('/boards', { name: 'Private', workspace_id: wsId, kind: 'private' })))
      .id as string;
    await as().post(`/boards/${priv}/columns`, { id: 'time', title: 'זמן', type: 'time_tracking' });
    const privStatus = (await body(await as().post(`/boards/${priv}/columns`, { title: 'סטטוס', type: 'status' }))).id;
    const privItem = await newItem('secret', priv);
    await drain();
    const blind = await addAutomation(
      'blind',
      {
        trigger: { type: 'status_changed', column: privStatus, labels: 'any' },
        actions: [{ type: 'start_time_tracking', column: 'time', who: `user:${daniId}` }],
      } as RecipeInput,
      priv,
    );
    await as().put(`/items/${privItem}/cells/${privStatus}`, { value: { index: 1 } });
    await drain();
    expect(await lastAction(blind)).toMatchObject({ status: 'skipped', reason: 'no_board_access' });
    await deactivateAll();

    const item = await newItem('none');
    await as().patch(`/boards/${boardId}/columns/time`, { settings: { allow_other_users: 'none' } });
    await as().put(`/items/${item}/cells/${peopleKey}`, {
      value: { persons_and_teams: [{ id: gilId, kind: 'person' }] },
    });
    await drain();
    const other = await addAutomation('other', startRecipe({ who: `column:${peopleKey}` }));
    await touch(item, dani);
    await drain();
    expect(await lastAction(other)).toMatchObject({ status: 'skipped', reason: 'time_other_users_not_allowed' });
    await deactivateAll();
    // The person who made the change starting their own timer is not "someone else".
    await addAutomation('self', startRecipe({ who: '@actor' }));
    await touch(item, dani);
    await drain();
    expect(await runnersOf(item)).toEqual([daniId]);
    await deactivateAll();
    await as().patch(`/boards/${boardId}/columns/time`, { settings: { allow_other_users: 'all' } });
    await stopAll(item);
    expect(await runnersOf(item)).toEqual([]);
  });

  it('stop: the person who made the change, a column, or everyone', async () => {
    await deactivateAll();
    const item = await newItem('stop');
    await as(dani).post(`/items/${item}/time/start`, { column_id: 'time' });
    await as().post(`/items/${item}/time/start`, { column_id: 'time' });
    await drain();
    expect(await runnersOf(item)).toEqual(sorted(adminId, daniId));
    const mine = await addAutomation('stop mine', stopRecipe({ who: '@actor' }));
    await touch(item, dani);
    await drain();
    expect(await runnersOf(item)).toEqual([adminId]);
    expect(await lastAction(mine)).toMatchObject({ status: 'ok' });
    await deactivateAll();
    const everyone = await addAutomation('stop all', stopRecipe({ who: '@all' }));
    await touch(item, dani);
    await drain();
    expect(await runnersOf(item)).toEqual([]);
    expect(await lastAction(everyone)).toMatchObject({ status: 'ok' });
    await touch(item, dani);
    await drain();
    expect(await lastAction(everyone)).toMatchObject({ status: 'skipped', reason: 'not_running' });
    await deactivateAll();
  });

  it('a recipe naming a column that is not a people column is refused', async () => {
    const res = await as().post(`/boards/${boardId}/automations`, {
      recipe: startRecipe({ who: `column:${statusKey}` }),
    });
    expect(res.status).toBe(422);
    expect((await body(res)).error.details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'actions.0.who', code: 'column_type' })]),
    );
  });
});
