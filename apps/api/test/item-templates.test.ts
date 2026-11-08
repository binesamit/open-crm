// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Item templates: an item with subitems and sub-subitems saved as a template — its values, dates as
 * working days after a `start` variable, its owner and name as variables, updates and files (the template's own
 * copies) — then applied: a new item with the whole tree, or the subitems under an existing item. One undo trashes
 * all of it; reading needs the board, saving needs its structure.
 */
let t: TestContext;
let acmeId: string;
let admin: string;
let bob: string; // member
let vera: string; // account viewer
let boardId: string;
let ids: Record<'admin' | 'bob', string>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const upload = async (cookie: string, name: string, size = 100) => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size, mime: 'application/pdf' }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, size, 'application/pdf');
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};
const person = (id: string) => ({ persons_and_teams: [{ id, kind: 'person' }] });
const tree = async (itemId: string): Promise<Json> => {
  const it = await body(await as(admin).get(`/items/${itemId}`));
  const kids = (await body(await as(admin).get(`/items/${itemId}/subitems`))).data as Json[];
  return { ...it, children: await Promise.all(kids.map((k) => tree(k.id))) };
};

let source: Json; // the item saved as a template
let template: Json;

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
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test') };
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'לקוחות', workspace_id: ws }))).id;
  for (const c of [
    { id: 'owner', title: 'אחראי', type: 'people' },
    { id: 'due', title: 'יעד', type: 'date' },
    { id: 'pkg', title: 'חבילה', type: 'text' },
    { id: 'notes', title: 'הערות', type: 'long_text' },
    { id: 'docs', title: 'קבצים', type: 'file' },
  ])
    expect((await as(admin).post(`/boards/${boardId}/columns`, c)).status).toBe(201);

  // "חברת אלפא · קליטה", starting Sunday 8.11.2026, with two levels of subitems.
  source = await body(
    await as(admin).post(`/boards/${boardId}/items`, {
      name: 'חברת אלפא · קליטה',
      cells: {
        owner: person(ids.bob),
        due: { date: '2026-11-08' },
        pkg: 'אתר',
        notes: { text: 'לקוח: חברת אלפא · קליטה' },
      },
    }),
  );
  const kickoff = await body(
    await as(admin).post(`/items/${source.id}/subitems`, {
      name: 'פגישת התנעה',
      cells: { person: person(ids.bob), date: { date: '2026-11-10' } },
    }),
  );
  const materials = await body(
    await as(admin).post(`/items/${source.id}/subitems`, {
      name: 'חומרים מחברת אלפא · קליטה',
      cells: { date: { date: '2026-11-12' } },
    }),
  );
  await as(admin).post(`/items/${materials.id}/subitems`, { name: 'לוגו', cells: { person: person(ids.admin) } });
  expect(kickoff.id).toBeTruthy();
  const f = await upload(admin, 'brief.pdf');
  await as(admin).post(`/items/${source.id}/cells/docs/files`, { file_ids: [f] });
  const uf = await upload(admin, 'checklist.pdf');
  await as(admin).post(`/items/${source.id}/updates`, { body: 'ברוכים הבאים, חברת אלפא · קליטה', file_ids: [uf] });
});
afterAll(() => t.close());

