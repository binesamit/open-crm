// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docToMarkdown, type RichNode, SIDEBAR_EVENTS } from '@bines/shared';
import { type CollabContext, createCollab, type Collab } from '../src/modules/docs/collab';
import { meStream } from '../src/modules/realtime/realtime.service';
import { encodeState, jsonToYdoc } from '../src/modules/docs/ydoc';
import type { Db } from '../src/db/client';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * M8 ד2–ד3 — docs: `@` mentions notify (once, only who may read the doc), the `doc` column (a doc in a cell with
 * the item's permissions), comment threads on blocks (replies, resolve, mentions, notifications), versions (named,
 * automatic, preview, restore = a new version), export (HTML / Markdown / print, allowlisted),
 */
let t: TestContext;
let collab: Collab;
let admin: string;
let bob: string; // member
let vera: string; // account viewer
let gus: string; // guest
let acmeId: string;
let wsId: string;
let ids: Record<string, string> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};
const newDoc = async (cookie: string, input: Json = {}) => {
  const res = await as(cookie).post(`/workspaces/${wsId}/docs`, input);
  expect(res.status).toBe(201);
  return body(res);
};
const notifications = async (cookie: string) => (await body(await as(cookie).get('/me/notifications'))).data as Json[];

/** Writes `json` into the doc through the collab server as `userId`, and saves it. */
const write = async (docId: string, json: RichNode, userId: string) => {
  const conn = await collab.hocuspocus.openDirectConnection(`${acmeId}:${docId}`, { userId } as CollabContext);
  await conn.transact((doc) => {
    const fragment = doc.getXmlFragment('default');
    fragment.delete(0, fragment.length);
    Y.applyUpdate(doc, encodeState(jsonToYdoc(json)));
  });
  await conn.disconnect();
};
const p = (text: string, id?: string): RichNode => ({
  type: 'paragraph',
  ...(id ? { attrs: { id } } : {}),
  content: [{ type: 'text', text }],
});
const mention = (id: string, label: string): RichNode => ({ type: 'mention', attrs: { id, label } });
const docOf = (...content: RichNode[]): RichNode => ({ type: 'doc', content });
const comment = (text: string, mentionId?: string): RichNode =>
  docOf({
    type: 'paragraph',
    content: [...(mentionId ? [mention(mentionId, 'x')] : []), { type: 'text', text }],
  });

