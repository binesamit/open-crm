// SPDX-License-Identifier: AGPL-3.0-only
import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, firstAccountFromEnv } from '../src/db/bootstrap';
import { accountInvitations, accounts } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** The deploy-time seed (ANSWERS §6 א.1): the first account is created once, ever — never again after a rename. */
let t: TestContext;
const run = () =>
  bootstrap(t.db, {
    ownerEmail: OWNER_EMAIL,
    templatesDir: '../../seed/templates',
    firstAccount: { name: 'First', slug: 'first', templateSet: 'empty' },
  });

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());

describe('bootstrap seed', () => {
  it('first boot: creates the first account and invites the platform owner, once', async () => {
    const res = await run();
    expect(res).toMatchObject({ createdAccount: true, invitedOwner: true });
    expect(res.account?.slug).toBe('first');
    const again = await run();
    expect(again).toMatchObject({ createdAccount: false, invitedOwner: false });
    expect(again.account?.id).toBe(res.account?.id);
    expect(await t.db.select().from(accounts)).toHaveLength(1);
  });

  it('after the first account is renamed (slug and name), a deploy does not create another', async () => {
    const [first] = await t.db.select().from(accounts);
    await t.db.update(accounts).set({ slug: 'renamed', name: 'Renamed' }).where(eq(accounts.id, first!.id));
    const res = await run();
    expect(res.createdAccount).toBe(false);
    expect(res.account?.id).toBe(first!.id);
    expect(await t.db.select().from(accounts)).toHaveLength(1);
    // still exactly one pending owner invitation
    const invites = await t.db.select().from(accountInvitations).where(eq(accountInvitations.accountId, first!.id));
    expect(invites.filter((i) => i.email === OWNER_EMAIL && !i.revokedAt && !i.acceptedAt)).toHaveLength(1);
  });

  it('with every account deleted nothing is re-created', async () => {
    await t.db.update(accounts).set({ deletedAt: new Date() });
    const res = await run();
    expect(res).toMatchObject({ createdAccount: false, account: null, invitedOwner: false });
    expect(await t.db.select().from(accounts).where(isNull(accounts.deletedAt))).toHaveLength(0);
  });

  it('first account settings come from the environment, generic by default', () => {
    expect(firstAccountFromEnv({})).toEqual({ name: 'Main', slug: 'main', templateSet: 'default' });
    expect(
      firstAccountFromEnv({ SEED_ACCOUNT_NAME: 'Studio', SEED_ACCOUNT_SLUG: 'Studio', SEED_TEMPLATE_SET: 'empty' }),
    ).toEqual({ name: 'Studio', slug: 'studio', templateSet: 'empty' });
    expect(() => firstAccountFromEnv({ SEED_TEMPLATE_SET: 'No Such Kit!' })).toThrow();
  });
});
