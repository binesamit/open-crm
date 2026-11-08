// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod 2026-10-10: a long text cell over ~2.7 KB failed on every save — "index row size 3792 exceeds btree version 4
 * maximum 2704 for index ix_cells_column_text" — so creating an item with such a text returned 500. The index now
 * holds the text's first 200 characters only.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let notesKey: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

/** ~10 KB of text that does not compress (a fixed pseudo-random mix of Hebrew letters, digits and spaces). */
const longText = (() => {
  const chars = 'אבגדהוזחטיכלמנסעפצקרשת0123456789 ';
  let seed = 7;
  let out = '';
  while (out.length < 7000) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += chars[seed % chars.length];
  }
  return out;
})();

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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Articles', workspace_id: wsId }))).id;
  notesKey = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'Body', type: 'long_text' }))).id;
});
afterAll(() => t.close());

describe('a long text cell (prod 2026-10-10)', () => {
  it('saves over the btree limit: creating the item with it, then writing it again', async () => {
    expect(Buffer.byteLength(longText)).toBeGreaterThan(10_000);
    const created = await as().post(`/boards/${boardId}/items`, {
      name: 'Shoulder',
      cells: { [notesKey]: { text: longText } },
    });
    expect(created.status).toBe(201);
    const itemId = (await body(created)).id as string;

    const put = await as().put(`/items/${itemId}/cells/${notesKey}`, { value: { text: `${longText} 2` } });
    expect(put.status).toBe(200);

    const item = await body(await as().get(`/items/${itemId}`));
    expect(item.cells[notesKey].value).toEqual({ text: `${longText} 2` });
  });
});