describe('saving an item as a template', () => {
  it('keeps the tree, makes dates working days after `start`, the owner and the name variables', async () => {
    const res = await as(admin).post(`/items/${source.id}/save-as-template`, { name: 'קליטת לקוח', category: 'שירות' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    template = await body(res);
    expect(template).toMatchObject({ board_id: boardId, name: 'קליטת לקוח', category: 'שירות', nodes: 4, depth: 2 });
    expect(template.variables.map((v: Json) => v.key)).toEqual(['name', 'start', 'owner']);
    const root = template.root;
    expect(root.name).toBe('{name}');
    expect(root.cells.due).toEqual({ kind: 'date', var: 'start', from: 0, to: null, time: null });
    expect(root.cells.owner).toEqual({ kind: 'var', var: 'owner' });
    expect(root.cells.pkg).toEqual({ kind: 'value', value: 'אתר' });
    expect(root.cells.notes).toEqual({ kind: 'text', text: 'לקוח: {name}' });
    expect(root.cells.docs.kind).toBe('files');
    expect(root.cells.docs.files[0].name).toBe('brief.pdf');
    expect(root.updates[0]).toMatchObject({ text: 'ברוכים הבאים, {name}' });
    expect(root.updates[0].files[0].name).toBe('checklist.pdf');
    const [kickoff, materials] = root.children;
    // Tue 10.11 = 2 working days after Sun 8.11; Thu 12.11 = 4.
    expect(kickoff.cells.date).toMatchObject({ kind: 'date', var: 'start', from: 2 });
    expect(kickoff.cells.person).toEqual({ kind: 'var', var: 'owner' });
    expect(materials.name).toBe('חומרים מ{name}');
    expect(materials.cells.date).toMatchObject({ from: 4 });
    // Someone else than the owner stays as they were.
    expect(materials.children[0].cells.person).toEqual({ kind: 'value', value: person(ids.admin) });
    // The template holds its own copies of the files.
    expect(root.cells.docs.files[0].asset_id).not.toBe(source.cells?.docs?.value?.files?.[0]?.asset_id);
  });

  it('is listed on the board; viewers read it, only who may change the structure saves one', async () => {
    const list = await body(await as(vera).get(`/boards/${boardId}/item-templates`));
    expect(list.data.map((x: Json) => x.name)).toEqual(['קליטת לקוח']);
    expect(list.data[0].root).toBeUndefined();
    expect((await as(vera).post(`/items/${source.id}/save-as-template`, { name: 'x' })).status).toBe(403);
    expect((await as(vera).post(`/item-templates/${template.id}/apply`, { variables: {} })).status).toBe(403);
  });
});

describe('applying a template', () => {
  let applied: Json;

  it('makes the whole tree: names, dates moved in working days, the owner, updates and files', async () => {
    const res = await as(admin).post(`/item-templates/${template.id}/apply`, {
      variables: { name: 'חברת בטא', start: '2026-11-16', owner: [ids.admin] },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    applied = await body(res);
    expect(applied).toMatchObject({ created: 4, skipped: [] });
    const made = await tree(applied.item_id);
    expect(made.name).toBe('חברת בטא');
    expect(made.cells.due.value).toEqual({ date: '2026-11-16' });
    expect(made.cells.owner.value).toEqual(person(ids.admin));
    expect(made.cells.pkg.value).toBe('אתר');
    expect(made.cells.notes.value).toEqual({ text: 'לקוח: חברת בטא' });
    expect(made.cells.docs.value.files[0].name).toBe('brief.pdf');
    const [kickoff, materials] = made.children;
    expect(kickoff.name).toBe('פגישת התנעה');
    expect(kickoff.cells.date.value).toEqual({ date: '2026-11-18' }); // Mon + 2 working days
    expect(kickoff.cells.person.value).toEqual(person(ids.admin));
    expect(materials.name).toBe('חומרים מחברת בטא');
    expect(materials.cells.date.value).toEqual({ date: '2026-11-22' }); // Mon + 4 → over the weekend to Sunday
    expect(materials.children[0].name).toBe('לוגו');
    const ups = (await body(await as(admin).get(`/items/${applied.item_id}/updates`))).data as Json[];
    const first = ups[0]!;
    expect(first.body_text ?? first.text).toContain('ברוכים הבאים, חברת בטא');
    expect(first.files[0].name).toBe('checklist.pdf');
  });

  it('one undo sends the new item and its subitems to the trash', async () => {
    const res = await as(admin).post(`/activity/batches/${applied.batch_id}/undo`);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await as(admin).get(`/items/${applied.item_id}`)).status).toBe(404);
  });

  it('asks for required variables', async () => {
    const res = await as(admin).post(`/item-templates/${template.id}/apply`, { variables: { start: '2026-11-16' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await body(res))).toContain('name');
  });

  it('under an existing item: adds the subitems and fills only its empty cells', async () => {
    const target = await body(
      await as(bob).post(`/boards/${boardId}/items`, { name: 'לקוח קיים', cells: { pkg: 'פרימיום' } }),
    );
    const res = await as(bob).post(`/item-templates/${template.id}/apply`, {
      parent_item_id: target.id,
      variables: { name: 'לקוח קיים', start: '2026-11-16' },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect((await body(res)).created).toBe(3);
    const made = await tree(target.id);
    expect(made.cells.pkg.value).toBe('פרימיום'); // kept
    expect(made.cells.due.value).toEqual({ date: '2026-11-16' }); // was empty
    expect(made.children.map((c: Json) => c.name)).toEqual(['פגישת התנעה', 'חומרים מלקוח קיים']);
    expect(made.children[1].children[0].name).toBe('לוגו');
  });
});

describe('editing and deleting', () => {
  it('a new tree is a new version; the editor may add files just uploaded, not someone else’s', async () => {
    const f = await upload(admin, 'extra.pdf');
    const root = {
      ...template.root,
      children: [
        ...template.root.children,
        {
          id: 'n9',
          name: 'השקה',
          cells: {},
          updates: [{ text: 'מצורף', files: [{ asset_id: f, name: 'extra.pdf' }] }],
          children: [],
        },
      ],
    };
    const res = await as(admin).patch(`/item-templates/${template.id}`, { root });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await body(res)).toMatchObject({ version: 2, nodes: 5 });
    const other = await upload(bob, 'bob.pdf');
    const bad = { ...root, updates: [{ text: 'x', files: [{ asset_id: other, name: 'bob.pdf' }] }] };
    expect((await as(admin).patch(`/item-templates/${template.id}`, { root: bad })).status).toBe(422);
  });

  it('delete hides it; restore brings it back', async () => {
    expect((await as(admin).del(`/item-templates/${template.id}`)).status).toBe(200);
    expect((await body(await as(admin).get(`/boards/${boardId}/item-templates`))).data).toEqual([]);
    expect((await as(admin).post(`/item-templates/${template.id}/restore`)).status).toBe(200);
    expect((await body(await as(admin).get(`/boards/${boardId}/item-templates`))).data).toHaveLength(1);
  });

  it('a template of another account is not found', async () => {
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const betaId = (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: 'Beta',
          slug: 'beta',
          first_admin_email: 'admin@beta.test',
          template_set: 'empty',
        }),
      )
    ).account.id;
    const beta = await join('admin@beta.test');
    expect((await t.api(beta, betaId).get(`/item-templates/${template.id}`)).status).toBe(404);
    expect((await t.api(beta, betaId).post(`/item-templates/${template.id}/apply`, { variables: {} })).status).toBe(
      404,
    );
  });
});
