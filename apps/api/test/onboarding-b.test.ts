// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { automations, boards, dashboardWidgets, dashboards, docs, items } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * "How to start?" phase B: templates keep their views (a seed's, a saved board's), kits carry
 * dashboards and docs (saved from an account, made with every board), a built structure brings views, switched-off
 * automations and docs, and sample rows can be taken away in one batch — and brought back with one undo.
 */
let t: TestContext;
let owner: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(owner, acmeId);
const viewsOf = async (boardId: string) => (await body(await as().get(`/boards/${boardId}/views`))).data as Json[];

const BLUEPRINT = {
  workspace_name: 'Studio',
  boards: [
    {
      key: 'tasks',
      name: 'Tasks',
      groups: [{ title: 'This week' }, { title: 'Later' }],
      columns: [
        { title: 'Status', type: 'status', labels: ['New', 'Working', 'Done'] },
        { title: 'Owner', type: 'people' },
        { title: 'Due', type: 'date' },
      ],
      items: [
        { name: 'Logo', values: { Status: 'Working', Due: '2026-11-03' } },
        { name: 'Website', values: { Status: 'New' } },
      ],
      views: [
        { name: 'Board', type: 'kanban', column: 'Status' },
        { name: 'Calendar', type: 'calendar', column: 'Due' },
        { name: 'Nope', type: 'kanban', column: 'No such column' },
      ],
    },
  ],
  automations: [
    {
      board: 'tasks',
      title: 'Done → tell the owner',
      when: { type: 'status_changed', column: 'Status', to: 'Done' },
      then: { type: 'notify', who: 'Owner' },
    },
    {
      board: 'tasks',
      title: 'New → New',
      when: { type: 'item_created' },
      then: { type: 'set_status', column: 'Status', label: 'New' },
    },
    // No such column: left out, reported.
    {
      board: 'tasks',
      title: 'Bad',
      when: { type: 'date_arrives', column: 'Missing' },
      then: { type: 'notify', who: 'owners' },
    },
  ],
  docs: [{ name: 'How we work', markdown: '# How we work\n\nEvery task has an **owner**.' }],
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: OWNER_EMAIL,
        template_set: 'empty',
      }),
    )
  ).account.id;
  expect((await t.api(owner).post('/invitations/accept', { token: t.inviteTokenFor(OWNER_EMAIL) })).status).toBe(200);
  wsId = (await body(await as().get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('templates keep their views', () => {
  it('a seed template’s views come with a board made from it (its older shape read as far as it maps)', async () => {
    const b = await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId, template_key: 'leads' }));
    const views = await viewsOf(b.id);
    const kanban = views.find((v) => v.type === 'kanban')!;
    expect(kanban.name).toBe('Kanban לפי סטטוס');
    expect(kanban.settings.kanban.column_id).toBe('color_mm6x5rvw');
  });

  it('"save as template" keeps the board’s shared views; a board from it has them', async () => {
    const src = await body(await as().post('/boards', { name: 'Pipeline', workspace_id: wsId }));
    const col = await body(await as().post(`/boards/${src.id}/columns`, { title: 'Stage', type: 'status' }));
    expect(
      (
        await as().post(`/boards/${src.id}/views`, {
          name: 'Stages',
          type: 'kanban',
          settings: { kanban: { column_id: col.id } },
        })
      ).status,
    ).toBe(201);
    // A view filtered by a group and a status, and a personal view (never carried).
    const group = (await body(await as().get(`/boards/${src.id}`))).groups[0];
    const filter = {
      kind: 'group',
      operator: 'and',
      rules: [
        { kind: 'rule', column_id: '__group__', operator: 'any_of', values: [group.id] },
        { kind: 'rule', column_id: col.id, operator: 'is_not_empty', values: [] },
      ],
    };
    expect(
      (await as().post(`/boards/${src.id}/views`, { name: 'Mine', type: 'table', settings: { query: { filter } } }))
        .status,
    ).toBe(201);
    expect(
      (await as().post(`/boards/${src.id}/views`, { name: 'Private', type: 'table', visibility: 'private' })).status,
    ).toBe(201);
    const tpl = await body(await as().post(`/boards/${src.id}/save-as-template`, { name: 'Pipeline T' }));
    const made = await body(await as().post('/boards', { name: 'From T', workspace_id: wsId, template_key: tpl.key }));
    const views = await viewsOf(made.id);
    const stages = views.find((v) => v.name === 'Stages')!;
    expect(stages.type).toBe('kanban');
    expect(stages.settings.kanban.column_id).toBe(col.id);
    expect(views.some((v) => v.name === 'Private')).toBe(false);
    const newGroup = (await body(await as().get(`/boards/${made.id}`))).groups[0];
    const rules = views.find((v) => v.name === 'Mine')!.settings.query.filter.rules;
    expect(rules).toEqual([
      expect.objectContaining({ column_id: '__group__', values: [newGroup.id] }),
      expect.objectContaining({ column_id: col.id, operator: 'is_not_empty' }),
    ]);
    expect(newGroup.id).not.toBe(group.id);
  });
});

