// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_RICH_TEXT } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Prod bug "adding a reply to an update — broke": the reporter pasted a few Hebrew lines, two console errors and a
 * ~10 KB GlitchTip event JSON into a reply; it was refused. The fixture is exactly what was pasted.
 */
const PASTED = readFileSync(new URL('../../../e2e/fixtures/r17-failed-update.txt', import.meta.url), 'utf8');

let t: TestContext;
let admin: string;
let acmeId: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

/** What the editor makes of a plain-text paste: one paragraph per line (ProseMirror's clipboard text parser). */
const pastedAsParagraphs = (text: string) => ({
  type: 'doc',
  content: text.split(/(?:\r\n?|\n)+/).map((l) => ({
    type: 'paragraph',
    attrs: { dir: 'auto' },
    ...(l ? { content: [{ type: 'text', text: l }] } : {}),
  })),
});
/** …and of a paste inside a code block (or an HTML paste of a <pre>): one text node. */
const pastedAsCode = (text: string) => ({
  type: 'doc',
  content: [{ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text }] }],
});

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
  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  const board = await body(await t.api(admin, acmeId).post('/boards', { name: 'תיקונים', workspace_id: ws }));
  itemId = (await body(await t.api(admin, acmeId).post(`/boards/${board.id}/items`, { name: 'פריט' }))).id;
});
afterAll(() => t.close());

describe('r17reply: a pasted log in an update / reply', () => {
  let updateId: string;

  it.each([
    ['plain text body', () => ({ body: PASTED })],
    ['editor doc (paragraph per line)', () => ({ doc: pastedAsParagraphs(PASTED) })],
    ['editor doc (code block)', () => ({ doc: pastedAsCode(PASTED) })],
  ])('posts a top-level update as %s', async (_name, payload) => {
    const res = await t.api(admin, acmeId).post(`/items/${itemId}/updates`, payload());
    const u = await body(res);
    expect(res.status, JSON.stringify(u).slice(0, 500)).toBe(200);
    expect(u.body_text).toContain('"event_id": "0123456789abcdef0123456789abcdef"');
    expect(u.body_text).toContain('() =\\u003E dispatch(i + 1)');
    updateId = u.id;
  });

  it.each([
    ['plain text body', () => ({ body: PASTED })],
    ['editor doc (paragraph per line)', () => ({ doc: pastedAsParagraphs(PASTED), file_ids: [] })],
    ['editor doc (code block)', () => ({ doc: pastedAsCode(PASTED), file_ids: [] })],
  ])('replies with it as %s', async (_name, payload) => {
    const res = await t.api(admin, acmeId).post(`/updates/${updateId}/replies`, payload());
    const r = await body(res);
    expect(res.status, JSON.stringify(r).slice(0, 500)).toBe(200);
    expect(r.parent_update_id).toBe(updateId);
    expect(r.body_text).toContain('זה מהגליץ');
  });

  it('edits an update to it', async () => {
    const res = await t.api(admin, acmeId).patch(`/updates/${updateId}`, { doc: pastedAsParagraphs(PASTED) });
    expect(res.status).toBe(200);
  });

  // Refused before r17reply (400 "Request validation failed"): 20,000 characters per text node and per body,
  // 200 KB of editor JSON. A pasted 50 KB log must go through.
  const LOG_50K = Array.from({ length: 5 }, () => PASTED).join('\n');
  it.each([
    ['plain text body', () => ({ body: LOG_50K })],
    ['editor doc (paragraph per line)', () => ({ doc: pastedAsParagraphs(LOG_50K), file_ids: [] })],
    ['editor doc (code block)', () => ({ doc: pastedAsCode(LOG_50K), file_ids: [] })],
  ])('a 50 KB log as %s is accepted as a reply and an edit', async (_name, payload) => {
    expect(LOG_50K.length).toBeGreaterThan(50_000);
    const res = await t.api(admin, acmeId).post(`/updates/${updateId}/replies`, payload());
    const r = await body(res);
    expect(res.status, JSON.stringify(r).slice(0, 300)).toBe(200);
    expect(r.body_text.length).toBeGreaterThan(50_000);
    const { file_ids: _f, ...edit } = payload() as { file_ids?: string[] };
    expect((await t.api(admin, acmeId).patch(`/updates/${updateId}`, edit)).status).toBe(200);
  });

  it('text past the limit is refused with a clear code and the limit (not a bare validation error)', async () => {
    const huge = 'שורה של לוג\n'.repeat(Math.ceil((MAX_RICH_TEXT + 10) / 12));
    for (const payload of [{ body: huge }, { doc: pastedAsCode(huge) }]) {
      const res = await t.api(admin, acmeId).post(`/updates/${updateId}/replies`, payload);
      expect(res.status).toBe(413);
      const err = (await body(res)).error;
      expect(err.code).toBe('payload_too_large');
      expect(err.message).toBe('update_too_long');
      expect(err.details.limit).toBe(MAX_RICH_TEXT);
    }
  });
});
