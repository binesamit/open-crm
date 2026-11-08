// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { memoryMailer } from '@bines/server-mail';
import { newId, notificationSentence } from '@bines/shared';
import { dispatchNotification, sendDigests } from '../../worker/src/notifications';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import { notifications, notificationSettings, users } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/** M4 step 3 (D15, 08 §12.3): the worker emails a notification once, honouring read state and settings. */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let bobId: string;
let boardId: string;
let itemId: string;
let mailer: ReturnType<typeof memoryMailer>;
const APP = 'https://app.test';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const db = () => t.pg as unknown as SqlClient;
const deps = () => ({ mailer, appUrl: APP });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);

/** Admin mentions Bob; returns Bob's new notification id. */
const mentionBob = async (text = 'תבדוק') => {
  await as(admin).post(`/items/${itemId}/updates`, { body: `[@Bob](user:${bobId}) ${text}` });
  const [n] = await t.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, bobId), eq(notifications.type, 'mention')))
    .orderBy(desc(notifications.id))
    .limit(1);
  return n!.id;
};
const setting = (row: { type?: string; boardId?: string; enabled?: boolean; digest?: string }) =>
  t.db.insert(notificationSettings).values({
    id: newId(),
    accountId: acmeId,
    userId: bobId,
    channel: 'email',
    type: row.type ?? '*',
    boardId: row.boardId ?? null,
    enabled: row.enabled ?? true,
    digest: row.digest ?? 'instant',
  });

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  bobId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
    (u) => u.email === 'bob@acme.test',
  )!.user_id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: ws.id }))).id;
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Deal X' }))).id;
});
beforeEach(async () => {
  mailer = memoryMailer();
  await t.db.delete(notificationSettings);
});
afterAll(() => t.close());

describe('notifications.dispatch', () => {
  it('emails the bell sentence with a link to the item, once', async () => {
    const id = await mentionBob('מה המצב עם ההצעה?');
    expect(await dispatchNotification(db(), deps(), id)).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('bob@acme.test');
    expect(mail.subject).toBe('admin תייג/ה אתכם ב־Deal X');
    expect(mail.html).toMatch(new RegExp(`/a/acme/b/${boardId}/i/${itemId}\\?tab=updates&(amp;)?update=[0-9A-Z]{26}`));
    expect(mail.html).toContain('מה המצב עם ההצעה?');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.text).toContain('Deals');

    expect(await dispatchNotification(db(), deps(), id)).toBe('already_sent');
    expect(mailer.sent).toHaveLength(1);
    expect(await dispatchNotification(db(), deps(), newId())).toBe('missing');
  });

  it("is written in the recipient's language, from the account's sender name (ANSWERS 6א.3)", async () => {
    await as(admin).patch('/accounts/me', {
      settings: { branding: { email_sender_name: 'Acme Desk', email_reply_to: 'desk@acme.test' } },
    });
    await t.db.update(users).set({ locale: 'en' }).where(eq(users.id, bobId));
    try {
      const id = await mentionBob('status?');
      expect(await dispatchNotification(db(), deps(), id)).toBe('sent');
      const mail = mailer.sent[0]!;
      expect(mail).toMatchObject({ fromName: 'Acme Desk', replyTo: 'desk@acme.test' });
      expect(mail.html).toContain('dir="ltr"');
      expect(mail.subject).toBe(notificationSentence({ type: 'mention', actor: 'admin', item: 'Deal X' }, 'en'));
    } finally {
      await t.db.update(users).set({ locale: 'he' }).where(eq(users.id, bobId));
      await as(admin).patch('/accounts/me', {
        settings: { branding: { email_sender_name: null, email_reply_to: null } },
      });
    }
  });

  it('skips what was read in the bell meanwhile', async () => {
    const id = await mentionBob();
    await as(bob).post('/me/notifications/read', { ids: [id] });
    expect(await dispatchNotification(db(), deps(), id)).toBe('read');
    expect(mailer.sent).toHaveLength(0);
  });

  it('honours the settings: a category off, everything off, or one board muted', async () => {
    await setting({ type: 'mentioned', enabled: false });
    expect(await dispatchNotification(db(), deps(), await mentionBob())).toBe('disabled');
    await t.db.delete(notificationSettings);

    await setting({ type: 'assigned', enabled: false }); // another category: no effect
    expect(await dispatchNotification(db(), deps(), await mentionBob())).toBe('sent');
    await t.db.delete(notificationSettings);

    await setting({ boardId, enabled: false });
    expect(await dispatchNotification(db(), deps(), await mentionBob())).toBe('disabled');
    await t.db.delete(notificationSettings);

    await setting({ enabled: false });
    expect(await dispatchNotification(db(), deps(), await mentionBob())).toBe('disabled');
    expect(mailer.sent).toHaveLength(1);
  });

  it('does not email someone who left the account', async () => {
    const id = await mentionBob();
    await t.pg.query(`update account_members set status = 'deactivated' where user_id = $1`, [bobId]);
    expect(await dispatchNotification(db(), deps(), id)).toBe('not_member');
    await t.pg.query(`update account_members set status = 'active' where user_id = $1`, [bobId]);
  });
});

