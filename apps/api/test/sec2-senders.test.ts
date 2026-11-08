// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSettings, auditLog, notifications, senderRequests } from '../src/db/schema';
import type { Db } from '../src/db/client';
import { smsSenderId } from '../src/modules/platform/platform-settings';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * S-46 — custom senders need the platform owner's approval: an admin's email sender name / Reply-To / SMS sender
 * id waits as a pending request (the default stays in force), the owner approves or rejects it with a reason, the
 * admin sees the state and is notified, every step is audited; the account's own name never needs approval; the
 * owner can switch approval off; values saved before approval existed are grandfathered as approved.
 */
let t: TestContext;
let owner: string;
let admin: string;
let adminId: string;
let bob: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const db = () => t.db as unknown as Db;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const patch = (cookie: string, settings: Json) => as(cookie).patch('/accounts/me', { settings });
const status = async () => body(await as(admin).get('/accounts/me/sender-requests'));
const stateOf = async (kind: string) => (await status()).data.find((r: Json) => r.kind === kind);
const preview = async () => body(await as(admin).get('/accounts/me/email-preview?template=notification&locale=en'));
const pendingList = async () => (await body(await t.api(owner).get('/platform/sender-requests'))).data as Json[];
const audits = async (action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));

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
  admin = await join('admin@acme.test');
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
});
afterAll(() => t.close());

