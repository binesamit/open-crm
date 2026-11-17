// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, automationRuns } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Item templates, phase 2: automations — "create an item from template X" (another board, its
 * questions answered from the trigger item, linked both ways) and "add the template's subitems" — and forms ("each
 * submission creates an item from template X"). Both go through the templates service as the automation's owner /
 * the form's creator: their rights, one undoable batch, and clear skip reasons.
 */
let t: TestContext;
let acmeId: string;
let admin: string;
let bob: string;
let ids: Record<'admin' | 'bob', string>;
let clients: string; // the automations' board
let projects: string; // where the new items go
let secret: string; // a private board of the admin
let projectsGroup2: string;
let projectTpl: Json; // on projects
let clientTpl: Json; // on clients
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const person = (id: string) => ({ persons_and_teams: [{ id, kind: 'person' }] });

const seen = new Set<string>();
const drain = async () => {
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
      for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
    }
  }
};
const runsOf = (automationId: string) =>
  t.db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(asc(automationRuns.createdAt));
const getItem = async (id: string) => body(await as(admin).get(`/items/${id}`));
const tree = async (itemId: string): Promise<Json> => {
  const it = await getItem(itemId);
  const kids = (await body(await as(admin).get(`/items/${itemId}/subitems`))).data as Json[];
  return { ...it, children: await Promise.all(kids.map((k) => tree(k.id))) };
};
const automation = async (recipe: Json, cookie = admin, boardId = clients) =>
  as(cookie).post(`/boards/${boardId}/automations`, { title: 'T', recipe });
const off = (id: string) => as(admin).post(`/automations/${id}/deactivate`, {});

/** The tree both templates make: `{name}`, dates in working days after `start`, the owner, an update. */
const root = {
  id: 'root',
  name: '{name}',
  cells: {
    due: { kind: 'date', var: 'start', from: 0 },
    owner: { kind: 'var', var: 'owner' },
    pkg: { kind: 'value', value: 'בסיס' },
  },
  updates: [{ text: 'נפתח עבור {name}' }],
  children: [
    {
      id: 'a',
      name: 'התנעה עם {name}',
      cells: { date: { kind: 'date', var: 'start', from: 2 } },
      children: [{ id: 'b', name: 'הכנה', cells: {}, children: [] }],
    },
    { id: 'c', name: 'מסירה', cells: {}, children: [] },
  ],
};
const variables = [
  { key: 'name', label: 'שם', type: 'text', required: true },
  { key: 'start', label: 'תאריך התחלה', type: 'date', required: true, default: null },
  { key: 'owner', label: 'אחראי', type: 'person' },
];

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test') };
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  clients = (await body(await as(admin).post('/boards', { name: 'לקוחות', workspace_id: ws }))).id;
  projects = (await body(await as(admin).post('/boards', { name: 'פרויקטים', workspace_id: ws }))).id;
  secret = (await body(await as(admin).post('/boards', { name: 'סודי', workspace_id: ws, kind: 'private' }))).id;
  projectsGroup2 = (await body(await as(admin).post(`/boards/${projects}/groups`, { title: 'חדשים' }))).id;
  for (const b of [clients, projects, secret])
    for (const c of [
      { id: 'owner', title: 'אחראי', type: 'people' },
      { id: 'due', title: 'יעד', type: 'date' },
      { id: 'pkg', title: 'חבילה', type: 'text' },
    ])
      expect((await as(admin).post(`/boards/${b}/columns`, c)).status).toBe(201);
  const rel = (id: string, title: string, board: string) => ({
    id,
    title,
    type: 'board_relation',
    settings: { board_ids: [board] },
  });
  expect((await as(admin).post(`/boards/${clients}/columns`, rel('projects', 'פרויקטים', projects))).status).toBe(201);
  expect((await as(admin).post(`/boards/${projects}/columns`, rel('client', 'לקוח', clients))).status).toBe(201);
  const make = async (board: string, name: string, tplRoot: Json = root) => {
    const res = await as(admin).post(`/boards/${board}/item-templates`, { name, variables, root: tplRoot });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return body(res);
  };
  projectTpl = await make(projects, 'פרויקט חדש');
  clientTpl = await make(clients, 'קליטה');
  await make(secret, 'סודית');
  await drain(); // setup events: nothing listens yet
});
afterAll(() => t.close());

