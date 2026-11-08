// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** E7: item card — updates thread, mentions, likes, permissions, activity, isolation. */
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let acmeId: string;
let itemId: string;
let boardId: string;
let betaAdmin: string;
let betaId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

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
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  betaId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
    )
  ).account.id;
  betaAdmin = await join('admin@beta.test');

  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  const board = await body(await t.api(admin, acmeId).post('/boards', { name: 'פניות', workspace_id: ws }));
  boardId = board.id;
  itemId = (await body(await t.api(admin, acmeId).post(`/boards/${board.id}/items`, { name: 'פנייה 1' }))).id;
});
afterAll(() => t.close());

describe('updates', () => {
  let updateId: string;
  let bobId: string;

  it('posts an update with a mention; HTML is generated server-side and escaped', async () => {
    bobId = (await body(await t.api(bob, acmeId).get('/auth/me'))).user.id;
    const res = await t.api(admin, acmeId).post(`/items/${itemId}/updates`, {
      body: `<script>x</script> [@Bob](user:${bobId}) תבדוק`,
    });
    expect(res.status).toBe(200);
    const u = await body(res);
    updateId = u.id;
    expect(u.body_html).toContain('&lt;script&gt;');
    expect(u.body_html).toContain(`data-user-id="${bobId}"`);
    expect(u.mentions).toEqual([bobId]);
    expect(u.author.name).toBe('admin');
  });

  it('rejects mentions of people outside the account', async () => {
    const res = await t
      .api(admin, acmeId)
      .post(`/items/${itemId}/updates`, { body: '[@X](user:01J9Z0000000000000000000ZZ) hi' });
    expect(res.status).toBe(422);
  });

  it('threads replies under the update and counts likes', async () => {
    await t.api(bob, acmeId).post(`/updates/${updateId}/replies`, { body: 'בודק' });
    await t.api(bob, acmeId).post(`/updates/${updateId}/like`);
    const thread = await body(await t.api(admin, acmeId).get(`/items/${itemId}/updates`));
    expect(thread.data).toHaveLength(1);
    expect(thread.data[0].replies.map((r: Json) => r.body_text)).toEqual(['בודק']);
    expect(thread.data[0].likes).toEqual({ count: 1, me: false });
    const asBob = await body(await t.api(bob, acmeId).get(`/items/${itemId}/updates`));
    expect(asBob.data[0].likes.me).toBe(true);
  });

  it('replies to replies nest (thread order, parent ids), down to MAX_REPLY_DEPTH', async () => {
    const first = (await body(await t.api(admin, acmeId).get(`/items/${itemId}/updates`))).data[0].replies[0];
    let parent = first.id as string;
    const chain: string[] = [];
    for (const n of [2, 3, 4, 5, 6]) {
      const r = await body(await t.api(admin, acmeId).post(`/updates/${parent}/replies`, { body: `רמה ${n}` }));
      chain.push(r.id);
      parent = r.id;
    }
    const later = await body(await t.api(bob, acmeId).post(`/updates/${first.id}/replies`, { body: 'אחות' }));
    expect(later.parent_update_id).toBe(first.id);
    const replies = (await body(await t.api(admin, acmeId).get(`/items/${itemId}/updates`))).data[0].replies as Json[];
    // Depth first: the deep chain under the first reply, then its later sibling.
    expect(replies.map((r) => r.body_text)).toEqual(['בודק', 'רמה 2', 'רמה 3', 'רמה 4', 'רמה 5', 'רמה 6', 'אחות']);
    const parentOf = new Map(replies.map((r) => [r.id, r.parent_update_id]));
    expect(parentOf.get(chain[0]!)).toBe(first.id);
    expect(parentOf.get(chain[3]!)).toBe(chain[2]); // depth 5
    expect(parentOf.get(chain[4]!)).toBe(chain[2]); // a 6th level joins the 5th
  });

  it('only the author edits; author, owner or admin delete', async () => {
    expect((await t.api(bob, acmeId).patch(`/updates/${updateId}`, { body: 'hacked' })).status).toBe(403);
    const edited = await body(await t.api(admin, acmeId).patch(`/updates/${updateId}`, { body: 'עודכן' }));
    expect(edited).toMatchObject({ body_text: 'עודכן', mentions: [] });
    expect(edited.edited_at).not.toBeNull();
    const own = await body(await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'שלי' }));
    expect((await t.api(bob, acmeId).del(`/updates/${updateId}`)).status).toBe(403);
    expect((await t.api(bob, acmeId).del(`/updates/${own.id}`)).status).toBe(200);
    expect((await t.api(admin, acmeId).del(`/updates/${updateId}`)).status).toBe(200);
    expect((await body(await t.api(admin, acmeId).get(`/items/${itemId}/updates`))).data).toEqual([]);
  });

  it('account viewers read but cannot post unless allowed', async () => {
    expect((await t.api(vera, acmeId).get(`/items/${itemId}/updates`)).status).toBe(200);
    expect((await t.api(vera, acmeId).post(`/items/${itemId}/updates`, { body: 'x' })).status).toBe(403);
    await t.api(admin, acmeId).patch('/accounts/me', { settings: { permissions: { viewer_can_comment: true } } });
    expect((await t.api(vera, acmeId).post(`/items/${itemId}/updates`, { body: 'עכשיו מותר' })).status).toBe(200);
  });
});