beforeAll(async () => {
  t = await createTestContext();
  collab = createCollab(t.deps);
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id as string;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  await as(admin).post('/users/invite', { emails: ['gus@guest.test'], role: 'guest' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  gus = await join('gus@guest.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  ids = Object.fromEntries(users.map((u) => [u.email.split('@')[0], u.user_id]));
});
afterAll(async () => {
  await collab.close();
  await t.close();
});

describe('@ mentions in a doc (ד2)', () => {
  it('a new mention notifies once, only people who can read the doc; the bell opens the doc', async () => {
    const doc = await newDoc(admin, { name: 'Plan', kind: 'private' });
    await as(admin).put(`/docs/${doc.id}/members`, {
      members: [
        { type: 'user', id: ids.admin, level: 'owner' },
        { type: 'user', id: ids.bob, level: 'viewer' },
      ],
    });
    // Bob is invited; Vera (account viewer) is not — a private doc she cannot read.
    await write(
      doc.id,
      docOf({ type: 'paragraph', content: [mention(ids.bob!, 'bob'), mention(ids.vera!, 'vera')] }),
      ids.admin!,
    );
    const bobs = (await notifications(bob)).filter((n) => n.type === 'doc_mention');
    expect(bobs).toHaveLength(1);
    expect(bobs[0]).toMatchObject({ doc: { id: doc.id, name: 'Plan', thread_id: null }, actor: { id: ids.admin } });
    expect((await notifications(vera)).some((n) => n.type === 'doc_mention')).toBe(false);

    // Saving again with the same mention does not notify again; the writer is never notified.
    await write(
      doc.id,
      docOf({ type: 'paragraph', content: [mention(ids.bob!, 'bob'), mention(ids.admin!, 'me')] }),
      ids.admin!,
    );
    expect((await notifications(bob)).filter((n) => n.type === 'doc_mention')).toHaveLength(1);
    expect((await notifications(admin)).some((n) => n.type === 'doc_mention')).toBe(false);

    // Losing access hides the notification (it would leak the doc's name).
    await as(admin).put(`/docs/${doc.id}/members`, { members: [{ type: 'user', id: ids.admin, level: 'owner' }] });
    expect((await notifications(bob)).some((n) => n.doc?.id === doc.id)).toBe(false);
  });
});

describe('the doc column (ד2)', () => {
  it('a doc in a cell has the item’s permissions; the cell shows its name', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Projects', workspace_id: wsId }));
    const col = await body(await as(admin).post(`/boards/${board.id}/columns`, { title: 'אפיון', type: 'doc' }));
    const item = await body(await as(bob).post(`/boards/${board.id}/items`, { name: 'Website' }));

    // The cell is never written directly.
    expect((await as(bob).put(`/items/${item.id}/cells/${col.id}`, { value: { doc_id: 'X' } })).status).toBe(422);

    // Vera (account viewer) cannot make it; Bob (member, edits the board) can — once.
    expect((await as(vera).post(`/items/${item.id}/cells/${col.id}/doc`, {})).status).toBe(403);
    const made = await body(await as(bob).post(`/items/${item.id}/cells/${col.id}/doc`, {}));
    expect(made.created).toBe(true);
    expect(made.doc).toMatchObject({
      name: 'Website',
      host: 'cell',
      cell: { board_id: board.id, item_id: item.id, item_name: 'Website', column_key: col.id },
    });
    expect(made.doc.capabilities).toMatchObject({ 'doc.edit': true, 'doc.manage': true });
    const again = await body(await as(admin).post(`/items/${item.id}/cells/${col.id}/doc`, {}));
    expect(again).toMatchObject({ created: false, doc: { id: made.doc.id } });
    const docId = made.doc.id as string;

    // The cell holds the doc; renaming the doc renames the cell's text.
    let cell = (await body(await as(bob).get(`/items/${item.id}`))).cells[col.id];
    expect(cell.value).toEqual({ doc_id: docId, name: 'Website' });
    await as(bob).patch(`/docs/${docId}`, { name: 'Website spec' });
    cell = (await body(await as(bob).get(`/items/${item.id}`))).cells[col.id];
    expect(cell.value).toEqual({ doc_id: docId, name: 'Website spec' });
    expect(cell.text).toBe('Website spec');

    // Not in the sidebar; no kind, place, members or trash of its own.
    expect(
      ((await body(await as(admin).get(`/workspaces/${wsId}/tree`))).entities as Json[]).some((e) => e.id === docId),
    ).toBe(false);
    expect((await as(bob).patch(`/docs/${docId}`, { kind: 'private' })).status).toBe(400);
    expect((await as(admin).del(`/docs/${docId}`)).status).toBe(400);
    expect((await as(admin).put(`/docs/${docId}/members`, { members: [] })).status).toBe(400);

    // Vera reads it (no comment: account viewers only read); a guest who does not see the board gets 404.
    expect((await body(await as(vera).get(`/docs/${docId}`))).capabilities).toEqual({
      'doc.read': true,
      'doc.comment': false,
      'doc.edit': false,
      'doc.manage': false,
    });
    expect((await as(gus).get(`/docs/${docId}`)).status).toBe(404);

    // A board where members only view and comment: Bob reads and comments, no longer edits.
    await as(admin).patch(`/boards/${board.id}`, { permission_set: 'view_comment' });
    expect((await body(await as(bob).get(`/docs/${docId}`))).capabilities).toEqual({
      'doc.read': true,
      'doc.comment': true,
      'doc.edit': false,
      'doc.manage': false,
    });
    await as(admin).patch(`/boards/${board.id}`, { permission_set: 'edit_everything' });

    // Duplicating the item copies its doc (a new doc, same content) into the copy's cell.
    await write(docId, docOf(p('spec text')), ids.bob!);
    const copy = await body(await as(bob).post(`/items/${item.id}/duplicate`, {}));
    const copied = copy.cells[col.id].value as Json;
    expect(copied.doc_id).not.toBe(docId);
    expect(copied.name).toBe('Website spec');
    expect((await body(await as(bob).get(`/docs/${copied.doc_id}/content`))).text).toBe('spec text');
    expect((await body(await as(bob).get(`/docs/${copied.doc_id}`))).cell.item_id).toBe(copy.id);

    // The item goes to trash: its doc is gone with it.
    await as(admin).del(`/items/${item.id}`);
    expect((await as(bob).get(`/docs/${docId}`)).status).toBe(404);
  });
});

describe('comments (ד3)', () => {
  it('threads on blocks: reply, mention, notify the thread, resolve / reopen; only the author edits', async () => {
    const doc = await newDoc(admin, { name: 'Review' });
    await write(doc.id, docOf(p('First block', 'b1'), p('Second block', 'b2')), ids.admin!);

    const created = await as(bob).post(`/docs/${doc.id}/comments`, {
      block_id: 'b1',
      quote: 'First block',
      body: comment(' please check', ids.admin),
    });
    expect(created.status).toBe(201);
    const thread = await body(created);
    expect(thread).toMatchObject({ block_id: 'b1', quote: 'First block', resolved_at: null });
    expect(thread.comments[0]).toMatchObject({ author: { id: ids.bob }, can_edit: true });
    expect(thread.comments[0].html).toContain('class="mention"');
    // The mentioned admin hears of it, with the thread.
    const adminN = (await notifications(admin)).find((n) => n.type === 'doc_mention' && n.doc?.id === doc.id);
    expect(adminN?.doc.thread_id).toBe(thread.id);

    // Admin replies: Bob (in the thread) hears "new comment".
    const replied = await body(
      await as(admin).post(`/doc-comment-threads/${thread.id}/comments`, { body: comment('done') }),
    );
    expect(replied.comments).toHaveLength(2);
    expect((await notifications(bob)).some((n) => n.type === 'doc_comment' && n.doc?.thread_id === thread.id)).toBe(
      true,
    );

    // Only the author edits; resolve and reopen.
    const mine = replied.comments[1].id;
    expect((await as(bob).patch(`/doc-comments/${mine}`, { body: comment('hack') })).status).toBe(403);
    expect(
      (await body(await as(admin).patch(`/doc-comments/${mine}`, { body: comment('done!') }))).comments[1].text,
    ).toBe('done!');
    const resolved = await body(await as(bob).post(`/doc-comment-threads/${thread.id}/resolve`, { resolved: true }));
    expect(resolved.resolved_by).toMatchObject({ id: ids.bob });
    expect((await body(await as(admin).get(`/docs/${doc.id}`))).open_threads).toBe(0);
    await as(bob).post(`/doc-comment-threads/${thread.id}/resolve`, { resolved: false });
    expect((await body(await as(admin).get(`/docs/${doc.id}`))).open_threads).toBe(1);
    // …and next to the doc in the sidebar.
    const entities = (await body(await as(bob).get(`/workspaces/${wsId}/tree`))).entities as Json[];
    expect(entities.find((e) => e.id === doc.id)?.open_threads).toBe(1);

    // Account viewers read the comments but do not write; an empty comment is refused.
    const list = await body(await as(vera).get(`/docs/${doc.id}/comments`));
    expect(list).toMatchObject({ can_comment: false });
    expect(list.data).toHaveLength(1);
    expect((await as(vera).post(`/docs/${doc.id}/comments`, { block_id: 'b2', body: comment('x') })).status).toBe(403);
    expect(
      (await as(bob).post(`/docs/${doc.id}/comments`, { block_id: 'b2', body: docOf({ type: 'paragraph' }) })).status,
    ).toBe(422);

    // Deleting every comment removes the thread.
    await as(bob).del(`/doc-comments/${thread.comments[0].id}`);
    const left = await body(await as(admin).del(`/doc-comments/${mine}`));
    expect(left.data).toHaveLength(0);
  });
});

describe('versions (ד3)', () => {
  it('named versions, preview, restore = a new version (history kept); automatic versions after edits', async () => {
    const doc = await newDoc(admin, { name: 'Contract' });
    await write(doc.id, docOf(p('Version one')), ids.admin!);
    const v1 = await body(await as(admin).post(`/docs/${doc.id}/versions`, { label: 'First draft' }));
    expect(v1).toMatchObject({ label: 'First draft', auto: false, text: 'Version one' });
    await write(doc.id, docOf(p('Version two')), ids.admin!);
    expect((await body(await as(admin).get(`/docs/${doc.id}/content`))).text).toBe('Version two');

    // Viewers preview, never restore or save.
    expect((await body(await as(vera).get(`/docs/${doc.id}/versions/${v1.id}`))).text).toBe('Version one');
    expect((await as(vera).post(`/docs/${doc.id}/versions/${v1.id}/restore`, {})).status).toBe(403);
    expect((await as(vera).post(`/docs/${doc.id}/versions`, { label: 'x' })).status).toBe(403);

    const before = (await body(await as(admin).get(`/docs/${doc.id}/versions`))).data as Json[];
    const restored = await body(await as(bob).post(`/docs/${doc.id}/versions/${v1.id}/restore`, {}));
    expect(restored).toMatchObject({ label: '↺ First draft', auto: false, text: 'Version one' });
    // The live doc has it (through the collab server), and the content API too.
    expect((await body(await as(admin).get(`/docs/${doc.id}/content`))).text).toBe('Version one');
    const after = (await body(await as(admin).get(`/docs/${doc.id}/versions`))).data as Json[];
    // What was there ("Version two") was kept as a version, plus the restore itself; nothing removed.
    expect(after.length).toBe(before.length + 2);
    expect(after.map((v) => v.id)).toEqual(expect.arrayContaining(before.map((v) => v.id)));
    const kept = after.find((v) => v.auto && !before.some((b) => b.id === v.id))!;
    expect((await body(await as(admin).get(`/docs/${doc.id}/versions/${kept.id}`))).text).toBe('Version two');

    // The last editor leaving takes an automatic version of the edits since the last one.
    const doc2 = await newDoc(bob, { name: 'Auto' });
    await write(doc2.id, docOf(p('typed')), ids.bob!);
    await new Promise((r) => setTimeout(r, 50));
    const autos = (await body(await as(bob).get(`/docs/${doc2.id}/versions`))).data as Json[];
    expect(autos.some((v) => v.auto)).toBe(true);
  });
});

describe('export (ד3)', () => {
  it('Markdown, HTML and the print page: the allowlist renderer, escaped, with app links', async () => {
    const doc = await newDoc(admin, { name: 'Export <me>' });
    await write(
      doc.id,
      docOf(
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '<script>alert(1)</script>', marks: [{ type: 'bold' }] }],
        },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('done')] }] },
        { type: 'paragraph', content: [{ type: 'entityLink', attrs: { kind: 'doc', id: doc.id, label: 'self' } }] },
      ),
      ids.admin!,
    );
    const md = await as(bob).get(`/docs/${doc.id}/export?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('content-disposition')).toContain('attachment');
    const mdText = await md.text();
    expect(mdText).toContain('# Title');
    expect(mdText).toContain('- [x] done');
    expect(mdText).toContain(`(http://localhost:5173/a/acme/d/${doc.id})`);

    const html = await as(bob).get(`/docs/${doc.id}/export?format=html`);
    const page = await html.text();
    expect(page).toContain('<h1 class="title">Export &lt;me&gt;</h1>');
    expect(page).toContain('<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>');
    expect(page).not.toContain('<script>');
    const pdf = await as(bob).get(`/docs/${doc.id}/export?format=pdf`);
    expect(pdf.headers.get('content-disposition')).toBe('inline');
    expect((await as(gus).get(`/docs/${doc.id}/export?format=md`)).status).toBe(404);
    // Same renderer as the shared one.
    expect(mdText).toBe(
      docToMarkdown(
        (await body(await as(bob).get(`/docs/${doc.id}/content`))).content,
        {
          entityUrl: (_k, id) => `http://localhost:5173/a/acme/d/${id}`,
        },
        'Export <me>',
      ),
    );
  });
});

