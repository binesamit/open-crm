// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docPlainText, type RichNode } from '@bines/shared';
import { purgeOrphanFiles, purgeTrash } from '../../worker/src/tasks';
import { type CollabContext, createCollab, DOC_EDITED_EVERY_MS, type Collab } from '../src/modules/docs/collab';
import { decodeState, deriveDoc, encodeState, jsonToYdoc, ydocToJson } from '../src/modules/docs/ydoc';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * M8 ד1 — docs: a workspace object next to boards (tree, folders, order, favourites, trash), permissioned like a
 * board (main / private / shareable; owner / editor / commenter / viewer), its Yjs state persisted with derived
 * JSON + text (search), `doc.edited` throttled per person, and files in docs kept from the orphan sweep.
 */
let t: TestContext;
let collab: Collab;
let clock = Date.now();
let admin: string;
let bob: string; // member
let vera: string; // account viewer
let gus: string; // guest
let acmeId: string;
let otherId: string;
let otherAdmin: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string, account = acmeId) => t.api(cookie, account);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};
const userId = async (email: string) =>
  ((await body(await as(admin).get('/users'))).data as Json[]).find((u) => u.email === email)!.user_id as string;
const newDoc = async (cookie: string, input: Json = {}, workspace = wsId) => {
  const res = await as(cookie).post(`/workspaces/${workspace}/docs`, input);
  expect(res.status).toBe(201);
  return body(res);
};
const tree = async (cookie: string, workspace = wsId) => body(await as(cookie).get(`/workspaces/${workspace}/tree`));

/** A direct (in-process) connection's context: a change through it counts as this user's. */
const editor = (userId: string) => ({ userId }) as CollabContext;

/** Writes `json` into the doc as an editor would (through the collab server) and saves it. */
const write = async (docId: string, json: RichNode, userId: string, account = acmeId) => {
  const conn = await collab.hocuspocus.openDirectConnection(`${account}:${docId}`, editor(userId));
  await conn.transact((doc) => {
    const fragment = doc.getXmlFragment('default');
    fragment.delete(0, fragment.length);
    Y.applyUpdate(doc, encodeState(jsonToYdoc(json)));
  });
  await conn.disconnect(); // the last connection: saved now
};

const p = (text: string): RichNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const sample: RichNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'תוכנית רבעונית' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Revenue ' },
        { type: 'text', text: 'grows', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' fast', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] },
      ],
    },
    {
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('לסגור חוזה')] }],
    },
  ],
};

beforeAll(async () => {
  t = await createTestContext();
  collab = createCollab(t.deps, { now: () => clock });
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const account = async (slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: slug,
          slug,
          first_admin_email: email,
          template_set: 'empty',
        }),
      )
    ).account.id as string;
  acmeId = await account('acme', 'admin@acme.test');
  otherId = await account('other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  await as(admin).post('/users/invite', { emails: ['gus@guest.test'], role: 'guest' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  gus = await join('gus@guest.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(async () => {
  await collab.close();
  await t.close();
});

describe('Yjs ⇄ JSON and derived text', () => {
  it('round-trips content (marks, attrs, nesting) through a Yjs update', () => {
    const state = encodeState(jsonToYdoc(sample));
    expect(ydocToJson(decodeState(state))).toEqual(sample);
  });

  it('derives the search text block by block, with mentions', () => {
    const d = deriveDoc(jsonToYdoc(sample));
    expect(d.text).toBe('תוכנית רבעונית\nRevenue grows fast\nלסגור חוזה');
    expect(
      docPlainText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'mention', attrs: { id: 'U', label: 'Dana' } },
              { type: 'text', text: ' hi' },
            ],
          },
          { type: 'paragraph' },
        ],
      }),
    ).toBe('@Dana hi');
    expect(docPlainText({ type: 'doc', content: [] })).toBe('');
  });
});