describe('saving an automation with a template action', () => {
  it('checks the template, its questions and where they take their answers', async () => {
    const issues = async (action: Json, cookie = admin) => {
      const res = await automation({ trigger: { type: 'item_created' }, actions: [action] }, cookie);
      expect(res.status).toBe(422);
      return (await body(res)).error.details.issues as Json[];
    };
    // A date question answered by a text column; a question the template does not have.
    expect(
      await issues({
        type: 'create_item_from_template',
        board: projects,
        template: projectTpl.id,
        variables: { start: 'pkg', other: 'due' },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'actions.0.variables.start', code: 'column_type' }),
        expect.objectContaining({ path: 'actions.0.variables.other', code: 'item_template_unknown_variable' }),
      ]),
    );
    // A template of another board than the one it creates on / than the automation's (subitems).
    expect(await issues({ type: 'create_item_from_template', board: '@self', template: projectTpl.id })).toContainEqual(
      expect.objectContaining({ path: 'actions.0.template', code: 'item_template_not_found' }),
    );
    expect(await issues({ type: 'add_template_subitems', template: projectTpl.id })).toContainEqual(
      expect.objectContaining({ path: 'actions.0.template', code: 'item_template_not_found' }),
    );
  });

  it('a member may not use a template of a board they cannot see', async () => {
    const tpl = (await body(await as(admin).get(`/boards/${secret}/item-templates`))).data[0];
    const res = await automation(
      {
        trigger: { type: 'item_created' },
        actions: [{ type: 'create_item_from_template', board: secret, template: tpl.id }],
      },
      bob,
    );
    expect(res.status).toBe(422);
    expect((await body(res)).error.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'actions.0.template', code: 'item_template_not_found' }),
      ]),
    );
  });

  it('names the template in the automation’s default title', async () => {
    // No title sent: the recipe's sentence, with the template's name.
    const res = await as(admin).post(`/boards/${clients}/automations`, {
      recipe: {
        trigger: { type: 'item_created' },
        actions: [{ type: 'add_template_subitems', template: clientTpl.id }],
      },
    });
    expect(res.status).toBe(201);
    const a = await body(res);
    expect(a.title).toContain('קליטה');
    await off(a.id);
  });
});

describe('create an item from a template', () => {
  let automationId: string;
  let lead: Json;
  let made: Json;

  it('makes the whole tree on the other board, with the trigger item’s answers, linked both ways', async () => {
    const res = await automation({
      trigger: { type: 'item_created' },
      actions: [
        {
          type: 'create_item_from_template',
          board: projects,
          template: projectTpl.id,
          group: projectsGroup2,
          variables: { name: 'name', start: 'due', owner: 'owner' },
          connect_column: 'projects',
          connect_back_column: 'client',
        },
      ],
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    automationId = (await body(res)).id;
    lead = await body(
      await as(admin).post(`/boards/${clients}/items`, {
        name: 'חברת גמא',
        cells: { due: { date: '2026-11-16' }, owner: person(ids.bob) },
      }),
    );
    await drain();
    const [run] = await runsOf(automationId);
    expect(run, JSON.stringify(run?.actionsLog)).toMatchObject({ status: 'succeeded' });
    const out = (run!.actionsLog as Json[])[0]!.output;
    expect(out).toMatchObject({ board_id: projects, created: 4 });
    made = await tree(out.item_id);
    expect(made).toMatchObject({ name: 'חברת גמא', board_id: projects, group_id: projectsGroup2 });
    expect(made.cells.due.value).toEqual({ date: '2026-11-16' });
    expect(made.cells.owner.value).toEqual(person(ids.bob));
    expect(made.cells.pkg.value).toBe('בסיס');
    expect(made.cells.client.value.item_ids).toEqual([lead.id]);
    expect(made.children.map((c: Json) => c.name)).toEqual(['התנעה עם חברת גמא', 'מסירה']);
    expect(made.children[0].cells.date.value).toEqual({ date: '2026-11-18' }); // Mon + 2 working days
    expect(made.children[0].children[0].name).toBe('הכנה');
    const ups = (await body(await as(admin).get(`/items/${made.id}/updates`))).data as Json[];
    expect(ups[0]!.body_text ?? ups[0]!.text).toContain('נפתח עבור חברת גמא');
    // Made by the automation, as its owner.
    expect((await getItem(lead.id)).cells.projects.value.item_ids).toEqual([made.id]);
    expect(out.batch_id).toBeTruthy();
  });

  it('one undo takes back the tree and the link on the trigger item', async () => {
    const [run] = await runsOf(automationId);
    const batch = (run!.actionsLog as Json[])[0]!.output.batch_id as string;
    const res = await as(admin).post(`/activity/batches/${batch}/undo`);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await as(admin).get(`/items/${made.id}`)).status).toBe(404);
    expect((await as(admin).get(`/items/${made.children[0].id}`)).status).toBe(404);
    expect((await getItem(lead.id)).cells.projects?.value?.item_ids ?? []).toEqual([]);
    await drain();
  });

  it('a required question with no answer is a skip that names it', async () => {
    const before = (await runsOf(automationId)).length;
    await as(admin).post(`/boards/${clients}/items`, { name: 'בלי תאריך' });
    await drain();
    const runs = await runsOf(automationId);
    expect(runs).toHaveLength(before + 1);
    const run = runs[runs.length - 1]!;
    expect(run.status).toBe('skipped');
    expect((run.actionsLog as Json[])[0]).toMatchObject({
      status: 'skipped',
      reason: 'missing_variables: תאריך התחלה',
    });
  });

  it('a template deleted since stops the automation (it needs fixing)', async () => {
    expect((await as(admin).del(`/item-templates/${projectTpl.id}`)).status).toBe(200);
    await as(admin).post(`/boards/${clients}/items`, { name: 'אחרי מחיקה', cells: { due: { date: '2026-11-16' } } });
    await drain();
    const runs = await runsOf(automationId);
    const run = runs[runs.length - 1]!;
    expect(run.status).toBe('failed');
    expect((run.actionsLog as Json[])[0]).toMatchObject({ status: 'error' });
    expect(String((run.actionsLog as Json[])[0]!.error)).toContain('item_template_not_found');
    const a = await body(await as(admin).get(`/automations/${automationId}`));
    expect(a.is_active).toBe(false);
    expect(a.deactivated_reason).toContain('item_template_not_found');
    expect((await as(admin).post(`/item-templates/${projectTpl.id}/restore`)).status).toBe(200);
  });
});

