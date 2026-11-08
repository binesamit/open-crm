// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, notifications, supportAccessGrants, supportTickets } from '../src/db/schema';
import { alertSlaBreaches } from '../../worker/src/support-sla';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Support tickets (stages 1–5): the ticket lifecycle, who sees what (the customer never sees internal
 * notes, other accounts never see the ticket, staff never see account data without a grant), the support-staff
 * console gate, access from a ticket (request → one-click approve → a grant linked to the ticket → revoked when the
 * ticket is solved), SLA timers and breach alerts, notifications and CSAT.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let carol: string;
let agent: string;
let lead: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);
const console_ = (cookie: string) => t.api(cookie);
const mailsTo = (email: string) => t.mailer.sent.filter((m) => m.to === email);

const upload = async (cookie: string, name: string) => {
  const pre = await body(await as(cookie).post('/files/presign', { name, size: 10, mime: 'image/png' }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, 10, 'image/png');
  expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return pre.file_id as string;
};

const open = async (cookie: string, input: Json = {}) => {
  const res = await as(cookie).post('/support/tickets', {
    subject: 'Status column does not save',
    description: 'It reverts after a refresh',
    ...input,
  });
  expect(res.status).toBe(201);
  return body(res);
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  await mk('Helpers', 'helpers', 'agent@support.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  agent = await join('agent@support.test');
  await as(agent, (await body(await t.api(agent).get('/me/accounts'))).data[0].id).post('/users/invite', {
    emails: ['lead@support.test'],
    role: 'member',
  });
  lead = await join('lead@support.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
});
afterAll(() => t.close());

describe('the support-staff console gate', () => {
  it('only the owner and active support staff open the Support section — and nothing else of the console', async () => {
    expect((await console_(agent).get('/platform/support/config')).status).toBe(404);
    expect((await body(await console_(agent).get('/auth/me'))).user.support_role ?? null).toBeNull();
    // The owner invites by email.
    const invited = await console_(owner).post('/platform/support/staff', {
      email: 'agent@support.test',
      role: 'agent',
    });
    expect(invited.status).toBe(200);
    expect(mailsTo('agent@support.test').at(-1)!.text).toContain('/owner?section=support');
    await console_(owner).post('/platform/support/staff', { email: 'lead@support.test', role: 'lead' });
    const cfg = await body(await console_(agent).get('/platform/support/config'));
    expect(cfg.role).toBe('agent');
    expect((await body(await console_(agent).get('/auth/me'))).user.support_role).toBe('agent');
    // Every other owner-console route stays 404 for support staff.
    for (const path of ['/platform/accounts', '/platform/settings', '/platform/emergency-recovery'])
      expect((await console_(agent).get(path)).status).toBe(404);
    // Staff management is the owner's only; settings are leads' (and the owner's).
    expect((await console_(agent).get('/platform/support/staff')).status).toBe(403);
    expect((await console_(lead).get('/platform/support/staff')).status).toBe(403);
    expect((await console_(agent).patch('/platform/support/settings', { signature: 'x' })).status).toBe(403);
    expect((await console_(lead).patch('/platform/support/settings', { signature: 'The support team' })).status).toBe(
      200,
    );
    // A regular member never gets in.
    expect((await console_(bob).get('/platform/support/tickets')).status).toBe(404);
    // Deactivated → out.
    const staff = (await body(await console_(owner).get('/platform/support/staff'))).data as Json[];
    const row = staff.find((s) => s.email === 'agent@support.test')!;
    await console_(owner).patch(`/platform/support/staff/${row.id}`, { status: 'deactivated' });
    expect((await console_(agent).get('/platform/support/config')).status).toBe(404);
    await console_(owner).patch(`/platform/support/staff/${row.id}`, { status: 'active' });
    expect((await console_(agent).get('/platform/support/config')).status).toBe(200);
  });
});

describe('ticket lifecycle, permissions, notifications and CSAT', () => {
  let ticket: Json;

  it('a member opens a ticket: sequential number, files, the kept context, routing, emails', async () => {
    const lq = await body(await console_(lead).post('/platform/support/queues', { name: 'Billing' }));
    const queue = (lq.queues as Json[]).find((q) => q.name === 'Billing')!;
    const lc = await body(
      await console_(lead).post('/platform/support/categories', {
        name: 'Billing',
        queue_id: queue.id,
        default_priority: 'high',
      }),
    );
    const category = (lc.categories as Json[]).find((c) => c.name === 'Billing')!;
    const options = await body(await as(bob).get('/support/tickets/options'));
    expect(options.may_open).toBe(true);
    expect(options.categories.map((c: Json) => c.id)).toContain(category.id);
    const file = await upload(bob, 'screen.png');
    ticket = await open(bob, {
      category_id: category.id,
      attachment_ids: [file],
      context: {
        page_url: 'https://app.test/a/acme/b/1',
        browser: 'Chrome 140',
        os: 'Windows',
        errors: [{ message: 'TypeError: x is undefined', at: '2026-10-07T10:00:00Z' }],
      },
    });
    expect(ticket.number).toBeGreaterThanOrEqual(1000);
    expect(ticket.status).toBe('new');
    expect(ticket.priority).toBe('high');
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0].attachments[0].name).toBe('screen.png');
    expect(ticket.context.errors).toHaveLength(1);
    const second = await open(bob, { subject: 'Another' });
    expect(second.number).toBe(ticket.number + 1);
    // Received email to the customer; staff (leads / owner) hear about the new ticket.
    expect(
      mailsTo('bob@acme.test').some((m) => m.to === 'bob@acme.test' && m.text.includes(`/support/${ticket.id}`)),
    ).toBe(true);
    expect(mailsTo('lead@support.test').some((m) => m.text.includes(`ticket=${ticket.id}`))).toBe(true);
    // In the console: routed to the category's queue, with the account and the SLA.
    const list = await body(await console_(agent).get(`/platform/support/tickets?queue_id=${queue.id}`));
    const row = (list.data as Json[]).find((x) => x.id === ticket.id)!;
    expect(row.account.slug).toBe('acme');
    expect(row.sla.first_response_due_at).toBeTruthy();
    const file2 = await body(
      await console_(agent).get(
        `/platform/support/tickets/${ticket.id}/attachments/${ticket.messages[0].attachments[0].id}`,
      ),
    );
    expect(file2.download_url).toContain('download');
  });

  it('internal notes stay in the console; a public reply emails and notifies the customer', async () => {
    await console_(agent).post(`/platform/support/tickets/${ticket.id}/messages`, {
      body: 'Looks like a cache issue',
      visibility: 'internal',
    });
    const before = mailsTo('bob@acme.test').length;
    const res = await console_(agent).post(`/platform/support/tickets/${ticket.id}/messages`, {
      body: 'Please clear the cache and try again',
      visibility: 'public',
      status: 'pending_customer',
    });
    expect(res.status).toBe(200);
    const staffView = await body(res);
    expect(staffView.status).toBe('pending_customer');
    expect(staffView.assignee.name).toBeTruthy(); // the first public reply takes the ticket
    expect(staffView.sla.first_responded_at).toBeTruthy();
    expect(staffView.sla.paused).toBe(true);
    expect((staffView.messages as Json[]).some((m) => m.visibility === 'internal')).toBe(true);
    // The customer: no internal note, the reply, an email and a bell notification.
    const mine = await body(await as(bob).get(`/support/tickets/${ticket.id}`));
    expect((mine.messages as Json[]).some((m) => m.body.includes('cache issue'))).toBe(false);
    expect((mine.messages as Json[]).some((m) => m.body.includes('clear the cache'))).toBe(true);
    expect(mine.sla).toBeUndefined();
    expect(mailsTo('bob@acme.test').length).toBeGreaterThan(before);
    expect(mailsTo('bob@acme.test').at(-1)!.text).toContain('The support team'); // the signature setting
    const bell = await body(await as(bob).get('/me/notifications'));
    const n = (bell.data as Json[]).find((x) => x.type === 'ticket_reply')!;
    expect(n.ticket).toMatchObject({ id: ticket.id, number: ticket.number });
    // The generic notification worker never emails it again.
    const [row] = await t.db.select().from(notifications).where(eq(notifications.id, n.id));
    expect(row!.emailedAt).not.toBeNull();
  });

  it('who sees a ticket: the requester and admins; not other members (by default), other accounts or guests', async () => {
    expect((await as(admin).get(`/support/tickets/${ticket.id}`)).status).toBe(200);
    expect((await as(carol).get(`/support/tickets/${ticket.id}`)).status).toBe(404);
    expect(((await body(await as(carol).get('/support/tickets'))).data as Json[]).length).toBe(0);
    expect((await as(otherAdmin, otherId).get(`/support/tickets/${ticket.id}`)).status).toBe(404);
    expect((await as(otherAdmin, acmeId).get(`/support/tickets/${ticket.id}`)).status).toBe(404);
    // The account's settings (admins): members see all; admins only may open.
    expect((await as(bob).patch('/support/tickets/settings', { members_see: 'all' })).status).toBe(403);
    await as(admin).patch('/support/tickets/settings', { members_see: 'all', who_can_open: 'admins' });
    expect((await as(carol).get(`/support/tickets/${ticket.id}`)).status).toBe(200);
    expect((await as(bob).post('/support/tickets', { subject: 'x', description: 'y' })).status).toBe(403);
    expect((await body(await as(bob).get('/support/tickets/options'))).may_open).toBe(false);
    await as(admin).patch('/support/tickets/settings', { members_see: 'own', who_can_open: 'members' });
    // Tokens never reach tickets.
    const token = await body(await as(admin).post('/auth/tokens', { name: 'ci', scopes: ['admin'] }));
    if (token.token) {
      const res = await t.app.request('/api/v1/support/tickets', {
        headers: { authorization: `Bearer ${token.token}`, origin: WEB_ORIGIN },
      });
      expect(res.status).toBe(403);
    }
  });

  it('the customer answers (the ticket opens again, the SLA resumes), staff solve, the customer rates', async () => {
    const pausedDue = (await body(await console_(agent).get(`/platform/support/tickets/${ticket.id}`))).sla
      .resolution_due_at as string;
    const res = await as(bob).post(`/support/tickets/${ticket.id}/messages`, { body: 'Still broken' });
    expect((await body(res)).status).toBe('open');
    const after = await body(await console_(agent).get(`/platform/support/tickets/${ticket.id}`));
    expect(after.sla.paused).toBe(false);
    expect(Date.parse(after.sla.resolution_due_at)).toBeGreaterThanOrEqual(Date.parse(pausedDue));
    // Rating before it is done → 409.
    expect((await as(bob).post(`/support/tickets/${ticket.id}/rating`, { rating: 5 })).status).toBe(409);
    const solved = await body(
      await console_(agent).patch(`/platform/support/tickets/${ticket.id}`, { status: 'solved' }),
    );
    expect(solved.status).toBe('solved');
    expect(solved.solved_at).toBeTruthy();
    const bell = await body(await as(bob).get('/me/notifications'));
    expect((bell.data as Json[]).some((x) => x.type === 'ticket_status')).toBe(true);
    const mine = await body(await as(bob).get(`/support/tickets/${ticket.id}`));
    expect(mine.can.rate).toBe(true);
    const rated = await body(
      await as(bob).post(`/support/tickets/${ticket.id}/rating`, { rating: 5, comment: 'Great' }),
    );
    expect(rated.csat_rating).toBe(5);
    // Close, reopen, close again.
    expect((await body(await as(bob).post(`/support/tickets/${ticket.id}/close`))).status).toBe('closed');
    expect((await as(bob).post(`/support/tickets/${ticket.id}/messages`, { body: 'hi' })).status).toBe(409);
    expect((await body(await as(bob).post(`/support/tickets/${ticket.id}/reopen`))).status).toBe('open');
    expect((await body(await as(bob).post(`/support/tickets/${ticket.id}/close`))).status).toBe('closed');
    // CSAT off → no rating.
    await console_(lead).patch('/platform/support/settings', { csat: { enabled: false } });
    expect((await as(bob).post(`/support/tickets/${ticket.id}/rating`, { rating: 4 })).status).toBe(403);
    await console_(lead).patch('/platform/support/settings', { csat: { enabled: true } });
    // Reports count it.
    const report = await body(await console_(agent).get('/platform/support/reports?days=30'));
    expect(report.created).toBeGreaterThanOrEqual(2);
    expect(report.csat.count).toBe(1);
    expect(report.csat.avg).toBe(5);
    expect(report.first_response.count).toBeGreaterThanOrEqual(1);
  });

  it('guests and people inside by a support grant cannot use tickets', async () => {
    await as(admin).post('/users/invite', { emails: ['guest@client.test'], role: 'guest' });
    const guest = await join('guest@client.test');
    expect((await as(guest).get('/support/tickets')).status).toBe(403);
  });
});