describe('docs in the workspace (ד0 tree + ד1 CRUD)', () => {
  it('a new doc is in the tree with the boards, ordered with them; it moves among them and into folders', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Board A', workspace_id: wsId }));
    const doc = await newDoc(admin, { name: 'Spec' });
    expect(doc).toMatchObject({ name: 'Spec', kind: 'main', folder_id: null, collab_name: `${acmeId}:${doc.id}` });
    expect(doc.capabilities).toEqual({ 'doc.read': true, 'doc.comment': true, 'doc.edit': true, 'doc.manage': true });

    let tr = await tree(admin);
    const entity = tr.entities.find((e: Json) => e.id === doc.id);
    expect(entity).toMatchObject({ type: 'doc', name: 'Spec', can_update: true, can_delete: true });
    expect(entity.position > tr.boards.find((b: Json) => b.id === board.id).position).toBe(true);

    // Before the board (one order for boards and docs), then the board after the doc again.
    await as(admin).patch(`/docs/${doc.id}`, { position: { before_id: board.id } });
    tr = await tree(admin);
    const pos = (id: string) => [...tr.boards, ...tr.entities].find((x: Json) => x.id === id).position;
    expect(pos(doc.id) < pos(board.id)).toBe(true);
    expect((await as(admin).patch(`/boards/${board.id}`, { position: { before_id: doc.id } })).status).toBe(200);
    tr = await tree(admin);
    expect(pos(board.id) < pos(doc.id)).toBe(true);

    // Into a folder, rename, icon.
    const folder = await body(await as(admin).post('/folders', { workspace_id: wsId, name: 'Specs' }));
    const moved = await body(
      await as(admin).patch(`/docs/${doc.id}`, { folder_id: folder.id, name: 'Spec v2', icon: '📄' }),
    );
    expect(moved).toMatchObject({ folder_id: folder.id, name: 'Spec v2', icon: '📄' });

    // The folder goes to trash: the doc to the root; restoring the folder brings it back in.
    const del = await body(await as(admin).del(`/folders/${folder.id}`));
    expect((await tree(admin)).entities.find((e: Json) => e.id === doc.id).folder_id).toBeNull();
    expect((await as(admin).post(`/activity/${del.event_id}/undo`, {})).status).toBe(200);
    expect((await tree(admin)).entities.find((e: Json) => e.id === doc.id).folder_id).toBe(folder.id);

    // A non-empty workspace (a doc counts) is not deleted.
    const ws2 = await body(await as(admin).post('/workspaces', { name: 'Docs only' }));
    const lone = await newDoc(admin, { name: 'Lone' }, ws2.id);
    expect((await as(admin).del(`/workspaces/${ws2.id}`)).status).toBe(409);
    await as(admin).patch(`/docs/${lone.id}`, { workspace_id: wsId });
    expect((await tree(admin)).entities.some((e: Json) => e.id === lone.id)).toBe(true);
    expect((await as(admin).del(`/workspaces/${ws2.id}`)).status).toBe(200);
  });

  it('another account never sees it (404), with its own header or ours', async () => {
    const doc = await newDoc(admin, { name: 'Acme only' });
    expect((await as(otherAdmin, otherId).get(`/docs/${doc.id}`)).status).toBe(404);
    expect((await as(otherAdmin, acmeId).get(`/docs/${doc.id}`)).status).toBe(404);
    expect((await as(otherAdmin, otherId).get(`/docs/${doc.id}/content`)).status).toBe(404);
  });
});