describe('notifications.digest', () => {
  it('daily-digest users get no instant email, then one digest at 08:00 their time', async () => {
    await t.pg.query(`update notifications set read_at = now() where user_id = $1`, [bobId]);
    await setting({ digest: 'daily' });
    const first = await mentionBob('ראשונה');
    const second = await mentionBob('שנייה');
    expect(await dispatchNotification(db(), deps(), first)).toBe('digest');

    // Bob's timezone is UTC here, so 08:00 UTC today is his digest hour and 09:00 is not.
    await t.pg.query(`update users set timezone = 'UTC' where id = $1`, [bobId]);
    const at = (hour: number) => {
      const d = new Date();
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    };
    expect(await sendDigests(db(), deps(), at(9))).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect(await sendDigests(db(), deps(), at(8))).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.subject).toBe(he('mail.digest.title', { n: 2, account: 'Acme' }));
    expect(mail.text).toContain('ראשונה');
    expect(mail.text).toContain('שנייה');
    expect(await dispatchNotification(db(), deps(), second)).toBe('already_sent');
    expect(await sendDigests(db(), deps(), at(8))).toBe(0);
  });

  it('a weekly summary goes out on its weekday at its hour only', async () => {
    await t.pg.query(`update notifications set read_at = now() where user_id = $1`, [bobId]);
    await setting({ digest: 'weekly:3:10' }); // Wednesdays, 10:00
    const id = await mentionBob('שבועי');
    expect(await dispatchNotification(db(), deps(), id)).toBe('digest');
    // The coming Wednesday and Thursday, 10:00 UTC (Bob is on UTC). Today counts while 10:00 is still ahead, so the
    // Wednesday is always under a week away and the mention stays inside the 7-day digest window (on a Wednesday the
    // old "+7 days" landed outside it). The "09:00" probe may fall before now — it only checks the hour.
    const next = (weekday: number) => {
      const now = Date.now();
      const d = new Date(now);
      d.setUTCHours(10, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7));
      if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 7);
      return d;
    };
    const before = mailer.sent.length;
    expect(await sendDigests(db(), deps(), next(4))).toBe(0); // Thursday
    expect(await sendDigests(db(), deps(), new Date(next(3).getTime() - 3_600_000))).toBe(0); // Wed 09:00
    expect(await sendDigests(db(), deps(), next(3))).toBe(1);
    expect(mailer.sent.length).toBe(before + 1);
  });

  it("a member without a timezone of their own gets the digest at the hour of the account's timezone", async () => {
    await t.pg.query(`update notifications set read_at = now() where user_id = $1`, [bobId]);
    await setting({ digest: 'daily' }); // 08:00
    const at = (hour: number) => {
      const d = new Date();
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    };
    // Bob never chose a zone: an admin moves the account to Tokyo (UTC+9, no DST) → 08:00 there = 23:00 UTC.
    await t.pg.query(`update users set timezone = null where id = $1`, [bobId]);
    const moved = await as(admin).patch('/accounts/me', { settings: { locale: { timezone: 'Asia/Tokyo' } } });
    expect(moved.status).toBe(200);
    await mentionBob('לפי החשבון');
    expect(await sendDigests(db(), deps(), at(8))).toBe(0);
    expect(await sendDigests(db(), deps(), at(23))).toBe(1);
    expect(mailer.sent.at(-1)!.text).toContain('לפי החשבון');

    // A zone of his own still wins over the account's.
    await t.pg.query(`update users set timezone = 'UTC' where id = $1`, [bobId]);
    await mentionBob('שלו');
    expect(await sendDigests(db(), deps(), at(23))).toBe(0);
    expect(await sendDigests(db(), deps(), at(8))).toBe(1);
    await as(admin).patch('/accounts/me', { settings: { locale: { timezone: 'Asia/Jerusalem' } } });
  });
});