describe('rich updates and reactions (M1.1 #7, #14)', () => {
  const doc = (...content: Json[]) => ({ type: 'doc', content });
  const p = (...content: Json[]) => ({ type: 'paragraph', content });

  it('renders a rich document through the allowlist and keeps it for editing', async () => {
    const bobId = (await body(await t.api(bob, acmeId).get('/auth/me'))).user.id;
    const d = doc(
      p(
        { type: 'text', text: 'חשוב', marks: [{ type: 'bold' }] },
        { type: 'mention', attrs: { id: bobId, label: 'Bob' } },
      ),
      p({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }),
    );
    const u = await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { doc: d }));
    expect(u.body_html).toBe(
      `<p><strong>חשוב</strong><span class="mention" data-user-id="${bobId}">@Bob</span></p><p>x</p>`,
    );
    expect(u.mentions).toEqual([bobId]);
    expect(u.body_json).toEqual(d);

    const edited = await body(
      await t.api(admin, acmeId).patch(`/updates/${u.id}`, { doc: doc(p({ type: 'text', text: 'עודכן' })) }),
    );
    expect(edited.body_html).toBe('<p>עודכן</p>');
    expect(edited.mentions).toEqual([]);
    expect(edited.edited_at).not.toBeNull();
  });

  it('rejects empty documents, both formats at once, and outside mentions', async () => {
    const api = t.api(admin, acmeId);
    expect((await api.post(`/items/${itemId}/updates`, { doc: doc(p()) })).status).toBe(400);
    expect(
      (await api.post(`/items/${itemId}/updates`, { body: 'a', doc: doc(p({ type: 'text', text: 'a' })) })).status,
    ).toBe(400);
    const outsider = '01J0000000000000000000000Z';
    const res = await api.post(`/items/${itemId}/updates`, {
      doc: doc(p({ type: 'mention', attrs: { id: outsider, label: 'x' } })),
    });
    expect(res.status).toBe(422);
  });

  it('several reactions per person, counted per reaction; 👍 still shows as likes', async () => {
    const u = await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { body: 'תגובות' }));
    await t.api(bob, acmeId).put(`/updates/${u.id}/reactions/heart`, {});
    await t.api(bob, acmeId).put(`/updates/${u.id}/reactions/party`, {});
    await t.api(admin, acmeId).put(`/updates/${u.id}/reactions/heart`, {});
    await t.api(admin, acmeId).put(`/updates/${u.id}/reactions/heart`, {}); // idempotent
    await t.api(bob, acmeId).post(`/updates/${u.id}/like`);
    expect((await t.api(bob, acmeId).put(`/updates/${u.id}/reactions/poop`, {})).status).toBe(400);

    const asBob = async () =>
      (await body(await t.api(bob, acmeId).get(`/items/${itemId}/updates`))).data.find((x: Json) => x.id === u.id);
    const r = await asBob();
    expect(r.reactions).toEqual([
      { reaction: 'like', count: 1, me: true },
      { reaction: 'heart', count: 2, me: true },
      { reaction: 'party', count: 1, me: true },
    ]);
    expect(r.likes).toEqual({ count: 1, me: true });

    await t.api(bob, acmeId).del(`/updates/${u.id}/reactions/heart`);
    expect((await asBob()).reactions[1]).toEqual({ reaction: 'heart', count: 1, me: false });
    expect((await t.api(betaAdmin, betaId).put(`/updates/${u.id}/reactions/heart`, {})).status).toBe(404);
  });
});