describe('access from a ticket: request → one-click approve → grant → revoked on solve', () => {
  it('runs end to end, audited with the ticket', async () => {
    const tk = await open(bob, { subject: 'Automation fails' });
    // Without a grant the agent sees nothing of the account.
    expect((await as(agent).get('/boards')).status).toBe(404);
    // Ask (defaults: view, 4 hours).
    const asked = await body(
      await console_(agent).post(`/platform/support/tickets/${tk.id}/access-requests`, {
        reason: 'Check the automation',
      }),
    );
    const req = (asked.access_requests as Json[])[0]!;
    expect(req).toMatchObject({ mode: 'view', duration_hours: 4, status: 'pending' });
    expect(asked.access_options.durations_hours).toContain(4);
    // Every admin: a bell notification and an email with "approve".
    const bell = await body(await as(admin).get('/me/notifications'));
    expect((bell.data as Json[]).some((n) => n.type === 'ticket_access_request' && n.ticket.id === tk.id)).toBe(true);
    expect(mailsTo('admin@acme.test').at(-1)!.text).toContain(`approve=${req.id}`);
    // A member cannot approve; another account's admin cannot see it.
    expect((await as(bob).post(`/support/access-requests/${req.id}/approve`)).status).toBe(403);
    expect((await as(otherAdmin, otherId).post(`/support/access-requests/${req.id}/approve`)).status).toBe(404);
    // One click.
    const approved = await body(await as(admin).post(`/support/access-requests/${req.id}/approve`));
    const done = (approved.access_requests as Json[])[0]!;
    expect(done.status).toBe('approved');
    expect(done.grant_status).toBe('active');
    const [grant] = await t.db.select().from(supportAccessGrants).where(eq(supportAccessGrants.id, done.grant_id));
    expect(grant).toMatchObject({
      ticketId: tk.id,
      granteeKind: 'email',
      grantedToEmail: 'agent@support.test',
      scope: 'read',
    });
    expect(mailsTo('agent@support.test').at(-1)!.text).toContain(`ticket=${tk.id}`);
    // The agent is in (view), the banner knows the ticket, writes are refused; reads are audited with the ticket.
    expect((await as(agent).get('/boards')).status).toBe(200);
    const me = await body(await as(agent).get('/auth/me'));
    expect(me.account.support).toMatchObject({ mode: 'view', ticket_id: tk.id, ticket_number: tk.number });
    expect((await as(agent).post('/boards', { name: 'x' })).status).toBe(405);
    // Even under a grant: no ticket routes (approving their own requests).
    expect((await as(agent).get('/support/tickets')).status).toBe(403);
    const views = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'support.view')));
    expect(views.some((v) => (v.payload as Json).ticket_id === tk.id)).toBe(true);
    const granted = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'support.granted')));
    expect(granted.some((g) => (g.payload as Json).ticket_number === tk.number)).toBe(true);
    // Solving the ticket revokes the grant at once.
    await console_(agent).patch(`/platform/support/tickets/${tk.id}`, { status: 'solved' });
    expect((await as(agent).get('/boards')).status).toBe(404);
    const revoked = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'support.revoked')));
    expect(revoked.some((r) => (r.payload as Json).ticket_id === tk.id && (r.payload as Json).via === 'ticket')).toBe(
      true,
    );
    const after = await body(await as(admin).get(`/support/tickets/${tk.id}`));
    expect((after.access_requests as Json[])[0]!.grant_status).toBe('revoked');
    // A closed ticket takes no new requests; a pending one ends with the ticket.
    expect(
      (await console_(agent).post(`/platform/support/tickets/${tk.id}/access-requests`, { reason: 'again' })).status,
    ).toBe(409);
  });

  it('a decline is told to the agent; edit needs the account to allow it; durations follow the grant rules', async () => {
    const tk = await open(bob, { subject: 'Another one' });
    expect(
      (await console_(agent).post(`/platform/support/tickets/${tk.id}/access-requests`, { reason: 'x', mode: 'edit' }))
        .status,
    ).toBe(403);
    expect(
      (
        await console_(agent).post(`/platform/support/tickets/${tk.id}/access-requests`, {
          reason: 'x',
          duration_hours: 3,
        })
      ).status,
    ).toBe(422);
    const asked = await body(
      await console_(agent).post(`/platform/support/tickets/${tk.id}/access-requests`, { reason: 'Look' }),
    );
    const req = (asked.access_requests as Json[])[0]!;
    const declined = await body(await as(admin).post(`/support/access-requests/${req.id}/decline`));
    expect((declined.access_requests as Json[])[0]!.status).toBe('declined');
    expect((await as(admin).post(`/support/access-requests/${req.id}/approve`)).status).toBe(409);
    // A pending request ends when the customer closes the ticket.
    const again = await body(
      await console_(agent).post(`/platform/support/tickets/${tk.id}/access-requests`, { reason: 'Look again' }),
    );
    const pending = (again.access_requests as Json[]).find((r) => r.status === 'pending')!;
    await as(bob).post(`/support/tickets/${tk.id}/close`);
    expect((await as(admin).post(`/support/access-requests/${pending.id}/approve`)).status).toBe(409);
  });
});

