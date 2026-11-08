// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Owner guides: the platform owner's private Markdown pages, kept in the database — created, edited
 * reordered and deleted in the owner console (or through the API), and invisible to anyone else (404, like the rest
 * of the console).
 */
let t: TestContext;
let owner: string;
let admin: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  await t.api(owner).post('/platform/accounts', {
    name: 'Acme',
    slug: 'acme',
    first_admin_email: 'admin@acme.test',
    template_set: 'empty',
  });
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  expect((await t.api(admin).post('/invitations/accept', { token })).status).toBe(200);
});
afterAll(() => t.close());

describe('owner guides', () => {
  it('creates, reads, edits, reorders and deletes guides', async () => {
    expect(await body(await t.api(owner).get('/platform/guides'))).toEqual({ data: [] });

    const md = '# Runbook\n\n## 1. Issue a key\n\nRun `issue` with the **installation id**.\n';
    const a = await body(await t.api(owner).post('/platform/guides', { title: { en: 'Runbook' }, body: { en: md } }));
    expect(a.title).toEqual({ he: '', en: 'Runbook' });
    expect(a.body).toEqual({ he: '', en: md });
    const b = await body(await t.api(owner).post('/platform/guides', { title: { he: 'נהלים' } }));
    expect(b.body).toEqual({ he: '', en: '' });
    expect(b.sort_order).toBeGreaterThan(a.sort_order);

    const edited = await body(
      await t.api(owner).patch(`/platform/guides/${b.id}`, { title: { en: 'Procedures' }, body: { he: '## שלב' } }),
    );
    expect(edited.title).toEqual({ he: 'נהלים', en: 'Procedures' });
    expect(edited.body).toEqual({ he: '## שלב', en: '' });
    expect((await body(await t.api(owner).get(`/platform/guides/${a.id}`))).body.en).toBe(md);

    const reordered = await body(await t.api(owner).put('/platform/guides/order', { ids: [b.id, a.id] }));
    expect(reordered.data.map((g: Json) => g.id)).toEqual([b.id, a.id]);
    expect((await body(await t.api(owner).get('/platform/guides'))).data.map((g: Json) => g.id)).toEqual([b.id, a.id]);

    expect((await t.api(owner).del(`/platform/guides/${b.id}`)).status).toBe(200);
    expect((await body(await t.api(owner).get('/platform/guides'))).data.map((g: Json) => g.id)).toEqual([a.id]);
    expect((await t.api(owner).get(`/platform/guides/${b.id}`)).status).toBe(404);
    expect((await t.api(owner).patch(`/platform/guides/${b.id}`, { title: { en: 'x' } })).status).toBe(404);
    expect((await t.api(owner).del(`/platform/guides/${a.id}`)).status).toBe(200);
  });

  it('validates: a title in some language, a full and exact order', async () => {
    expect((await t.api(owner).post('/platform/guides', { title: {} })).status).toBe(400);
    expect((await t.api(owner).post('/platform/guides', { title: { he: '  ', en: '' } })).status).toBe(400);
    const g = await body(await t.api(owner).post('/platform/guides', { title: { he: 'א' } }));
    expect((await t.api(owner).patch(`/platform/guides/${g.id}`, { title: { he: '' } })).status).toBe(400);
    expect((await t.api(owner).put('/platform/guides/order', { ids: [g.id, g.id] })).status).toBe(400);
    expect((await t.api(owner).put('/platform/guides/order', { ids: ['01ZZZZZZZZZZZZZZZZZZZZZZZZ'] })).status).toBe(
      400,
    );
    await t.api(owner).del(`/platform/guides/${g.id}`);
  });

  it('is the platform owner’s only (404 to others, 401 without a session)', async () => {
    const g = await body(await t.api(owner).post('/platform/guides', { title: { en: 'Private' } }));
    expect((await t.api(admin).get('/platform/guides')).status).toBe(404);
    expect((await t.api(admin).get(`/platform/guides/${g.id}`)).status).toBe(404);
    expect((await t.api(admin).post('/platform/guides', { title: { en: 'x' } })).status).toBe(404);
    expect((await t.api(admin).patch(`/platform/guides/${g.id}`, { title: { en: 'x' } })).status).toBe(404);
    expect((await t.api(admin).put('/platform/guides/order', { ids: [g.id] })).status).toBe(404);
    expect((await t.api(admin).del(`/platform/guides/${g.id}`)).status).toBe(404);
    expect((await t.api('').get('/platform/guides')).status).toBe(401);
    // Nothing changed.
    expect((await body(await t.api(owner).get(`/platform/guides/${g.id}`))).title.en).toBe('Private');
  });

  it('is not in the public API reference', async () => {
    const doc = await body(await t.app.request('/api/docs/openapi.json'));
    expect(Object.keys(doc.paths).some((p) => p.includes('/platform/guides') || p.includes('/guides/'))).toBe(false);
  });
});