describe('item card data', () => {
  it('returns one item and its activity', async () => {
    const item = await body(await t.api(bob, acmeId).get(`/items/${itemId}`));
    expect(item.name).toBe('פנייה 1');
    const activity = await body(await t.api(admin, acmeId).get(`/items/${itemId}/activity`));
    const types = activity.data.map((e: Json) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['item.created', 'update.created', 'update.replied', 'update.deleted']),
    );
    expect(activity.data[0].actor).toBeTruthy();
  });

  it('is invisible across accounts', async () => {
    expect((await t.api(betaAdmin, betaId).get(`/items/${itemId}`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).get(`/items/${itemId}/updates`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).post(`/items/${itemId}/updates`, { body: 'x' })).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).get(`/items/${itemId}/activity`)).status).toBe(404);
  });
});

describe('update counts (N4)', () => {
  it('counts top-level updates per item, not replies; other accounts get 404', async () => {
    const top = await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { body: 'ספירה' }));
    await t.api(admin, acmeId).post(`/updates/${top.id}/replies`, { body: 'תגובה' });
    const res = await t.api(admin, acmeId).get(`/boards/${boardId}/update-counts`);
    expect(res.status).toBe(200);
    const { counts } = await body(res);
    const threads = (await body(await t.api(admin, acmeId).get(`/items/${itemId}/updates`))).data;
    expect(counts[itemId]).toBe(threads.length);
    expect((await t.api(betaAdmin, betaId).get(`/boards/${boardId}/update-counts`)).status).toBe(404);
  });
});

describe('files-only updates (Fix: )', () => {
  /** presign → "PUT" (the fake storage) → complete; returns the file id. */
  const upload = async (cookie: string, name: string) => {
    const api = t.api(cookie, acmeId);
    const pre = await body(await api.post('/files/presign', { name, size: 100, mime: 'application/pdf' }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 100, 'application/pdf');
    expect((await api.post(`/files/${pre.file_id}/complete`)).status).toBe(200);
    return pre.file_id as string;
  };
  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

  it('posts an update or a reply with only files (empty doc, empty body or no text at all)', async () => {
    const api = t.api(admin, acmeId);
    const f1 = await upload(admin, 'only.pdf');
    const res = await api.post(`/items/${itemId}/updates`, { doc: emptyDoc, file_ids: [f1] });
    expect(res.status).toBe(200);
    const u = await body(res);
    expect(u.body_html).toBe('');
    expect(u.body_text).toBe('');
    expect(u.body_json).toBeNull();
    expect(u.files.map((f: Json) => f.name)).toEqual(['only.pdf']);

    const f2 = await upload(admin, 'plain.pdf');
    expect((await api.post(`/items/${itemId}/updates`, { body: '', file_ids: [f2] })).status).toBe(200);
    const f3 = await upload(admin, 'bare.pdf');
    expect((await api.post(`/items/${itemId}/updates`, { file_ids: [f3] })).status).toBe(200);

    // A files-only reply to bob's update: bob hears it, the excerpt names the file.
    const bobs = await body(await t.api(bob, acmeId).post(`/items/${itemId}/updates`, { body: 'bob asks' }));
    const f4 = await upload(admin, 'answer.pdf');
    const reply = await api.post(`/updates/${bobs.id}/replies`, { doc: emptyDoc, file_ids: [f4] });
    expect(reply.status).toBe(200);
    expect((await body(reply)).files).toHaveLength(1);
    const inbox = await body(await t.api(bob, acmeId).get('/me/notifications'));
    const n = inbox.data.find((x: Json) => x.type === 'reply' && x.update_id === (bobs.id as string)) ?? inbox.data[0];
    expect(n.excerpt).toBe('📎 answer.pdf');

    // The thread lists it; deleting it puts a named entry in the trash.
    const threads = (await body(await api.get(`/items/${itemId}/updates`))).data;
    expect(threads.some((x: Json) => x.id === u.id && x.body_html === '')).toBe(true);
    expect((await api.del(`/updates/${u.id}`)).status).toBe(200);
    const trash = await body(await api.get('/trash'));
    expect(JSON.stringify(trash)).toContain('📎 only.pdf');
  });

  it('refuses an update or reply with neither text nor files', async () => {
    const api = t.api(admin, acmeId);
    expect((await api.post(`/items/${itemId}/updates`, { doc: emptyDoc })).status).toBe(400);
    expect((await api.post(`/items/${itemId}/updates`, { doc: emptyDoc, file_ids: [] })).status).toBe(400);
    expect((await api.post(`/items/${itemId}/updates`, { body: '   ' })).status).toBe(400);
    expect((await api.post(`/items/${itemId}/updates`, {})).status).toBe(400);
    const top = await body(await api.post(`/items/${itemId}/updates`, { body: 'top' }));
    expect((await api.post(`/updates/${top.id}/replies`, { doc: emptyDoc })).status).toBe(400);
    // Editing a text-only update down to nothing is refused too.
    expect((await api.patch(`/updates/${top.id}`, { doc: emptyDoc })).status).toBe(400);
  });
});

describe('line breaks (Fix: )', () => {
  it('keeps paragraphs, <br> and blank lines — typed, plain text, and stored without markup', async () => {
    const d = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'א' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'ב' }, { type: 'hardBreak' }, { type: 'text', text: 'ג' }],
        },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'ד' }] },
      ],
    };
    const rich = await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { doc: d }));
    expect(rich.body_html).toBe('<p>א</p><p>ב<br>ג</p><p></p><p>ד</p>');
    const plain = await body(
      await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { body: 'שורה\nשנייה\n\nפסקה' }),
    );
    expect(plain.body_html).toBe('שורה<br>שנייה<br><br>פסקה');
    // A row written elsewhere with raw newlines (an older import): the breaks show at read time.
    await t.db.execute(
      sql`update updates set body_html = ${'ישן\nחדש'}, body_text = ${'ישן\nחדש'} where id = ${plain.id}`,
    );
    const thread = await body(await t.api(admin, acmeId).get(`/items/${itemId}/updates`));
    expect(thread.data.find((u: Json) => u.id === plain.id).body_html).toBe('ישן<br>חדש');
  });
});

