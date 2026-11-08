// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountInvitations, auditLog } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Invitations, end to end (product owner: "לשגר לו למייל, להקפיץ לו את המייל, לבטל את ההזמנה" — in the owner
 * console and in the account): every invite is emailed by default (or a link to copy), re-send keeps the same
 * invitation with a fresh link (the old one dies), cancel kills the link at once, the list shows status / inviter /
 * email history, the inviter hears when it is accepted, and the owner console does the same under the back-door rule.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string, token = t.inviteTokenFor(email)) => {
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const tokenOf = (url: string) => /\/invite\/([\w-]+)$/.exec(url)![1]!;
const preview = (token: string) => t.api(undefined).post('/invitations/preview', { token });
const list = async (cookie = admin) => (await body(await as(cookie).get('/users/invitations'))).data as Json[];
const owned = async () =>
  (await body(await t.api(owner).get(`/platform/accounts/${acmeId}/invitations`))).data as Json[];
const audits = (action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));
const invite = async (email: string, extra: Json = {}, cookie = admin) =>
  body(await as(cookie).post('/users/invite', { emails: [email], role: 'member', ...extra }));
const setInvitations = (settings: Json) => as(admin).patch('/accounts/me', { settings: { invitations: settings } });

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const created = await body(
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'empty',
    }),
  );
  acmeId = created.account.id;
  admin = await join('admin@acme.test');
  await invite('bob@acme.test');
  bob = await join('bob@acme.test');
});
afterAll(() => t.close());

