// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * a NEW numbers column shows a thousands separator. The account's default for new columns
 * (`settings.defaults.number_thousands`, on unless an admin turns it off) is written on the column when it is made;
 * columns made before keep their settings (unset = no separator), and settings sent with the column win.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

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
  ).account.id as string;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: wsId }))).id;
});
afterAll(() => t.close());

const column = async (input: Json) => {
  const res = await as(admin).post(`/boards/${boardId}/columns`, { type: 'numbers', ...input });
  expect(res.status).toBe(201);
  return body(res);
};
const settingsOf = async (key: string) =>
  (await body(await as(admin).get(`/boards/${boardId}`))).columns.find((c: Json) => c.id === key).settings as Json;

describe('thousands separator on new numbers columns', () => {
  it('is on by default: the account default reads true and a new column writes it', async () => {
    expect((await body(await as(admin).get('/accounts/me'))).settings.defaults.number_thousands).toBe(true);
    const col = await column({ id: 'amount', title: 'Amount' });
    expect(col.settings).toEqual({ footer: 'sum', thousands: true });

    const item = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Deal' }))).id;
    expect((await as(admin).put(`/items/${item}/cells/amount`, { value: 1234567 })).status).toBe(200);
    const read = await body(await as(admin).get(`/items/${item}`));
    expect(JSON.stringify(read)).toContain('1,234,567');
  });

  it('settings sent with the column win (a copy keeps its look: no key, no separator)', async () => {
    const copy = await column({ id: 'copy', title: 'Copy', settings: { footer: 'avg' } });
    expect(copy.settings).toEqual({ footer: 'avg' });
    const off = await column({ id: 'off', title: 'Off', settings: { thousands: false } });
    expect(off.settings.thousands).toBe(false);
  });

  it('an admin turns the default off: later columns start without it, earlier ones stay as they are', async () => {
    const res = await as(admin).patch('/accounts/me', { settings: { defaults: { number_thousands: false } } });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.defaults.number_thousands).toBe(false);
    const later = await column({ id: 'later', title: 'Later' });
    expect(later.settings).toEqual({ footer: 'sum', thousands: false });
    expect((await settingsOf('amount')).thousands).toBe(true);
    expect((await settingsOf('copy')).thousands).toBeUndefined();
    await as(admin).patch('/accounts/me', { settings: { defaults: { number_thousands: true } } });
    expect((await column({ id: 'again', title: 'Again' })).settings.thousands).toBe(true);
  });

  it('other column types are untouched', async () => {
    const text = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Note', type: 'text' }));
    expect(text.settings).toEqual({});
  });
});