describe('SLA timers', () => {
  it('targets per priority (business hours or around the clock), breach filters and one alert per breach', async () => {
    await console_(lead).put('/platform/support/sla', {
      policies: [{ priority: 'urgent', first_response_minutes: 30, resolution_minutes: 240, business_hours: false }],
    });
    const before = Date.now();
    const tk = await open(bob, { subject: 'Down', priority: 'urgent' });
    const view = await body(await console_(agent).get(`/platform/support/tickets/${tk.id}`));
    const due = Date.parse(view.sla.first_response_due_at);
    expect(due - before).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect(due - before).toBeLessThan(31 * 60_000);
    // Not breached yet; then the deadline passes.
    expect(
      ((await body(await console_(agent).get('/platform/support/tickets?breached=any'))).data as Json[]).some(
        (x) => x.id === tk.id,
      ),
    ).toBe(false);
    await t.db
      .update(supportTickets)
      .set({ firstResponseDueAt: new Date(Date.now() - 60_000) })
      .where(eq(supportTickets.id, tk.id));
    const breached = await body(await console_(agent).get('/platform/support/tickets?breached=first_response'));
    const row = (breached.data as Json[]).find((x) => x.id === tk.id)!;
    expect(row.sla.first_response_breached).toBe(true);
    // The worker's sweep emails the leads / owner once (the ticket is unassigned), and marks it.
    const leadMails = mailsTo('lead@support.test').length;
    const sent = await alertSlaBreaches(t.pg as unknown as SqlClient, { mailer: t.mailer, appUrl: WEB_ORIGIN });
    expect(sent).toBeGreaterThan(0);
    expect(mailsTo('lead@support.test').length).toBe(leadMails + 1);
    expect(await alertSlaBreaches(t.pg as unknown as SqlClient, { mailer: t.mailer, appUrl: WEB_ORIGIN })).toBe(0);
  });

  it('a new priority takes its targets', async () => {
    const tk = await open(bob, { subject: 'Slow', priority: 'low' });
    const low = await body(await console_(agent).get(`/platform/support/tickets/${tk.id}`));
    const high = await body(await console_(agent).patch(`/platform/support/tickets/${tk.id}`, { priority: 'urgent' }));
    expect(Date.parse(high.sla.first_response_due_at)).toBeLessThan(Date.parse(low.sla.first_response_due_at));
    expect((high.events as Json[]).some((e) => e.type === 'priority')).toBe(true);
  });
});

