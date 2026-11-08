// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, firstAdminLink } from '../src/db/bootstrap';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Self-hosting without email (open-source ק3): `node dist/first-admin-link.js` gives the platform owner a link to set
 * a password and join the first account — the only way in when no mail transport is configured.
 */
let t: TestContext;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());

describe('firstAdminLink', () => {
  it('no account yet: nothing to link to', async () => {
    expect(await firstAdminLink(t.db, { ownerEmail: OWNER_EMAIL, origin: WEB_ORIGIN })).toEqual({
      status: 'no_account',
    });
  });

  it('after the seed: a working /invite link; the owner signs up with a password and joins as admin', async () => {
    await bootstrap(t.db, {
      ownerEmail: OWNER_EMAIL,
      templatesDir: '../../seed/templates',
      firstAccount: { name: 'Main', slug: 'main', templateSet: 'empty' },
    });
    const first = await firstAdminLink(t.db, { ownerEmail: OWNER_EMAIL.toUpperCase(), origin: `${WEB_ORIGIN}/` });
    expect(first).toMatchObject({ status: 'link', accountSlug: 'main' });
    const second = await firstAdminLink(t.db, { ownerEmail: OWNER_EMAIL, origin: WEB_ORIGIN });
    if (first.status !== 'link' || second.status !== 'link') throw new Error('expected links');
    expect(second.url.startsWith(`${WEB_ORIGIN}/invite/`)).toBe(true);
    const oldToken = first.url.split('/invite/')[1]!;
    const token = second.url.split('/invite/')[1]!;

    // A new link replaces the previous one.
    expect((await t.signUpWithPassword(OWNER_EMAIL, oldToken)).status).toBe(403);
    const res = await t.signUpWithPassword(OWNER_EMAIL, token);
    expect(res.status).toBe(200);
    const cookie = t.cookieFrom(res)!;
    expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);

    // Now a member: no more links.
    expect(await firstAdminLink(t.db, { ownerEmail: OWNER_EMAIL, origin: WEB_ORIGIN })).toEqual({
      status: 'member',
      accountSlug: 'main',
    });
  });

  it('someone else: no open invitation', async () => {
    expect(await firstAdminLink(t.db, { ownerEmail: 'stranger@example.org', origin: WEB_ORIGIN })).toEqual({
      status: 'no_invitation',
    });
  });
});