describe('permissions like a board', () => {
  it('main: members edit, account viewers read, guests do not exist; managing is for owners and admins', async () => {
    const doc = await newDoc(admin, { name: 'Main doc' });
    expect((await body(await as(bob).get(`/docs/${doc.id}`))).capabilities).toEqual({
      'doc.read': true,
      'doc.comment': true,
      'doc.edit': true,
      'doc.manage': false,
    });
    expect((await body(await as(vera).get(`/docs/${doc.id}`))).capabilities).toMatchObject({
      'doc.read': true,
      'doc.edit': false,
    });
    expect((await as(gus).get(`/docs/${doc.id}`)).status).toBe(404);
    expect((await as(bob).patch(`/docs/${doc.id}`, { name: 'x' })).status).toBe(403);
    expect((await as(bob).del(`/docs/${doc.id}`)).status).toBe(403);
    expect((await as(vera).post(`/workspaces/${wsId}/docs`, {})).status).toBe(403);
    expect((await as(gus).post(`/workspaces/${wsId}/docs`, {})).status).toBe(403);
  });

  it('private: only who is invited, at the level given; a doc keeps an owner', async () => {
    const doc = await newDoc(bob, { name: 'Secret', kind: 'private' });
    expect((await as(vera).get(`/docs/${doc.id}`)).status).toBe(404);
    expect((await tree(vera)).entities.some((e: Json) => e.id === doc.id)).toBe(false);
    // Admins manage every doc.
    expect((await body(await as(admin).get(`/docs/${doc.id}`))).capabilities['doc.manage']).toBe(true);

    const bobId = await userId('bob@acme.test');
    const veraId = await userId('vera@acme.test');
    const res = await as(bob).put(`/docs/${doc.id}/members`, {
      members: [
        { type: 'user', id: bobId, level: 'owner' },
        { type: 'user', id: veraId, level: 'commenter' },
      ],
    });
    expect(res.status).toBe(200);
    expect((await body(res)).data.map((m: Json) => [m.email, m.level])).toEqual([
      ['bob@acme.test', 'owner'],
      ['vera@acme.test', 'commenter'],
    ]);
    // An account viewer is a viewer whatever the invitation says (strictest wins).
    expect((await body(await as(vera).get(`/docs/${doc.id}`))).capabilities).toMatchObject({
      'doc.read': true,
      'doc.comment': false,
      'doc.edit': false,
    });
    expect((await tree(vera)).entities.some((e: Json) => e.id === doc.id)).toBe(true);

    expect((await as(vera).put(`/docs/${doc.id}/members`, { members: [] })).status).toBe(403);
    expect(
      (await as(bob).put(`/docs/${doc.id}/members`, { members: [{ type: 'user', id: veraId, level: 'editor' }] }))
        .status,
    ).toBe(400);
    // Guests only on a shareable doc.
    const gusId = await userId('gus@guest.test');
    const withGuest = {
      members: [
        { type: 'user', id: bobId, level: 'owner' },
        { type: 'user', id: gusId, level: 'viewer' },
      ],
    };
    expect((await as(bob).put(`/docs/${doc.id}/members`, withGuest)).status).toBe(400);
  });

  it('shareable: an invited guest reads it, and sees its workspace', async () => {
    const doc = await newDoc(admin, { name: 'For the client', kind: 'shareable' });
    const adminId = await userId('admin@acme.test');
    const gusId = await userId('gus@guest.test');
    expect((await as(gus).get(`/docs/${doc.id}`)).status).toBe(404);
    await as(admin).put(`/docs/${doc.id}/members`, {
      members: [
        { type: 'user', id: adminId, level: 'owner' },
        { type: 'user', id: gusId, level: 'owner' }, // a guest never owns: edits at most
      ],
    });
    const seen = await body(await as(gus).get(`/docs/${doc.id}`));
    expect(seen.capabilities).toMatchObject({ 'doc.read': true, 'doc.edit': true, 'doc.manage': false });
    expect(((await body(await as(gus).get('/workspaces'))).data as Json[]).some((w) => w.id === wsId)).toBe(true);
    const gusTree = await tree(gus);
    expect(gusTree.entities.map((e: Json) => e.id)).toEqual([doc.id]);
  });
});

describe('content, search, duplicate, favourites', () => {
  it('a save stores the Yjs state with its JSON and text; search finds the text; a copy keeps the content', async () => {
    const doc = await newDoc(admin, { name: 'Quarterly' });
    const adminId = await userId('admin@acme.test');
    await write(doc.id, sample, adminId);

    const content = await body(await as(bob).get(`/docs/${doc.id}/content`));
    expect(content.content).toEqual(sample);
    expect(content.text).toBe('תוכנית רבעונית\nRevenue grows fast\nלסגור חוזה');
    const row = (
      await t.db.execute<{ ydoc: Uint8Array; revision: number }>(
        sql`select ydoc, revision from docs where id = ${doc.id}`,
      )
    ).rows[0]!;
    expect(ydocToJson(decodeState(new Uint8Array(row.ydoc)))).toEqual(sample);
    expect(row.revision).toBe(2);

    // Reloaded from Postgres by a new connection (the doc left memory when the editor left).
    const conn = await collab.hocuspocus.openDirectConnection(`${acmeId}:${doc.id}`, editor(adminId));
    let loaded: RichNode | null = null;
    await conn.transact((d) => {
      loaded = ydocToJson(d);
    });
    await conn.disconnect();
    expect(loaded).toEqual(sample);

    const found = await body(await as(bob).get(`/search?q=${encodeURIComponent('לסגור')}`));
    expect(found.docs).toEqual([
      { id: doc.id, name: 'Quarterly', workspace: expect.any(String), excerpt: expect.stringContaining('לסגור חוזה') },
    ]);
    expect((await body(await as(gus).get(`/search?q=${encodeURIComponent('לסגור')}`))).docs).toEqual([]);

    const copy = await body(await as(bob).post(`/docs/${doc.id}/duplicate`, {}));
    expect(copy).toMatchObject({ name: 'Quarterly (2)', capabilities: { 'doc.manage': true } });
    expect((await body(await as(bob).get(`/docs/${copy.id}/content`))).content).toEqual(sample);
  });

  it('records one doc.edited per person per ~10 minutes of editing', async () => {
    const doc = await newDoc(admin, { name: 'Busy' });
    const adminId = await userId('admin@acme.test');
    const bobId = await userId('bob@acme.test');
    const edits = async () =>
      (
        await t.db.execute<{ actor_id: string }>(
          sql`select actor_id from activity_log where type = 'doc.edited' and payload->'meta'->>'doc_id' = ${doc.id}`,
        )
      ).rows.map((r) => r.actor_id);
    // A change through a connection with a user context (as the WebSocket's) counts for that user.
    const edit = async (userId: string, text: string) => {
      const conn = await collab.hocuspocus.openDirectConnection(`${acmeId}:${doc.id}`, editor(userId));
      await conn.transact((d) => {
        const el = new Y.XmlElement('paragraph');
        d.getXmlFragment('default').push([el]);
        const tx = new Y.XmlText();
        el.push([tx]);
        tx.insert(0, text);
      });
      await conn.disconnect();
    };
    await edit(adminId, 'one');
    await edit(adminId, 'two');
    await edit(bobId, 'three');
    expect((await edits()).sort()).toEqual([adminId, bobId].sort());
    clock += DOC_EDITED_EVERY_MS + 1;
    await edit(adminId, 'four');
    expect((await edits()).filter((x) => x === adminId)).toHaveLength(2);
    expect((await body(await as(admin).get(`/docs/${doc.id}/content`))).text).toBe('one\ntwo\nthree\nfour');
  });

  it('favourites: starred in my order, gone when the doc goes', async () => {
    const a = await newDoc(admin, { name: 'Fav A' });
    const b = await newDoc(admin, { name: 'Fav B' });
    const put = await body(await as(bob).put('/me/favorite-docs', { doc_ids: [b.id, a.id, 'NOPE'] }));
    expect(put.data.map((d: Json) => d.name)).toEqual(['Fav B', 'Fav A']);
    await as(admin).del(`/docs/${b.id}`);
    expect((await body(await as(bob).get('/me/favorite-docs'))).data.map((d: Json) => d.id)).toEqual([a.id]);
  });
});