describe('add the template’s subitems under the trigger item', () => {
  let automationId: string;

  it('adds the subitems (every level) and fills only the item’s empty cells', async () => {
    const res = await automation({
      trigger: { type: 'column_changed', column: 'pkg' },
      actions: [{ type: 'add_template_subitems', template: clientTpl.id, variables: { name: 'name', start: 'due' } }],
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    automationId = (await body(res)).id;
    const item = await body(
      await as(admin).post(`/boards/${clients}/items`, { name: 'לקוח דלתא', cells: { due: { date: '2026-11-16' } } }),
    );
    await drain();
    await as(admin).put(`/items/${item.id}/cells/pkg`, { value: 'פרימיום' });
    await drain();
    const [run] = await runsOf(automationId);
    expect(run, JSON.stringify(run?.actionsLog)).toMatchObject({ status: 'succeeded' });
    expect((run!.actionsLog as Json[])[0]!.output).toMatchObject({ item_id: item.id, created: 3 });
    const made = await tree(item.id);
    expect(made.cells.pkg.value).toBe('פרימיום'); // kept
    expect(made.children.map((c: Json) => c.name)).toEqual(['התנעה עם לקוח דלתא', 'מסירה']);
    expect(made.children[0].children.map((c: Json) => c.name)).toEqual(['הכנה']);

    // One undo removes the subitems again.
    const batch = (run!.actionsLog as Json[])[0]!.output.batch_id as string;
    expect((await as(admin).post(`/activity/batches/${batch}/undo`)).status).toBe(200);
    expect((await tree(item.id)).children).toEqual([]);
    await drain();
    await off(automationId);
  });

  it('a template with no subitems is a skip', async () => {
    const flat = await body(
      await as(admin).post(`/boards/${clients}/item-templates`, {
        name: 'שטוחה',
        variables: [],
        root: { id: 'root', name: 'x', cells: {}, children: [] },
      }),
    );
    const res = await automation({
      trigger: { type: 'column_changed', column: 'pkg' },
      actions: [{ type: 'add_template_subitems', template: flat.id }],
    });
    const id = (await body(res)).id;
    const item = await body(await as(admin).post(`/boards/${clients}/items`, { name: 'אפסילון' }));
    await drain();
    await as(admin).put(`/items/${item.id}/cells/pkg`, { value: 'x' });
    await drain();
    const [run] = await runsOf(id);
    expect((run!.actionsLog as Json[])[0]).toMatchObject({ status: 'skipped', reason: 'template_has_no_subitems' });
    await off(id);
  });
});

describe('forms: each submission creates an item from a template', () => {
  let viewId: string;
  let token: string;
  const Q = { name: 'qname001', due: 'qdue0001', pkg: 'qpkg0001', owner: 'qownr001' };
  const save = (patch: Json) => as(admin).patch(`/views/${viewId}/form`, patch);
  const submit = (answers: Json) =>
    t.app.request(`/api/v1/public/forms/${token}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
      body: JSON.stringify({ answers }),
    });

  beforeAll(async () => {
    viewId = (await body(await as(admin).post(`/boards/${clients}/views`, { type: 'form', name: 'הרשמה' }))).id;
    token = (await body(await as(admin).get(`/views/${viewId}/form`))).token;
    const res = await save({
      questions: [
        { id: Q.name, column_key: 'name', required: true },
        { id: Q.due, column_key: 'due' },
        { id: Q.pkg, column_key: 'pkg' },
        // A hidden people question: the person the form assigns (its creator's choice).
        { id: Q.owner, column_key: 'owner', hidden: true, default_value: [ids.bob] },
      ],
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  });

  it('checks the template and the questions on save', async () => {
    const bad = async (item_template: Json) => {
      const res = await save({ settings: { item_template } });
      expect(res.status).toBe(422);
      return (await body(res)).error.details.reason;
    };
    expect(await bad({ template_id: projectTpl.id, variables: {} })).toBe('item_template_not_found');
    expect(await bad({ template_id: clientTpl.id, variables: { nope: Q.due } })).toBe('item_template_unknown_variable');
    expect(await bad({ template_id: clientTpl.id, variables: { start: 'qmissing' } })).toBe(
      'item_template_unknown_question',
    );
    const ok = await save({
      settings: { item_template: { template_id: clientTpl.id, variables: { start: Q.due, owner: Q.owner } } },
    });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    expect((await body(ok)).settings.item_template).toEqual({
      template_id: clientTpl.id,
      variables: { start: Q.due, owner: Q.owner },
    });
  });

  it('makes the tree: the answers are the item’s own values, the mapped ones answer the questions — one batch', async () => {
    const res = await submit({ [Q.name]: 'חברת זטא', [Q.due]: '2026-11-16', [Q.pkg]: 'מורחבת' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const items = (await body(await as(admin).get(`/boards/${clients}/items`))).data as Json[];
    const it = items.find((x) => x.name === 'חברת זטא')!;
    expect(it).toBeTruthy();
    const made = await tree(it.id);
    expect(made.cells.pkg.value).toBe('מורחבת'); // the answer wins over the template's value
    expect(made.cells.due.value).toEqual({ date: '2026-11-16' });
    expect(made.cells.owner.value).toEqual(person(ids.bob)); // from the hidden question, through the variable
    // `name` was not mapped: the item's own name is the answer, the subitems' `{name}` stays as written.
    expect(made.children.map((c: Json) => c.name)).toEqual(['התנעה עם {name}', 'מסירה']);
    expect(made.children[0].cells.date.value).toEqual({ date: '2026-11-18' });
    const events = await t.db
      .select({ batchId: activityLog.batchId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.type, 'item.created'),
          inArray(activityLog.itemId, [made.id, ...made.children.map((c: Json) => c.id)]),
        ),
      );
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.batchId)).size).toBe(1);
  });

  it('the name question answers `name`; a required question unanswered never refuses the submission', async () => {
    expect(
      (
        await save({
          settings: { item_template: { template_id: clientTpl.id, variables: { name: Q.name, start: Q.due } } },
        })
      ).status,
    ).toBe(200);
    // `start` is required with no default: left empty, the submission still goes through.
    const res = await submit({ [Q.name]: 'חברת אטא' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const items = (await body(await as(admin).get(`/boards/${clients}/items`))).data as Json[];
    const made = await tree(items.find((x) => x.name === 'חברת אטא')!.id);
    expect(made.children.map((c: Json) => c.name)).toEqual(['התנעה עם חברת אטא', 'מסירה']);
    expect(made.cells.due).toBeFalsy();
  });

  it('a template deleted since: a plain item, never a refused submission', async () => {
    const extra = await body(
      await as(admin).post(`/boards/${clients}/item-templates`, { name: 'זמנית', variables, root }),
    );
    expect(
      (await save({ settings: { item_template: { template_id: extra.id, variables: { start: Q.due } } } })).status,
    ).toBe(200);
    expect((await as(admin).del(`/item-templates/${extra.id}`)).status).toBe(200);
    const res = await submit({ [Q.name]: 'חברת תטא', [Q.due]: '2026-11-16' });
    expect(res.status).toBe(200);
    const items = (await body(await as(admin).get(`/boards/${clients}/items`))).data as Json[];
    const made = await tree(items.find((x) => x.name === 'חברת תטא')!.id);
    expect(made.children).toEqual([]);
    expect(made.cells.due.value).toEqual({ date: '2026-11-16' });
  });
});