describe('S-46 custom senders', () => {
  it('approval is on by default; a custom sender name waits and the account name stays the sender', async () => {
    const settings = await body(await t.api(owner).get('/platform/settings'));
    expect(settings.settings.senders).toEqual({ require_approval: true });

    const res = await patch(admin, { branding: { email_sender_name: 'Bank Support' } });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.branding.email_sender_name).toBeUndefined();
    expect(await status()).toMatchObject({ require_approval: true });
    expect(await stateOf('email_sender_name')).toMatchObject({
      status: 'pending',
      value: 'Bank Support',
      requested_by_name: expect.any(String),
    });
    expect((await preview()).from_name).toBe('Acme');
    expect(await audits('sender.requested')).toHaveLength(1);
  });

  it("the account's own name never needs approval", async () => {
    const res = await patch(admin, { branding: { email_sender_name: 'ACME' } });
    expect((await body(res)).settings.branding.email_sender_name).toBe('ACME');
    expect((await preview()).from_name).toBe('ACME');
    // The pending request was withdrawn by the new choice; the state line shows it as in force.
    expect(await stateOf('email_sender_name')).toMatchObject({ status: 'approved', value: 'ACME' });
    expect((await pendingList()).filter((r) => r.account_id === acmeId)).toHaveLength(0);
  });

  it('the owner approves: the value takes effect, it is audited and the admin is notified', async () => {
    await patch(admin, { branding: { email_sender_name: 'Acme Support' } });
    const [req] = (await pendingList()).filter((r) => r.account_id === acmeId && r.kind === 'email_sender_name');
    expect(req).toMatchObject({ account_name: 'Acme', value: 'Acme Support', status: 'pending' });
    // Only the owner: an account admin gets 404 on the owner's routes.
    expect((await t.api(admin).get('/platform/sender-requests')).status).toBe(404);
    expect((await t.api(admin).post(`/platform/sender-requests/${req!.id}/approve`, {})).status).toBe(404);

    const ok = await t.api(owner).post(`/platform/sender-requests/${req!.id}/approve`, {});
    expect(ok.status).toBe(200);
    expect(await body(ok)).toMatchObject({ status: 'approved', decided_by_name: expect.any(String) });
    expect((await preview()).from_name).toBe('Acme Support');
    expect(await stateOf('email_sender_name')).toMatchObject({ status: 'approved', value: 'Acme Support' });
    expect(await audits('sender.approved')).toHaveLength(1);
    const notes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, adminId), eq(notifications.type, 'sender_request')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.payload).toMatchObject({ sender: { status: 'approved', value: 'Acme Support' } });
    // Decided once: a second decision is a conflict.
    expect((await t.api(owner).post(`/platform/sender-requests/${req!.id}/reject`, { reason: 'x' })).status).toBe(409);
  });

  it('the owner rejects with a reason: nothing changes, the admin sees why', async () => {
    await patch(admin, { branding: { email_reply_to: 'ceo@bank.example' } });
    const [req] = (await pendingList()).filter((r) => r.account_id === acmeId && r.kind === 'email_reply_to');
    expect((await t.api(owner).post(`/platform/sender-requests/${req!.id}/reject`, {})).status).toBe(400);
    const res = await t.api(owner).post(`/platform/sender-requests/${req!.id}/reject`, {
      reason: 'Not your domain',
    });
    expect(res.status).toBe(200);
    expect((await preview()).reply_to).toBeNull();
    expect(await stateOf('email_reply_to')).toMatchObject({ status: 'rejected', reason: 'Not your domain' });
    const [audit] = await audits('sender.rejected');
    expect(audit!.payload).toMatchObject({ kind: 'email_reply_to', reason: 'Not your domain' });
    const notes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, adminId), eq(notifications.type, 'sender_request')));
    expect(notes.some((n) => (n.payload as Json).sender?.status === 'rejected')).toBe(true);
    // The owner's full list keeps the history.
    const all = (await body(await t.api(owner).get('/platform/sender-requests?status=all'))).data as Json[];
    expect(all.some((r) => r.id === req!.id && r.status === 'rejected')).toBe(true);
  });

  it('an SMS sender waits too: SMS keep the platform sender meanwhile', async () => {
    await t.api(owner).patch('/platform/settings', { sms: { sender_id: 'Platform' } });
    await patch(admin, { sms: { sender_id: 'BankIL' } });
    expect(await stateOf('sms_sender_id')).toMatchObject({ status: 'pending', value: 'BankIL' });
    expect(await smsSenderId(db(), acmeId)).toBe('Platform');
    // A new request replaces the pending one; clearing withdraws it (and needs no approval).
    await patch(admin, { sms: { sender_id: 'AcmeSms' } });
    const mine = (await pendingList()).filter((r) => r.account_id === acmeId && r.kind === 'sms_sender_id');
    expect(mine.map((r) => r.value)).toEqual(['AcmeSms']);
    await patch(admin, { sms: { sender_id: null } });
    expect(await stateOf('sms_sender_id')).toBeUndefined();
    expect((await pendingList()).filter((r) => r.account_id === acmeId)).toHaveLength(0);
  });

  it('only admins read the state', async () => {
    expect((await as(bob).get('/accounts/me/sender-requests')).status).toBe(403);
    expect((await patch(bob, { branding: { email_sender_name: 'Bob' } })).status).toBe(403);
  });

  it('the owner can switch approval off: values then apply at once', async () => {
    expect((await t.api(owner).patch('/platform/settings', { senders: { require_approval: false } })).status).toBe(200);
    expect((await status()).require_approval).toBe(false);
    const res = await patch(admin, { sms: { sender_id: 'AcmeNow' } });
    expect((await body(res)).settings.sms.sender_id).toBe('AcmeNow');
    expect(await smsSenderId(db(), acmeId)).toBe('AcmeNow');
    await t.api(owner).patch('/platform/settings', { senders: { require_approval: true } });
  });

  it('grandfathering: custom values saved before approval existed are recorded as approved', async () => {
    // The migration's data step, run again on an account that has custom values and no request rows.
    const id = (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: 'Old Co',
          slug: 'oldco',
          first_admin_email: 'admin@oldco.test',
          template_set: 'empty',
        }),
      )
    ).account.id as string;
    await t.db
      .update(accountSettings)
      .set({
        settings: sql`${accountSettings.settings} || '{"branding":{"email_sender_name":"Old Desk","email_reply_to":"desk@old.test"},"sms":{"sender_id":"OldCo"}}'::jsonb`,
      })
      .where(eq(accountSettings.accountId, id));
    const migration = readFileSync('drizzle/0057_sec2.sql', 'utf8').split('--> statement-breakpoint');
    const step = migration.find((s) => s.includes('INSERT INTO "sender_requests"'))!;
    await t.pg.exec(step);
    const rows = await t.db.select().from(senderRequests).where(eq(senderRequests.accountId, id));
    expect(rows.map((r) => [r.kind, r.value, r.status]).sort()).toEqual([
      ['email_reply_to', 'desk@old.test', 'approved'],
      ['email_sender_name', 'Old Desk', 'approved'],
      ['sms_sender_id', 'OldCo', 'approved'],
    ]);
    // Still in force — nothing was taken away.
    expect(await smsSenderId(db(), id)).toBe('OldCo');
  });
});