describe('the console: assignment, tags, canned replies', () => {
  it('assigns, tags and filters', async () => {
    const tk = await open(bob, { subject: 'Tag me' });
    const cfg = await body(await console_(lead).post('/platform/support/tags', { name: 'bug', color: '#a3413f' }));
    const tag = (cfg.tags as Json[]).find((x) => x.name === 'bug')!;
    expect((await console_(lead).post('/platform/support/tags', { name: 'BUG' })).status).toBe(409);
    const agentId = (cfg.agents as Json[]).find((a) => a.role === 'agent')!.id;
    const res = await body(
      await console_(lead).patch(`/platform/support/tickets/${tk.id}`, { assignee_id: agentId, tag_ids: [tag.id] }),
    );
    expect(res.assignee.id).toBe(agentId);
    expect(res.tags[0].name).toBe('bug');
    const mine = await body(await console_(agent).get(`/platform/support/tickets?assignee=me&tag_id=${tag.id}`));
    expect((mine.data as Json[]).map((x) => x.id)).toContain(tk.id);
    // Only staff can be assigned.
    const bobId = (await body(await console_(bob).get('/auth/me'))).user.id;
    expect((await console_(lead).patch(`/platform/support/tickets/${tk.id}`, { assignee_id: bobId })).status).toBe(422);
    const canned = await body(
      await console_(lead).post('/platform/support/canned-replies', { title: 'Cache', body: 'Please clear the cache' }),
    );
    expect((canned.canned as Json[]).some((c) => c.title === 'Cache')).toBe(true);
    expect((await console_(agent).post('/platform/support/canned-replies', { title: 'x', body: 'y' })).status).toBe(
      403,
    );
  });
});
