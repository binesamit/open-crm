// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { automationSchedules } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M6 stage 4 — the automations API (06 §2.16). */
let t: TestContext;
let admin: string;
let carol: string; // viewer
let acmeId: string;
let boardId: string;
let statusKey: string;
let dateKey: string;
let labels: { id: number; label: string }[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
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
  await as(admin).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  statusKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'סטטוס', type: 'status' }))).id;
  dateKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'מעקב', type: 'date' }))).id;
  const board = await body(await as(admin).get(`/boards/${boardId}`));
  labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels;
});
afterAll(() => t.close());

describe('automations API', () => {
  let id: string;

  it('creates from a recipe (seed shorthands and column titles accepted) and lists it', async () => {
    const res = await as(admin).post(`/boards/${boardId}/automations`, {
      title: 'Won → follow up',
      recipe: {
        trigger: { type: 'status_changed', column: statusKey, labels: [labels[1]!.label] },
        actions: [
          { type: 'set_date', column: dateKey, value: 'today+3d' },
          { type: 'notify', to: '@owner', message: 'ליד {item name} ({סטטוס})' },
        ],
      },
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    id = a.id;
    expect(a).toMatchObject({ is_active: true, can_manage: true, revision: 1, warnings: [] });
    expect(a.recipe.actions[1]).toMatchObject({
      to: '@board_owners',
      message: `ליד {item.name} ({item.${statusKey}})`,
    });
    const list = await body(await as(admin).get(`/boards/${boardId}/automations`));
    expect(list.data.map((x: Json) => x.id)).toEqual([id]);
  });

  it('rejects what the board cannot satisfy, with the paths of the problems', async () => {
    const res = await as(admin).post(`/boards/${boardId}/automations`, {
      recipe: {
        trigger: { type: 'status_changed', column: statusKey, labels: ['אין כזו'] },
        conditions: [{ column: 'nope', operator: 'any_of', values: ['x'] }],
        actions: [
          { type: 'set_status', column: dateKey, label: 'x' },
          { type: 'move_to_group', group: 'no_such_group' },
          { type: 'create_item', board: 'no_such_board' },
        ],
      },
    });
    expect(res.status).toBe(422);
    const issues = (await body(res)).error.details.issues.map((i: Json) => `${i.code}@${i.path}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        'label_not_found@trigger.labels.0',
        'column_type@actions.0.column',
        'group_not_found@actions.1.group',
        'board_not_found@actions.2.board',
        'unknown_column@conditions',
      ]),
    );
    const bad = await as(admin).post(`/boards/${boardId}/automations`, {
      recipe: { trigger: { type: 'nope' }, actions: [] },
    });
    expect(bad.status).toBe(422);
  });

  it('a viewer reads but cannot create, edit or test', async () => {
    expect((await as(carol).get(`/boards/${boardId}/automations`)).status).toBe(200);
    const one = await body(await as(carol).get(`/automations/${id}`));
    expect(one.can_manage).toBe(false);
    expect(
      (
        await as(carol).post(`/boards/${boardId}/automations`, {
          recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'archive_item' }] },
        })
      ).status,
    ).toBe(403);
    expect((await as(carol).post(`/automations/${id}/deactivate`)).status).toBe(403);
    expect((await as(carol).post(`/automations/${id}/test`, {})).status).toBe(403);
  });

  it('edits with If-Match; a stale revision is a 409', async () => {
    const ok = await as(admin).call('PATCH', `/automations/${id}`, { title: 'Renamed' }, { 'if-match': '1' });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toMatchObject({ title: 'Renamed', revision: 2 });
    expect((await as(admin).call('PATCH', `/automations/${id}`, { title: 'Again' }, { 'if-match': '1' })).status).toBe(
      409,
    );
  });

  it('switching a date automation on builds its schedules; off keeps them; delete removes them', async () => {
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'With date' }));
    await as(admin).put(`/items/${item.id}/cells/${dateKey}`, { value: { date: '2099-04-04' } });
    const created = await body(
      await as(admin).post(`/boards/${boardId}/automations`, {
        is_active: false,
        recipe: {
          trigger: { type: 'date_arrived', column: dateKey },
          actions: [{ type: 'set_status', column: statusKey, label: labels[0]!.label }],
        },
      }),
    );
    const rows = () => t.db.select().from(automationSchedules).where(eq(automationSchedules.automationId, created.id));
    expect(await rows()).toHaveLength(0);
    const on = await body(await as(admin).post(`/automations/${created.id}/activate`));
    expect(on).toMatchObject({ is_active: true, deactivated_reason: null });
    expect((await rows()).map((r) => r.itemId)).toEqual([item.id]);
    await as(admin).post(`/automations/${created.id}/deactivate`);
    expect(await rows()).toHaveLength(1);
    expect((await as(admin).call('DELETE', `/automations/${created.id}`)).status).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect((await as(admin).get(`/automations/${created.id}`)).status).toBe(404);
  });

  it('test: a dry run renders every action for the item without writing; a real run runs', async () => {
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Dana' }));
    await as(admin).put(`/items/${item.id}/cells/${statusKey}`, { value: { index: labels[1]!.id } });
    const dry = await body(await as(admin).post(`/automations/${id}/test`, { item_id: item.id }));
    expect(dry.conditions).toEqual({ matched: true, failed_rule: null });
    expect(dry.actions[1]).toMatchObject({
      type: 'notify',
      would_write: false,
      rendered: { message: `ליד Dana (${labels[1]!.label})` },
    });
    expect((await body(await as(admin).get(`/items/${item.id}`))).cells[dateKey]).toBeUndefined();

    const real = await body(await as(admin).post(`/automations/${id}/test`, { item_id: item.id, dry_run: false }));
    expect(real.run_id).toBeTruthy();
    expect((await body(await as(admin).get(`/items/${item.id}`))).cells[dateKey].value.date).toMatch(/^\d{4}-/);
    const runs = await body(await as(admin).get(`/automations/${id}/runs`));
    expect(runs.data[0]).toMatchObject({ id: real.run_id, status: 'succeeded', event_type: 'manual.test' });
    expect(runs.data[0].log.map((l: Json) => l.status)).toEqual(['ok', 'ok']);
    // A page that is exactly the limit has no `next` when nothing follows (audit 2026-10-10 B4).
    const exact = await body(await as(admin).get(`/automations/${id}/runs?limit=${runs.data.length}`));
    expect(exact.data).toHaveLength(runs.data.length);
    expect(exact.next).toBeNull();
    const smaller = await body(await as(admin).get(`/automations/${id}/runs?limit=1`));
    expect(smaller.next).toBe(runs.data.length > 1 ? smaller.data[0].id : null);
  });

  it('account-wide: every automation of my boards with its board and the last 7 days; usage per day', async () => {
    const list = await body(await as(admin).get('/automations'));
    const mine = list.data.find((x: Json) => x.id === id);
    expect(mine).toMatchObject({ board_name: 'Leads', runs_7d: 1, errors_7d: 0 });
    const usage = await body(await as(admin).get('/automations/usage'));
    expect(usage.days).toHaveLength(30);
    const today = usage.days.at(-1);
    expect(today.succeeded).toBeGreaterThanOrEqual(1);
    expect(today.actions).toBeGreaterThanOrEqual(2);
    expect(usage).toMatchObject({ total: list.data.length });
    // A viewer sees them too (read), but cannot manage.
    expect((await body(await as(carol).get('/automations'))).data.every((x: Json) => !x.can_manage)).toBe(true);
  });
});
