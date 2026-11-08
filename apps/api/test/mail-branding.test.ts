// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_ACCENT, MAIL_TEMPLATE_KEYS, newId, t as i18n, type MessageKey } from '@bines/shared';
import { activityLog, automations, users } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * M11 stage 2 — branded emails per account: the accent colour setting (account, else owner, else the platform's
 * colour), the admin's email preview (any template, he/en, sample data) and test send (own address only,
 * rate-limited by the owner's setting, MAIL_ALLOWLIST honoured), and automation emails in the recipient's language.
 */
let t: TestContext;
let owner: string;
let admin: string;
let adminId: string;
let bob: string;
let bobId: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const tr = (key: string, vars?: Record<string, string | number>, locale: 'he' | 'en' = 'he') =>
  i18n(key as MessageKey, vars, locale);
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const userId = async (cookie: string) => (await body(await t.api(cookie).get('/auth/me'))).user.id as string;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  // S-46: custom senders apply at once here (sec2-senders.test.ts covers the owner's approval).
  await t.api(owner).patch('/platform/settings', { senders: { require_approval: false } });
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
  admin = await join('admin@acme.test');
  adminId = await userId(admin);
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = await userId(bob);
});
afterAll(() => t.close());

describe('email accent colour (M11)', () => {
  it('defaults to the platform colour; the owner and the account admin can each change it', async () => {
    const d = await body(await as(admin).get('/accounts/me'));
    expect(d.platform_defaults.email_accent_color).toBe(DEFAULT_EMAIL_ACCENT);
    expect((await body(await t.api(owner).get('/platform/settings'))).fallbacks).toMatchObject({
      email_accent_color: DEFAULT_EMAIL_ACCENT,
      test_emails_per_hour: expect.any(Number),
    });

    expect((await t.api(owner).patch('/platform/settings', { email: { accent_color: 'red' } })).status).toBe(400);
    expect((await t.api(owner).patch('/platform/settings', { email: { accent_color: '#224466' } })).status).toBe(200);
    expect((await body(await as(admin).get('/accounts/me'))).platform_defaults.email_accent_color).toBe('#224466');

    const patch = (cookie: string, v: string | null) =>
      as(cookie).patch('/accounts/me', { settings: { branding: { email_accent_color: v } } });
    expect((await patch(bob, '#112233')).status).toBe(403);
    expect((await patch(admin, '#12345')).status).toBe(400);
    expect((await patch(admin, '#112233;x')).status).toBe(400);
    const saved = await body(await patch(admin, '#AA3300'));
    expect(saved.settings.branding.email_accent_color).toBe('#AA3300');

    // A real email carries it.
    await as(admin).post('/users/invite', { emails: ['carol@acme.test'], role: 'member' });
    expect(t.lastMailTo('carol@acme.test').html).toContain('background-color:#aa3300');

    // null = back to the owner's.
    expect((await body(await patch(admin, null))).settings.branding.email_accent_color).toBeUndefined();
    await as(admin).post('/users/invite', { emails: ['dave@acme.test'], role: 'member' });
    expect(t.lastMailTo('dave@acme.test').html).toContain('background-color:#224466');
    await t.api(owner).patch('/platform/settings', { email: { accent_color: null } });
  });
});

describe('email preview (M11)', () => {
  const preview = (cookie: string, q: string) => as(cookie).get(`/accounts/me/email-preview?${q}`);

  it('renders every template in Hebrew and English with sample data, for admins only', async () => {
    for (const template of MAIL_TEMPLATE_KEYS)
      for (const locale of ['he', 'en'] as const) {
        const res = await preview(admin, `template=${template}&locale=${locale}`);
        expect(res.status, `${template}/${locale}`).toBe(200);
        const p = await body(res);
        expect(p.subject.length).toBeGreaterThan(0);
        expect(p.html).toContain(`dir="${locale === 'he' ? 'rtl' : 'ltr'}"`);
        expect(p.html).toContain('>Acme</td>');
        expect(p.text).toContain(tr('mail.footer.product', { product: tr('app.name', undefined, locale) }, locale));
        expect(p.from_name).toBe('Acme');
      }
    expect((await preview(bob, 'template=invitation&locale=he')).status).toBe(403);
    expect((await preview(admin, 'template=nope&locale=he')).status).toBe(400);
    expect((await preview(admin, 'template=digest&locale=fr')).status).toBe(400);
  });

  it('tries an unsaved accent colour, and refuses anything but #rrggbb', async () => {
    const p = await body(await preview(admin, 'template=notification&locale=en&accent=%23ff8800'));
    expect(p.html).toContain('background-color:#ff8800');
    expect((await preview(admin, 'template=notification&locale=en&accent=red')).status).toBe(400);
  });

  it("shows the account's sender name and Reply-To", async () => {
    await as(admin).patch('/accounts/me', {
      settings: { branding: { email_sender_name: 'Acme Desk', email_reply_to: 'desk@acme.test' } },
    });
    const p = await body(await preview(admin, 'template=automation&locale=he'));
    expect(p).toMatchObject({ from_name: 'Acme Desk', reply_to: 'desk@acme.test' });
    await as(admin).patch('/accounts/me', {
      settings: { branding: { email_sender_name: null, email_reply_to: null } },
    });
  });
});