describe('trash', () => {
  it('to trash, restored by undo and from trash; purged with its files — which the sweep never takes before', async () => {
    const doc = await newDoc(admin, { name: 'Disposable' });
    const del = await body(await as(admin).del(`/docs/${doc.id}`));
    expect((await as(admin).get(`/docs/${doc.id}`)).status).toBe(404);
    expect((await tree(admin)).entities.some((e: Json) => e.id === doc.id)).toBe(false);
    const entry = (await body(await as(admin).get('/trash'))).data.find((e: Json) => e.object_id === doc.id);
    expect(entry).toMatchObject({ object_type: 'doc', name: 'Disposable' });

    expect((await as(admin).post(`/activity/${del.event_id}/undo`, {})).status).toBe(200);
    expect((await as(admin).get(`/docs/${doc.id}`)).status).toBe(200);

    await as(admin).del(`/docs/${doc.id}`);
    const again = (await body(await as(admin).get('/trash'))).data.find((e: Json) => e.object_id === doc.id);
    expect((await as(admin).post(`/trash/${again.id}/restore`, {})).status).toBe(200);
    expect((await as(admin).get(`/docs/${doc.id}`)).status).toBe(200);

    // A file shown in the doc (an image, ד2): kept by the hourly sweep while the doc holds it.
    const pre = await body(await as(admin).post('/files/presign', { name: 'pic.png', size: 10, mime: 'image/png' }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 10, 'image/png');
    await as(admin).post(`/files/${pre.file_id}/complete`);
    const adminId = await userId('admin@acme.test');
    await write(
      doc.id,
      { type: 'doc', content: [{ type: 'image', attrs: { asset_id: pre.file_id, src: 'x' } }, p('caption')] },
      adminId,
    );
    await t.db.execute(sql`update assets set created_at = now() - interval '25 hours' where id = ${pre.file_id}`);
    const remove = async (k: string) => void t.storage.objects.delete(k);
    await purgeOrphanFiles(t.pg, remove, 1000, () => undefined);
    expect(t.storage.objects.has(key)).toBe(true);

    await as(admin).del(`/docs/${doc.id}`);
    expect((await as(admin).del('/trash')).status).toBe(200);
    const errors: string[] = [];
    await purgeTrash(t.pg, 1000, (m) => errors.push(m), remove);
    expect(errors).toEqual([]);
    expect((await t.db.execute(sql`select 1 from docs where id = ${doc.id}`)).rows).toHaveLength(0);
    expect(t.storage.objects.has(key)).toBe(false);
  });
});