describe('check boxes in an update', () => {
  const task = (checked: boolean, text: string) => ({
    type: 'taskItem',
    attrs: { checked },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  const tasks = { type: 'doc', content: [{ type: 'taskList', content: [task(false, 'אחד'), task(false, 'שתיים')] }] };
  const boxes = (u: Json) => (u.body_json.content[0].content as Json[]).map((x) => x.attrs.checked);

  it('anyone who may comment ticks a box; only that box changes and the update is not marked edited', async () => {
    const u = await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { doc: tasks }));
    const res = await t.api(bob, acmeId).put(`/updates/${u.id}/tasks/1`, { checked: true });
    expect(res.status).toBe(200);
    const after = await body(res);
    expect(boxes(after)).toEqual([false, true]);
    expect(after.body_text).toBe(u.body_text);
    expect(after.edited_at).toBeNull();
    expect(after.body_html).not.toBe(u.body_html);
    // The author clears it again.
    expect(boxes(await body(await t.api(admin, acmeId).put(`/updates/${u.id}/tasks/1`, { checked: false })))).toEqual([
      false,
      false,
    ]);
    // Editing the text stays the author's.
    expect((await t.api(bob, acmeId).patch(`/updates/${u.id}`, { body: 'שלי' })).status).toBe(403);
  });

  it('a viewer ticks only when viewers may comment; a missing box is 404; another account cannot', async () => {
    const u = await body(await t.api(admin, acmeId).post(`/items/${itemId}/updates`, { doc: tasks }));
    await t.api(admin, acmeId).patch('/accounts/me', { settings: { permissions: { viewer_can_comment: false } } });
    expect((await t.api(vera, acmeId).put(`/updates/${u.id}/tasks/0`, { checked: true })).status).toBe(403);
    await t.api(admin, acmeId).patch('/accounts/me', { settings: { permissions: { viewer_can_comment: true } } });
    expect((await t.api(vera, acmeId).put(`/updates/${u.id}/tasks/0`, { checked: true })).status).toBe(200);
    expect((await t.api(bob, acmeId).put(`/updates/${u.id}/tasks/5`, { checked: true })).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).put(`/updates/${u.id}/tasks/0`, { checked: true })).status).toBe(404);
  });
});
