// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * PRJ-015, 2026-10-29:
 *: two columns of a board never share a title — a taken one gets the next free number
 *: a timer column filters by "running" / "stopped"
 *: an image put into an update's text (`asset:<file id>`) is kept, also when it is all the text.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Oct 29', workspace_id: ws }))).id;
});
afterAll(() => t.close());

describe('unique column titles', () => {
  const add = async (title: string, type = 'text') =>
    (await body(await as().post(`/boards/${boardId}/columns`, { title, type }))).title as string;

  it('numbers a taken title on create, counting on from a numbered one', async () => {
    expect(await add('הערות')).toBe('הערות');
    expect(await add('הערות')).toBe('הערות 2');
    expect(await add(' הערות ')).toBe('הערות 3');
    expect(await add('הערות 2')).toBe('הערות 4');
    expect(await add('Notes')).toBe('Notes');
    expect(await add('notes')).toBe('notes 2');
  });

  it('numbers a rename to a taken title, and a column keeps its own title', async () => {
    const col = await body(await as().post(`/boards/${boardId}/columns`, { title: 'שלב', type: 'text' }));
    const other = await body(await as().post(`/boards/${boardId}/columns`, { title: 'אחר', type: 'text' }));
    const renamed = await body(await as().patch(`/boards/${boardId}/columns/${other.id}`, { title: 'שלב' }));
    expect(renamed.title).toBe('שלב 2');
    const same = await body(await as().patch(`/boards/${boardId}/columns/${col.id}`, { title: 'שלב' }));
    expect(same.title).toBe('שלב');
  });
});

describe('timer filter: running / stopped', () => {
  it('finds the items whose timer runs now, and the others', async () => {
    await as().post(`/boards/${boardId}/columns`, { id: 'timer', title: 'טיימר', type: 'time_tracking' });
    const item = async (name: string) => (await body(await as().post(`/boards/${boardId}/items`, { name }))).id;
    const on = await item('רץ');
    const off = await item('עצר');
    await item('לא התחיל');
    expect((await as().post(`/items/${on}/time/start`, { column_id: 'timer' })).status).toBeLessThan(300);
    await as().post(`/items/${off}/time/start`, { column_id: 'timer' });
    await as().post(`/items/${off}/time/stop`, { column_id: 'timer' });

    const names = async (operator: string) =>
      (
        (
          await body(
            await as().post(`/boards/${boardId}/items/query`, {
              filter: { kind: 'group', operator: 'and', rules: [{ kind: 'rule', column_id: 'timer', operator }] },
            }),
          )
        ).data as Json[]
      )
        .map((i) => i.name)
        .sort();
    expect(await names('is_running')).toEqual(['רץ']);
    expect(await names('is_not_running')).toEqual(['לא התחיל', 'עצר']);
  });

  it('refuses the operators on another column type', async () => {
    const res = await as().post(`/boards/${boardId}/items/query`, {
      filter: { kind: 'group', operator: 'and', rules: [{ kind: 'rule', column_id: 'name', operator: 'is_running' }] },
    });
    expect(res.status).toBe(422);
  });
});

describe('an image in the text of an update', () => {
  const upload = async (name: string) => {
    const pre = await body(await as().post('/files/presign', { name, size: 100, mime: 'image/png' }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 100, 'image/png');
    expect((await as().post(`/files/${pre.file_id}/complete`)).status).toBe(200);
    return pre.file_id as string;
  };
  const image = (id: string) => ({ type: 'image', attrs: { src: `asset:${id}`, alt: 'shot.png' } });
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

  it('keeps the image where it was put, between the lines', async () => {
    const itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'images' }))).id;
    const f = await upload('shot.png');
    const doc = { type: 'doc', content: [para('לפני'), image(f), para('אחרי')] };
    const u = await body(await as().post(`/items/${itemId}/updates`, { doc, file_ids: [f] }));
    expect(u.body_html).toMatch(/<p>לפני<\/p><figure class="rich-image"><img [^>]*data-image-ref="asset:/);
    expect(u.body_html).toMatch(/<\/figure><p>אחרי<\/p>$/);
    expect(u.files.map((x: Json) => x.id)).toEqual([f]);
    // It loads through the update (the file's short link).
    const res = await as().get(`/updates/${u.id}/email-images/asset:${f}?account_id=${acmeId}`);
    expect([302, 307]).toContain(res.status);
  });

  it('an update of only an image keeps it in the text', async () => {
    const itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'only image' }))).id;
    const f = await upload('only.png');
    const u = await body(
      await as().post(`/items/${itemId}/updates`, { doc: { type: 'doc', content: [image(f)] }, file_ids: [f] }),
    );
    expect(u.body_html).toContain(`data-image-ref="asset:${f}"`);
    expect(u.body_text).toBe('');
  });

  it('an image of another update does not load through this one', async () => {
    const itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'foreign' }))).id;
    const mine = await upload('mine.png');
    const theirs = await upload('theirs.png');
    await as().post(`/items/${itemId}/updates`, { body: 'x', file_ids: [theirs] });
    const u = await body(
      await as().post(`/items/${itemId}/updates`, {
        doc: { type: 'doc', content: [para('a'), image(theirs)] },
        file_ids: [mine],
      }),
    );
    const res = await as().get(`/updates/${u.id}/email-images/asset:${theirs}?account_id=${acmeId}`);
    expect(res.status).toBe(404);
  });
});