describe('send', () => {
  it('emails by default; the list shows status, inviter and the email history', async () => {
    const before = t.mailer.sent.length;
    const res = await invite('dana@acme.test');
    expect(res.errors).toEqual([]);
    expect(res.invited[0].url).toBe(`${WEB_ORIGIN}/invite/${t.inviteTokenFor('dana@acme.test')}`);
    expect(t.mailer.sent.length).toBe(before + 1);
    const row = (await list()).find((i) => i.email === 'dana@acme.test')!;
    expect(row).toMatchObject({ status: 'sent', send_count: 1, opened_at: null });
    expect(row.invited_by).toEqual({ id: expect.any(String), name: expect.any(String) });
    expect(row.last_sent_at).toBeTruthy();
    expect(row.url).toBeUndefined();
    // Valid the account's setting (default 7 days).
    const days = (Date.parse(row.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('send_email: false = a link to copy only, nothing emailed, no "email_failed"', async () => {
    const before = t.mailer.sent.length;
    const res = await invite('link-only@acme.test', { send_email: false });
    expect(res.errors).toEqual([]);
    expect(res.invited[0].url).toMatch(/\/invite\/[\w-]+$/);
    expect(t.mailer.sent.length).toBe(before);
    expect((await list()).find((i) => i.email === 'link-only@acme.test')).toMatchObject({
      status: 'link',
      send_count: 0,
      last_sent_at: null,
    });
  });

  it('opening the link marks it "opened"', async () => {
    const { invited } = await invite('opener@acme.test');
    expect((await preview(tokenOf(invited[0].url))).status).toBe(200);
    const row = (await list()).find((i) => i.email === 'opener@acme.test')!;
    expect(row.status).toBe('opened');
    expect(row.opened_at).toBeTruthy();
  });

  it('a failed email shows as "failed" and still leaves the link', async () => {
    const send = t.mailer.send;
    t.mailer.send = async () => {
      throw new Error('smtp down');
    };
    try {
      const res = await invite('bounce@acme.test');
      expect(res.errors).toEqual([{ email: 'bounce@acme.test', code: 'email_failed' }]);
      expect(res.invited[0].url).toBeTruthy();
    } finally {
      t.mailer.send = send;
    }
    expect((await list()).find((i) => i.email === 'bounce@acme.test')!.status).toBe('failed');
  });

  it('the account setting sets the link lifetime', async () => {
    expect((await setInvitations({ expiry_days: 3 })).status).toBe(200);
    const { invited } = await invite('short@acme.test');
    const days = (Date.parse(invited[0].expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
    await setInvitations({ expiry_days: 7 });
    expect((await setInvitations({ expiry_days: 0 })).status).toBe(400);
  });
});

describe('resend (decided: the same invitation, a fresh link; the old link dies)', () => {
  it('keeps id and inviter, counts the send, renews the expiry by the chosen days', async () => {
    const { invited } = await invite('again@acme.test');
    const first = invited[0];
    const res = await as(admin).post(`/users/invitations/${first.id}/resend?expires_in_days=14`);
    expect(res.status).toBe(200);
    const again = await body(res);
    expect(again.emailed).toBe(true);
    expect(again.invitation.id).toBe(first.id);
    expect(again.invitation.send_count).toBe(2);
    const days = (Date.parse(again.invitation.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    // The old link stops working; the new one works.
    expect((await preview(tokenOf(first.url))).status).toBe(404);
    expect((await preview(tokenOf(again.invitation.url))).status).toBe(200);
    expect(again.invitation.url).toBe(`${WEB_ORIGIN}/invite/${t.inviteTokenFor('again@acme.test')}`);
    const rows = (await list()).filter((i) => i.email === 'again@acme.test');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invited_by.name).toBeTruthy();
    expect((await audits('invitation.resent')).some((r) => r.targetId === first.id)).toBe(true);
    expect((await as(admin).post(`/users/invitations/${first.id}/resend?expires_in_days=500`)).status).toBe(400);
  });

  it('an expired invitation is listed as expired and comes back to life on re-send', async () => {
    const { invited } = await invite('late@acme.test');
    await t.db
      .update(accountInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accountInvitations.id, invited[0].id));
    expect((await list()).find((i) => i.id === invited[0].id)!.status).toBe('expired');
    expect((await preview(tokenOf(invited[0].url))).status).toBe(404);
    const again = await body(await as(admin).post(`/users/invitations/${invited[0].id}/resend`));
    expect(again.invitation.status).toBe('sent');
    expect((await preview(tokenOf(again.invitation.url))).status).toBe(200);
    // A new invite to the same address replaces an expired one too (one row per address).
    await t.db
      .update(accountInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accountInvitations.id, invited[0].id));
    await invite('late@acme.test');
    expect((await list()).filter((i) => i.email === 'late@acme.test')).toHaveLength(1);
  });

  it('the account resend wait: 429 until it passes; copying a link does not wait', async () => {
    await setInvitations({ resend_cooldown_minutes: 10 });
    try {
      const { invited } = await invite('wait@acme.test');
      const res = await as(admin).post(`/users/invitations/${invited[0].id}/resend`);
      expect(res.status).toBe(429);
      expect((await body(res)).error.message).toBe('invitation_resend_cooldown');
      expect((await as(admin).post(`/users/invitations/${invited[0].id}/link`)).status).toBe(200);
    } finally {
      await setInvitations({ resend_cooldown_minutes: 0 });
    }
  });

  it('members cannot re-send, copy or cancel; another account is 404', async () => {
    const { invited } = await invite('guarded@acme.test');
    const id = invited[0].id;
    expect((await as(bob).post(`/users/invitations/${id}/resend`)).status).toBe(403);
    expect((await as(bob).post(`/users/invitations/${id}/link`)).status).toBe(403);
    expect((await as(bob).del(`/users/invitations/${id}`)).status).toBe(403);
    expect((await as(bob).get('/users/invitations')).status).toBe(403);
    expect((await as(bob).patch('/accounts/me', { settings: { invitations: { expiry_days: 30 } } })).status).toBe(403);
  });
});

describe('cancel', () => {
  it('the link stops working at once; audited with who cancelled; cannot cancel twice', async () => {
    const { invited } = await invite('cancel@acme.test');
    const token = tokenOf(invited[0].url);
    expect((await preview(token)).status).toBe(200);
    expect((await as(admin).del(`/users/invitations/${invited[0].id}`)).status).toBe(200);
    expect((await preview(token)).status).toBe(404);
    expect((await t.api(bob).post('/invitations/accept', { token })).status).toBe(404);
    expect((await list()).some((i) => i.email === 'cancel@acme.test')).toBe(false);
    const [row] = await t.db.select().from(accountInvitations).where(eq(accountInvitations.id, invited[0].id));
    expect(row!.revokedBy).toBeTruthy();
    expect((await audits('invitation.revoked')).some((r) => r.targetId === invited[0].id)).toBe(true);
    expect((await as(admin).del(`/users/invitations/${invited[0].id}`)).status).toBe(404);
    expect((await as(admin).post(`/users/invitations/${invited[0].id}/resend`)).status).toBe(404);
  });
});

describe('the inviter hears when it is accepted', () => {
  it('a bell notification to the inviter (on by default), none when the account turns it off', async () => {
    const accepted = async () =>
      ((await body(await as(admin).get('/me/notifications'))).data as Json[]).filter(
        (x) => x.type === 'invitation_accepted',
      );
    const before = (await accepted()).length;
    await invite('carol@acme.test');
    await join('carol@acme.test');
    const mine = await accepted();
    expect(mine).toHaveLength(before + 1);
    const n = mine.find((x) => x.excerpt === 'carol@acme.test');
    expect(n).toBeTruthy();
    expect(n!.actor?.id).toBeTruthy();
    expect(n!.excerpt).toBe('carol@acme.test');

    await setInvitations({ notify_inviter: false });
    try {
      await invite('quiet@acme.test');
      await join('quiet@acme.test');
      expect(await accepted()).toHaveLength(before + 1);
    } finally {
      await setInvitations({ notify_inviter: true });
    }
  });
});

describe('owner console', () => {
  it('lists an account’s invitations, invites any role, re-sends, copies a link and cancels — audited', async () => {
    const res = await t
      .api(owner)
      .post(`/platform/accounts/${acmeId}/invitations`, { email: 'viewer@acme.test', role: 'viewer' });
    expect(res.status).toBe(200);
    const inv = (await body(res)).invitation;
    expect(inv.role).toBe('viewer');
    const row = (await owned()).find((i) => i.id === inv.id)!;
    expect(row).toMatchObject({ status: 'sent', email: 'viewer@acme.test' });

    const again = await body(await t.api(owner).post(`/platform/accounts/${acmeId}/invitations/${inv.id}/resend`));
    expect(again.invitation.id).toBe(inv.id);
    expect((await preview(tokenOf(inv.url))).status).toBe(404);
    const link = await body(
      await t.api(owner).post(`/platform/accounts/${acmeId}/invitations/${inv.id}/link?expires_in_days=2`),
    );
    expect(link.emailed).toBe(false);
    expect((await preview(tokenOf(again.invitation.url))).status).toBe(404);
    expect((await preview(tokenOf(link.invitation.url))).status).toBe(200);

    expect((await t.api(owner).del(`/platform/accounts/${acmeId}/invitations/${inv.id}`)).status).toBe(200);
    expect((await preview(tokenOf(link.invitation.url))).status).toBe(404);
    for (const action of ['user.invited', 'invitation.resent', 'invitation.link_copied', 'invitation.revoked'])
      expect(
        (await audits(action)).some(
          (r) => r.targetId === inv.id && (r.payload as Json).via === 'platform_owner' && r.actorId,
        ),
      ).toBe(true);

    // Link only from the start: nothing emailed.
    const before = t.mailer.sent.length;
    const quiet = await body(
      await t.api(owner).post(`/platform/accounts/${acmeId}/invitations`, {
        email: 'second-admin@acme.test',
        send_email: false,
      }),
    );
    expect(quiet).toMatchObject({ emailed: false, invitation: { role: 'admin' } });
    expect(t.mailer.sent.length).toBe(before);
  });

  it('the back-door rule: never the owner’s own address without an edit grant — invite, re-send or copy', async () => {
    const own = await t.api(owner).post(`/platform/accounts/${acmeId}/invitations`, {
      email: OWNER_EMAIL,
      role: 'member',
    });
    expect(own.status).toBe(403);
    expect((await body(own)).error.message).toBe('support_grant_required');
    // An invitation to the owner's address made inside the account by its admin: the console may cancel it, but not
    // re-send it or copy its link.
    const { invited } = await invite(OWNER_EMAIL);
    const id = invited[0].id;
    expect((await t.api(owner).post(`/platform/accounts/${acmeId}/invitations/${id}/link`)).status).toBe(403);
    expect((await t.api(owner).post(`/platform/accounts/${acmeId}/invitations/${id}/resend`)).status).toBe(403);
    expect((await t.api(owner).del(`/platform/accounts/${acmeId}/invitations/${id}`)).status).toBe(200);
  });

  it('owner-only: account people cannot use it; unknown account / invitation is 404', async () => {
    // The owner console does not exist for anyone else (404, like every /platform route).
    expect((await t.api(admin).get(`/platform/accounts/${acmeId}/invitations`)).status).toBe(404);
    expect((await t.api(admin).post(`/platform/accounts/${acmeId}/invitations`, { email: 'x@acme.test' })).status).toBe(
      404,
    );
    expect((await t.api(owner).get('/platform/accounts/nope/invitations')).status).toBe(404);
    expect((await t.api(owner).del(`/platform/accounts/${acmeId}/invitations/nope`)).status).toBe(404);
  });
});

describe('rate limits (S-12): the hourly invitation-email budget from the owner console', () => {
  it('re-sends count in the budget; copying a link does not', async () => {
    // A fresh admin, so the budget starts empty.
    await invite('admin2@acme.test', { role: 'admin' });
    const admin2 = await join('admin2@acme.test');
    expect((await t.api(owner).patch('/platform/settings', { email: { invite_emails_per_hour: 1 } })).status).toBe(200);
    try {
      const first = await invite('budget@acme.test', {}, admin2);
      expect(first.invited).toHaveLength(1);
      const resend = await as(admin2).post(`/users/invitations/${first.invited[0].id}/resend`);
      expect(resend.status).toBe(429);
      expect((await as(admin2).post(`/users/invitations/${first.invited[0].id}/link`)).status).toBe(200);
      const settings = await body(await t.api(owner).get('/platform/settings'));
      expect(settings.settings.email.invite_emails_per_hour).toBe(1);
    } finally {
      await t.api(owner).patch('/platform/settings', { email: { invite_emails_per_hour: null } });
    }
  });
});