describe('sharing with guests (ד3)', () => {
  it('invite by email: a guest joins a shareable doc and sees only it; never a private one', async () => {
    const shared = await newDoc(admin, { name: 'For the client', kind: 'shareable' });
    const secret = await newDoc(admin, { name: 'Internal', kind: 'private' });
    await newDoc(admin, { name: 'Main doc' });

    expect(
      (await as(admin).post(`/docs/${secret.id}/invite`, { emails: ['gus@guest.test'], role: 'guest' })).status,
    ).toBe(422);
    const res = await body(
      await as(admin).post(`/docs/${shared.id}/invite`, { emails: ['gus@guest.test'], role: 'guest', level: 'owner' }),
    );
    expect(res.added).toEqual([{ email: 'gus@guest.test', user_id: ids.gus }]);
    // A guest never owns: they edit at most.
    expect((await body(await as(gus).get(`/docs/${shared.id}`))).capabilities).toMatchObject({
      'doc.edit': true,
      'doc.manage': false,
    });
    const tree = await body(await as(gus).get(`/workspaces/${wsId}/tree`));
    expect((tree.entities as Json[]).map((e) => e.id)).toEqual([shared.id]);
    expect((await as(gus).get(`/docs/${secret.id}`)).status).toBe(404);
    expect((await as(gus).get(`/docs/${secret.id}/comments`)).status).toBe(404);

    // Someone new: an account invitation as a guest, joining the doc when accepted.
    const invite = await body(
      await as(admin).post(`/docs/${shared.id}/invite`, {
        emails: ['newguest@client.test'],
        role: 'guest',
        level: 'commenter',
      }),
    );
    expect(invite.invited).toEqual([{ email: 'newguest@client.test', url: expect.stringMatching(/\/invite\//) }]);
    const newGuest = await join('newguest@client.test');
    const seen = await body(await as(newGuest).get(`/docs/${shared.id}`));
    expect(seen.capabilities).toMatchObject({ 'doc.read': true, 'doc.comment': true, 'doc.edit': false });
    expect(
      ((await body(await as(newGuest).get(`/workspaces/${wsId}/tree`))).entities as Json[]).map((e) => e.id),
    ).toEqual([shared.id]);
  });
});

describe('images and files in a doc (ד2)', () => {
  it('whoever reads the doc may open its files; others may not', async () => {
    const pre = await body(await as(admin).post('/files/presign', { name: 'chart.png', size: 10, mime: 'image/png' }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 10, 'image/png');
    expect((await as(admin).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
    const doc = await newDoc(admin, { name: 'With an image', kind: 'private' });
    await as(admin).put(`/docs/${doc.id}/members`, {
      members: [
        { type: 'user', id: ids.admin, level: 'owner' },
        { type: 'user', id: ids.vera, level: 'viewer' },
      ],
    });
    // Not in a doc yet: only its uploader.
    expect((await as(vera).get(`/files/${pre.file_id}`)).status).toBe(404);
    await write(doc.id, docOf({ type: 'image', attrs: { asset_id: pre.file_id, alt: 'chart' } }), ids.admin!);
    expect((await as(vera).get(`/files/${pre.file_id}`)).status).toBe(200);
    expect((await as(bob).get(`/files/${pre.file_id}`)).status).toBe(404);
    // The export links it.
    expect(await (await as(vera).get(`/docs/${doc.id}/export?format=html`)).text()).toContain('<img src="');
  });
});

describe('live sidebar (ד2)', () => {
  it('the personal channel passes doc structure events (type only) to everyone in the account', async () => {
    const stream = meStream(t.db as unknown as Db, {
      ctx: { accountId: acmeId } as never,
      user: { id: ids.bob } as never,
    });
    const base = { id: 'E', account_id: acmeId } as const;
    for (const type of SIDEBAR_EVENTS) expect(await stream.accept({ ...base, type } as never)).toBe('send');
    expect(await stream.accept({ ...base, type: 'doc.edited' } as never)).toBe('skip');
    expect(await stream.accept({ ...base, type: 'notification.created', user_id: ids.admin } as never)).toBe('skip');
  });
});
