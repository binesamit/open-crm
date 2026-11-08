// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { auditLog, notifications } from '../src/db/schema';
import { purgeByRetention } from '../src/modules/platform/retention';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Privacy, phase A: log retention set in the owner console (a daily job deletes what is older), the
 * data protection officer on the legal pages, and the public sub-processors list.
 */
let t: TestContext;
let owner: string;
let acmeId: string;
let adminId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const anon = () => t.api('');
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  const admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
});
afterAll(() => t.close());

describe('log retention', () => {
  it('defaults: the audit log 730 days (24 months), the rest kept', async () => {
    const s = await body(await t.api(owner).get('/platform/settings'));
    expect(s.settings.retention).toEqual({ audit_days: 730, activity_days: null, notifications_days: null });
  });

  it('the owner sets the periods; out-of-range values are refused; others cannot', async () => {
    expect((await t.api(owner).patch('/platform/settings', { retention: { audit_days: 10 } })).status).toBe(400);
    const ok = await t.api(owner).patch('/platform/settings', { retention: { notifications_days: 90 } });
    expect(ok.status).toBe(200);
    expect((await body(ok)).settings.retention).toEqual({
      audit_days: 730,
      activity_days: null,
      notifications_days: 90,
    });
  });

  it('the daily job deletes only what is older than the period, and keeps a log set to "keep"', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const oldAudit = newId();
    const newAudit = newId();
    await t.db.insert(auditLog).values([
      {
        id: oldAudit,
        accountId: acmeId,
        actorId: adminId,
        action: 'test.old',
        createdAt: new Date(now.getTime() - 800 * DAY),
      },
      {
        id: newAudit,
        accountId: acmeId,
        actorId: adminId,
        action: 'test.new',
        createdAt: new Date(now.getTime() - 10 * DAY),
      },
    ]);
    const oldBell = newId();
    const newBell = newId();
    await t.db.insert(notifications).values([
      {
        id: oldBell,
        accountId: acmeId,
        userId: adminId,
        type: 'mention',
        createdAt: new Date(now.getTime() - 100 * DAY),
      },
      {
        id: newBell,
        accountId: acmeId,
        userId: adminId,
        type: 'mention',
        createdAt: new Date(now.getTime() - 5 * DAY),
      },
    ]);
    const res = await purgeByRetention(t.db, now);
    expect(res.audit).toBeGreaterThanOrEqual(1);
    expect(res.notifications).toBeGreaterThanOrEqual(1);
    expect(res.activity).toBe(0); // "keep"
    expect(await t.db.select().from(auditLog).where(eq(auditLog.id, oldAudit))).toEqual([]);
    expect(await t.db.select().from(auditLog).where(eq(auditLog.id, newAudit))).toHaveLength(1);
    expect(await t.db.select().from(notifications).where(eq(notifications.id, oldBell))).toEqual([]);
    expect(await t.db.select().from(notifications).where(eq(notifications.id, newBell))).toHaveLength(1);
  });
});

describe('DPO and sub-processors on the legal pages', () => {
  it('no DPO named: no marker in the policy, none in the list', async () => {
    const list = await body(await anon().get('/legal'));
    expect(list.dpo).toBeNull();
    expect(list.sub_processors).toBe(false);
    expect((await body(await anon().get('/legal/sub-processors'))).data).toEqual([]);
  });

  it('the owner names a DPO and publishes sub-processors; the public reads both', async () => {
    const res = await t.api(owner).patch('/platform/settings', {
      legal: {
        dpo_name: 'Dana Privacy',
        dpo_email: 'dpo@example.test',
        sub_processors: [
          {
            name: 'Railway',
            purpose: { he: 'אירוח ומסד נתונים', en: 'Hosting and database' },
            location: 'EU',
            dpa_url: 'https://railway.example/dpa',
          },
          { name: 'Resend', purpose: { he: 'מיילים', en: 'Email' }, location: 'USA' },
        ],
      },
    });
    expect(res.status).toBe(200);
    const list = await body(await anon().get('/legal'));
    expect(list.dpo).toEqual({ name: 'Dana Privacy', email: 'dpo@example.test' });
    expect(list.sub_processors).toBe(true);
    const subs = (await body(await anon().get('/legal/sub-processors'))).data as Json[];
    expect(subs.map((s) => s.name)).toEqual(['Railway', 'Resend']);
    expect(subs[0]).toMatchObject({ location: 'EU', dpa_url: 'https://railway.example/dpa' });
    // A bad row (no name) is refused as a whole.
    expect(
      (
        await t.api(owner).patch('/platform/settings', {
          legal: { sub_processors: [{ name: '', purpose: { he: 'x', en: 'x' }, location: 'x' }] },
        })
      ).status,
    ).toBe(400);
    // Cleared: the page is not offered.
    await t.api(owner).patch('/platform/settings', { legal: { sub_processors: [], dpo_name: null, dpo_email: null } });
    expect((await body(await anon().get('/legal'))).sub_processors).toBe(false);
  });
});

describe('privacy notice at collection (Israel Privacy Law §11)', () => {
  it('the owner sets a sign-up notice per language; the legal list carries it', async () => {
    expect((await body(await anon().get('/legal'))).collection_notice).toEqual({ he: null, en: null });
    await t.api(owner).patch('/platform/settings', {
      legal: { collection_notice: { he: 'הפרטים נאספים לצורך פתיחת החשבון.', en: '' } },
    });
    expect((await body(await anon().get('/legal'))).collection_notice).toEqual({
      he: 'הפרטים נאספים לצורך פתיחת החשבון.',
      en: null,
    });
  });
});