describe('kits carry dashboards and docs', () => {
  it('saved from an account with its dashboard and doc; a new account opens with both, over the kit’s boards', async () => {
    const leads = await body(await as().post('/boards', { name: 'Kit leads', workspace_id: wsId }));
    await as().post(`/boards/${leads.id}/columns`, { title: 'Stage', type: 'status' });
    const dash = await body(
      await as().post(`/workspaces/${wsId}/dashboards`, { name: 'Sales view', board_ids: [leads.id] }),
    );
    await as().post(`/dashboards/${dash.id}/widgets`, {
      type: 'chart',
      title: 'By stage',
      settings: { board_ids: [leads.id], x: { kind: 'column', column: { type: 'status', title: 'Stage' } } },
    });
    const doc = await body(await as().post(`/workspaces/${wsId}/docs`, { name: 'Playbook' }));
    const sources = await body(await t.api(owner).get(`/platform/accounts/${acmeId}/kit-boards`));
    expect(sources.dashboards.map((d: Json) => d.id)).toContain(dash.id);
    expect(sources.docs.map((d: Json) => d.id)).toContain(doc.id);
    const kit = await t.api(owner).post('/platform/starter-kits', {
      key: 'sales-kit',
      name: 'Sales kit',
      account_id: acmeId,
      board_ids: [leads.id],
      dashboard_ids: [dash.id],
      doc_ids: [doc.id],
    });
    const saved = await body(kit);
    expect(kit.status, JSON.stringify(saved)).toBe(201);
    expect(saved).toMatchObject({ dashboards: ['Sales view'], docs: ['Playbook'] });
    const res = await t.api(owner).post('/platform/accounts', {
      name: 'Beta',
      slug: 'beta',
      first_admin_email: 'admin@beta.test',
      template_set: 'sales-kit',
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const betaId = (await body(res)).account.id as string;
    const [board] = await t.db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, betaId), isNull(boards.parentBoardId)));
    const [d] = await t.db.select().from(dashboards).where(eq(dashboards.accountId, betaId));
    expect(d).toMatchObject({ name: 'Sales view' });
    expect((d!.settings as Json).board_ids).toEqual([board!.id]);
    const [w] = await t.db.select().from(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, d!.id));
    expect(w).toMatchObject({ type: 'chart', title: 'By stage' });
    expect((w!.settings as Json).board_ids).toEqual([board!.id]);
    expect((await t.db.select().from(docs).where(eq(docs.accountId, betaId))).map((x) => x.name)).toEqual(['Playbook']);
  });
});

describe('a built structure: views, automations, docs — and sample rows that can go', () => {
  it('builds the views, the automations switched off (a bad one left out) and the doc', async () => {
    const res = await as().post('/onboarding/build', { blueprint: BLUEPRINT });
    const out = await body(res);
    expect(res.status, JSON.stringify(out)).toBe(201);
    expect(out.issues).toEqual(['automation_skipped:3']);
    expect(out.automation_ids).toHaveLength(2);
    const views = await viewsOf(out.board_ids[0]);
    expect(views.filter((v) => !v.is_system).map((v) => `${v.type}:${v.name}`)).toEqual([
      'kanban:Board',
      'calendar:Calendar',
    ]);
    const autos = await t.db.select().from(automations).where(eq(automations.boardId, out.board_ids[0]));
    expect(autos).toHaveLength(2);
    expect(autos.every((a) => a.isActive === false)).toBe(true);
    expect(autos.map((a) => a.deactivatedReason)).toEqual([null, null]);
    const [doc] = await t.db.select().from(docs).where(eq(docs.id, out.doc_ids[0]));
    expect(doc!.name).toBe('How we work');
    expect(doc!.textValue).toContain('owner');
  });

  it('"delete the sample data": the rows go in one batch; one undo brings them back', async () => {
    const state = await body(await as().get('/onboarding'));
    expect(state.sample.items).toBe(2);
    const del = await body(await as().del('/onboarding/sample'));
    expect(del.removed).toBe(2);
    const board = state.sample.board_ids[0];
    const live = () =>
      t.db
        .select()
        .from(items)
        .where(and(eq(items.boardId, board), isNull(items.deletedAt)));
    expect(await live()).toHaveLength(0);
    expect((await body(await as().get('/onboarding'))).sample).toEqual({ items: 0, board_ids: [] });
    expect((await as().post(`/activity/batches/${del.batch_id}/undo`, {})).status).toBe(200);
    expect(await live()).toHaveLength(2);
  });
});