describe('test email (M11)', () => {
  const send = (cookie: string, template = 'notification', locale = 'en') =>
    as(cookie).post('/accounts/me/email-test', { template, locale });

  it("goes only to the admin's own address, marked as a test; members cannot", async () => {
    expect((await send(bob)).status).toBe(403);
    const before = t.mailer.sent.length;
    const res = await send(admin, 'magic_link', 'he');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ to: 'admin@acme.test', sent: true, skipped: null });
    expect(t.mailer.sent.length).toBe(before + 1);
    const mail = t.mailer.sent.at(-1)!;
    expect(mail.to).toBe('admin@acme.test');
    expect(mail.subject).toBe(
      tr('mail.test.subject', { subject: tr('mail.magic.subject', { product: tr('app.name') }) }),
    );
    expect(mail.html).toContain('dir="rtl"');
  });

  it("is rate-limited by the owner's setting (429)", async () => {
    await t.api(owner).patch('/platform/settings', { email: { test_emails_per_hour: 2 } });
    try {
      // One was sent above; one more fits in the hour, the next is refused.
      expect((await send(admin)).status).toBe(200);
      const res = await send(admin);
      expect(res.status).toBe(429);
      expect((await body(res)).error.code).toBe('rate_limited');
    } finally {
      await t.api(owner).patch('/platform/settings', { email: { test_emails_per_hour: null } });
    }
  });
});

describe('MAIL_ALLOWLIST (staging)', () => {
  // Boots its own PGlite (all migrations) inside the test, which under a loaded runner exceeds the 30s test timeout.
  it('a test to an address off the allowlist is reported and not sent', async () => {
    const s = await createTestContext({ env: { MAIL_ALLOWLIST: `${OWNER_EMAIL}, @allowed.test` } });
    try {
      const o = (await s.signInWithMagicLink(OWNER_EMAIL)).cookie!;
      const id = (
        await body(
          await s.api(o).post('/platform/accounts', {
            name: 'Stage',
            slug: 'stage',
            first_admin_email: 'admin@blocked.test',
            template_set: 'empty',
          }),
        )
      ).account.id;
      const token = s.inviteTokenFor('admin@blocked.test');
      const cookie = s.cookieFrom(await s.signUpWithPassword('admin@blocked.test', token))!;
      await s.api(cookie).post('/invitations/accept', { token });
      const before = s.mailer.sent.length;
      const res = await s.api(cookie, id).post('/accounts/me/email-test', { template: 'digest', locale: 'en' });
      expect(res.status).toBe(200);
      expect(await body(res)).toEqual({ to: 'admin@blocked.test', sent: false, skipped: 'not_allowlisted' });
      expect(s.mailer.sent.length).toBe(before);
    } finally {
      await s.close();
    }
  }, 120_000);
});

describe("automation emails: the recipient's language (M11)", () => {
  it('a member reads the frame in their language; an outside address in the account language', async () => {
    await t.db.update(users).set({ locale: 'en' }).where(eq(users.id, bobId));
    const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
    await t.db.insert(automations).values({
      id: newId(),
      accountId: acmeId,
      boardId,
      title: 'Welcome',
      recipe: {
        trigger: { type: 'item_created' },
        actions: [
          {
            type: 'send_email',
            to: [`user:${bobId}`, 'client@outside.test'],
            subject: 'New: {item.name}',
            body_html: 'Hello',
            reply_to: 'sales@acme.test',
          },
        ],
      } as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    await as(admin).post(`/boards/${boardId}/items`, { name: 'Lead <b>' });
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt));
    for (const r of rows) for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);

    const toBob = t.lastMailTo('bob@acme.test');
    expect(toBob.subject).toBe('New: Lead <b>');
    expect(toBob.html).toContain('dir="ltr"');
    expect(toBob.text).toContain(tr('mail.openItem', undefined, 'en'));
    expect(toBob.replyTo).toBe('sales@acme.test');
    const toClient = t.lastMailTo('client@outside.test');
    expect(toClient.html).toContain('dir="rtl"'); // the account's language (he)
    expect(toClient.text).toContain(tr('mail.openItem'));
    expect(toClient.html).not.toContain('Lead <b>');
  });
});
