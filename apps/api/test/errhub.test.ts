// SPDX-License-Identifier: AGPL-3.0-only
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { DEFAULT_PROBLEM_SKIPS } from '@bines/shared';
import type { JobHelpers } from 'graphile-worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  errorAlerts,
  errorEventHours,
  errorEvents,
  notifications,
  supportTicketMessages,
  supportTickets,
} from '../src/db/schema';
import type { Db } from '../src/db/client';
import { errorHandler } from '../src/middleware/error';
import { requestId } from '../src/middleware/request-id';
import { createLogger } from '../src/lib/logger';
import { loadEnv } from '../src/env';
import { runDigests, runInstantAlerts } from '../src/modules/errors/errors.alerts';
import { capturingTasks, recordingErrorHandler } from '../src/modules/errors/errors.capture';
import { maintainErrors } from '../src/modules/errors/errors.jobs';
import { recordAgentRun, recordAiFailure, recordAutomationRun } from '../src/modules/errors/errors.sources';
import { droppedErrors, flushErrors, recordError } from '../src/modules/errors/errors.writer';
import { queueDelivery } from '../src/modules/webhooks/delivery';
import { recordWorkerError } from '../../worker/src/repositories/errors.repo';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Errors & health hub (stages 1–2): the batched writer (dedupe by fingerprint, counts, hours, drop on
 * overflow), redaction (no addresses, secrets, values), each source, problem skips vs normal skips, alert rules
 * (threshold per window, dedupe, mutes, digest, account admins off by default), permissions (an account sees only
 * its own; support needs a grant for the account's data), auto-resolve / reopen and retention.
 */
let t: TestContext;
let db: Db;
let owner: string;
let admin: string;
let otherAdmin: string;
let bob: string;
let agent: string;
let lead: string;
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
const hub = (cookie: string) => t.api(cookie);
const rows = () => db.select().from(errorEvents);
const settings = (cookie: string, patch: Json) => hub(cookie).patch('/platform/errors/settings', patch);
const HOUR = 3_600_000;

beforeAll(async () => {
  t = await createTestContext();
  db = t.db as unknown as Db;
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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await hub(owner).post('/platform/support/staff', { email: 'agent@support.test', role: 'agent' });
  await hub(owner).post('/platform/support/staff', { email: 'lead@support.test', role: 'lead' });
});
afterAll(() => t.close());

beforeEach(async () => {
  await flushErrors(db);
  await db.delete(errorAlerts);
  await db.delete(errorEvents);
});

describe('the batched writer', () => {
  it('never waits: identical errors become one row with a count, distinct ones their own rows, with hourly counts', async () => {
    for (let i = 0; i < 5; i++)
      recordError(db, {
        source: 'automation',
        code: 'column_not_found',
        message: `column 7 missing`,
        accountId: acmeId,
      });
    recordError(db, {
      source: 'automation',
      code: 'column_not_found',
      message: 'column 9 missing',
      accountId: otherId,
    });
    expect(await rows()).toHaveLength(0); // nothing written until the flush
    await flushErrors(db);
    const all = await rows();
    expect(all).toHaveLength(2);
    const acme = all.find((r) => r.accountId === acmeId)!;
    expect(acme.count).toBe(5);
    expect(acme.status).toBe('new');
    expect(acme.severity).toBe('error'); // the source's default severity (settings)
    const hours = await db.select().from(errorEventHours).where(eq(errorEventHours.eventId, acme.id));
    expect(hours.reduce((s, h) => s + h.count, 0)).toBe(5);
    // The same error later adds to the row (numbers in the message do not split it).
    recordError(db, { source: 'automation', code: 'column_not_found', message: 'column 8 missing', accountId: acmeId });
    await flushErrors(db);
    expect((await rows()).find((r) => r.id === acme.id)!.count).toBe(6);
  });

  it('a full queue drops new errors and counts them (recorded as one warning)', async () => {
    expect((await settings(owner, { writer: { max_queue: 10, flush_seconds: 3 } })).status).toBe(200);
    await flushErrors(db); // the writer learns the new size on a flush
    const before = droppedErrors(db);
    for (let i = 0; i < 15; i++)
      recordError(db, {
        source: 'job',
        code: `task_${String.fromCharCode(97 + i)}`,
        links: { job: `t${'x'.repeat(i)}` },
      });
    await flushErrors(db);
    const all = await rows();
    expect(all.filter((r) => r.code.startsWith('task_'))).toHaveLength(10);
    const dropped = all.find((r) => r.code === 'error_writer_dropped')!;
    expect(dropped.count).toBe(5);
    expect(dropped.severity).toBe('warning');
    expect(droppedErrors(db) - before).toBe(5);
    await settings(owner, { writer: { max_queue: 2000, flush_seconds: 3 } });
    await flushErrors(db);
  });

  it('S-96: browser reports fill at most a quarter of the queue — server errors still get in', async () => {
    expect((await settings(owner, { writer: { max_queue: 12, flush_seconds: 3 } })).status).toBe(200);
    await flushErrors(db);
    const before = droppedErrors(db);
    for (let i = 0; i < 6; i++)
      recordError(db, { source: 'client', code: `flood_${String.fromCharCode(97 + i)}`, accountId: acmeId });
    for (let i = 0; i < 3; i++) recordError(db, { source: 'job', code: `real_${String.fromCharCode(97 + i)}` });
    await flushErrors(db);
    const all = await rows();
    expect(all.filter((r) => r.code.startsWith('flood_'))).toHaveLength(3);
    expect(all.filter((r) => r.code.startsWith('real_'))).toHaveLength(3);
    expect(droppedErrors(db) - before).toBe(3);
    await settings(owner, { writer: { max_queue: 2000, flush_seconds: 3 } });
    await flushErrors(db);
  });

  it('redacts: no addresses, secrets, quoted values, phone numbers or query strings are kept', async () => {
    recordError(db, {
      source: 'email',
      code: 'resend_422',
      message:
        'resend: 422 invalid to "Dana Levi" <dana@client.co.il> key sk-ant-api03-abcdefghijklmnop Bearer abcdefghijklmnopqrstuv ' +
        'phone +972 54-123-4567 url https://x.test/cb?token=secret123&email=a@b.c password=hunter2',
      accountId: acmeId,
    });
    await flushErrors(db);
    const [r] = await rows();
    for (const leak of ['dana@', 'Dana Levi', 'sk-ant', 'abcdefghijklmnopqrstuv', '123-4567', 'token=', 'hunter2'])
      expect(r!.message).not.toContain(leak);
    expect(r!.message).toContain('[email]');
    expect(r!.message).toContain('https://x.test/cb');
    expect(r!.message.length).toBeLessThanOrEqual(300);
  });

  it('a source switched off in the settings records nothing', async () => {
    const cfg = await body(await hub(owner).get('/platform/errors/config'));
    await settings(owner, { sources: { ...cfg.settings.sources, sms: { enabled: false, severity: 'error' } } });
    recordError(db, { source: 'sms', code: 'no_credit' });
    await flushErrors(db);
    expect(await rows()).toHaveLength(0);
    await settings(owner, { sources: { ...cfg.settings.sources, sms: { enabled: true, severity: 'error' } } });
  });
});

describe('sources', () => {
  it('automations: failed actions are errors; only problem skips are kept, normal skips never', async () => {
    const run = { accountId: acmeId, automationId: 'A1', boardId: 'B1', runId: 'R1' };
    recordAutomationRun(db, { ...run, status: 'skipped', skipReason: 'conditions' });
    recordAutomationRun(db, { ...run, status: 'skipped', skipReason: 'self_loop' });
    recordAutomationRun(db, {
      ...run,
      status: 'skipped',
      skipReason: 'nothing_to_do',
      actionsLog: [{ index: 0, type: 'notify', status: 'skipped', reason: 'no_recipients' }],
    });
    // Nobody in the people column the message goes to is a normal skip.
    recordAutomationRun(db, {
      ...run,
      status: 'skipped',
      skipReason: 'nothing_to_do',
      actionsLog: [{ index: 0, type: 'notify', status: 'skipped', reason: 'nobody_assigned' }],
    });
    recordAutomationRun(db, { ...run, status: 'skipped', skipReason: 'plan_limit_reached' });
    recordAutomationRun(db, {
      ...run,
      runId: 'R2',
      status: 'partial',
      actionsLog: [
        { index: 0, type: 'set_status', status: 'ok' },
        { index: 1, type: 'move_item', status: 'error', error: 'group_not_found:G9', code: 'not_found' },
      ],
    });
    await flushErrors(db);
    const codes = (await rows()).map((r) => r.code).sort();
    expect(codes).toEqual(['group_not_found', 'no_recipients', 'plan_limit_reached']);
    const skip = (await rows()).find((r) => r.code === 'no_recipients')!;
    expect(skip.severity).toBe('warning');
    expect(skip.links).toMatchObject({ automation_id: 'A1', board_id: 'B1' });
    // A reason the owner adds to the problem list is recorded from then on.
    await settings(owner, { problem_skips: ['no_recipients', 'self_loop'] });
    recordAutomationRun(db, { ...run, status: 'skipped', skipReason: 'self_loop' });
    recordAutomationRun(db, { ...run, status: 'skipped', skipReason: 'plan_limit_reached' });
    await flushErrors(db);
    expect((await rows()).find((r) => r.code === 'self_loop')).toBeDefined();
    expect((await rows()).find((r) => r.code === 'plan_limit_reached')!.count).toBe(1);
    await settings(owner, { problem_skips: [...DEFAULT_PROBLEM_SKIPS] });
  });

  it('agents, AI calls, webhooks, email, SMS, jobs and the worker each record, ids only', async () => {
    recordAgentRun(db, { accountId: acmeId, agentId: 'AG1', runId: 'AR1', error: 'tool_errors' });
    recordAiFailure(db, {
      accountId: acmeId,
      connectionId: 'C1',
      source: 'agent',
      model: 'claude-x',
      err: new Error('401 invalid x-api-key sk-ant-api03-zzzzzzzzzzzzzzzz'),
    });
    // A webhook whose target is gone.
    await queueDelivery(t.deps, {
      accountId: acmeId,
      eventId: 'E1',
      url: null,
      requestBody: { item: { name: 'Secret customer' } },
    } as never);
    // Email and SMS through the app's own senders.
    const send = t.mailer.send;
    t.mailer.send = async () => {
      throw new Error('resend: 422 {"message":"bad to dana@client.co.il"}');
    };
    await expect(t.deps.mailer.send({ to: 'dana@client.co.il', subject: 's', html: 'h', text: 't' })).rejects.toThrow();
    t.mailer.send = send;
    t.sms.state.failNext = 'sms: no_credit';
    await expect(t.deps.sms.send({ to: '0541234567', text: 'hello' })).rejects.toThrow();
    // A background job: recorded on its last attempt only, never with its payload.
    const tasks = capturingTasks(db, {
      'demo.task': async () => {
        throw new Error('boom for client@acme.test');
      },
    });
    const helpers = (attempts: number) => ({ job: { attempts, max_attempts: 3 } }) as unknown as JobHelpers;
    await expect(tasks['demo.task']!({ secret: 'x' }, helpers(1))).rejects.toThrow();
    await expect(tasks['demo.task']!({ secret: 'x' }, helpers(3))).rejects.toThrow();
    await flushErrors(db);
    // The worker writes the same way (at once).
    await recordWorkerError(t.pg as unknown as SqlClient, {
      source: 'email',
      code: 'resend_500',
      message: 'resend: 500 for x@y.z',
    });
    const all = await rows();
    const by = (source: string) => all.filter((r) => r.source === source);
    expect(by('agent')[0]).toMatchObject({ code: 'tool_errors', links: { agent_id: 'AG1', agent_run_id: 'AR1' } });
    expect(by('ai')[0]!.message).not.toContain('sk-ant');
    expect(by('ai')[0]!.links).toEqual({ ai_connection_id: 'C1' });
    expect(by('webhook')[0]).toMatchObject({ code: 'target_gone', severity: 'warning' });
    expect(JSON.stringify(by('webhook')[0])).not.toContain('Secret customer');
    expect(
      by('email')
        .map((r) => r.code)
        .sort(),
    ).toEqual(['resend_422', 'resend_500']);
    expect(JSON.stringify(by('email'))).not.toContain('@client.co.il');
    expect(by('sms')[0]!.code).toBe('no_credit');
    expect(by('job')).toHaveLength(1);
    expect(by('job')[0]!.links).toEqual({ job: 'demo.task' });
    expect(by('job')[0]!.message).not.toContain('client@acme.test');
    expect(JSON.stringify(by('job'))).not.toContain('secret');
  });

  it('code: an unexpected 500 is recorded with its request id; an AppError is not', async () => {
    const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent', BETTER_AUTH_SECRET: 'x'.repeat(40) });
    const app = new Hono();
    app.use('*', requestId() as never);
    app.get('/boom', () => {
      throw new TypeError('cannot read properties of undefined (reading "name")');
    });
    app.onError(recordingErrorHandler(db, errorHandler(createLogger(env))) as never);
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    await flushErrors(db);
    const [r] = await rows();
    expect(r).toMatchObject({ source: 'code', code: 'TypeError', severity: 'critical' });
    expect(r!.links.request_id).toBeTruthy();
    // GlitchTip link-out once the owner set it.
    await settings(owner, { glitchtip: { base_url: 'https://glitch.example.com', organization: 'bines' } });
    const d = await body(await hub(owner).get(`/platform/errors/${r!.id}`));
    expect(d.glitchtip_url).toBe(
      `https://glitch.example.com/bines/issues?query=${encodeURIComponent(`request_id:${r!.links.request_id}`)}`,
    );
  });

  it('browser errors: automatic, scrubbed, the page ids folded, limited per person; off when the owner says so', async () => {
    await settings(owner, { client: { enabled: true, sample_rate: 0.5, per_user_per_hour: 2 } });
    const send = (message: string) =>
      as(bob).post('/client-errors', {
        errors: [{ message, source: '/a/acme/b/01ARZ3NDEKTSV4RRFFQ69G5FAV', area: 'window' }],
        account_slug: 'acme',
      });
    const first = await body(await send('TypeError: x is undefined for bob@acme.test'));
    expect(first).toEqual({ accepted: 1, enabled: true, sample_rate: 0.5 });
    await send('TypeError: y');
    expect((await body(await send('TypeError: z'))).accepted).toBe(0); // the hour's limit
    await flushErrors(db);
    const client = (await rows()).filter((r) => r.source === 'client');
    expect(client).toHaveLength(2);
    expect(client[0]!.accountId).toBe(acmeId);
    expect(client[0]!.links.page).toBe('/a/acme/b/:id');
    expect(JSON.stringify(client)).not.toContain('bob@acme.test');
    // Another account's slug is not kept (bob is not in it).
    await settings(owner, { client: { enabled: true, sample_rate: 0.5, per_user_per_hour: 20 } });
    await as(otherAdmin, otherId).post('/client-errors', {
      errors: [{ message: 'Error: other' }],
      account_slug: 'acme',
    });
    await flushErrors(db);
    expect((await rows()).find((r) => r.message.includes('other'))!.accountId).toBeNull();
    await settings(owner, { client: { enabled: false, sample_rate: 0.5, per_user_per_hour: 20 } });
    expect(await body(await send('Error: off'))).toEqual({ accepted: 0, enabled: false, sample_rate: 0 });
    await settings(owner, { client: { enabled: true, sample_rate: 0.25, per_user_per_hour: 20 } });
    // Never with a token, never without a session.
    expect((await t.api(undefined).post('/client-errors', { errors: [{ message: 'x' }] })).status).toBe(401);
  });
});

describe('permissions', () => {
  it('the console is the owner’s and support staff’s; settings are leads’ and the owner’s', async () => {
    recordError(db, { source: 'automation', code: 'x_failed', accountId: acmeId });
    await flushErrors(db);
    expect((await hub(bob).get('/platform/errors')).status).toBe(404);
    expect((await hub(admin).get('/platform/errors')).status).toBe(404);
    const list = await body(await hub(agent).get('/platform/errors'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].account).toMatchObject({ id: acmeId, slug: 'acme' });
    expect((await settings(agent, { auto_resolve_hours: 10 })).status).toBe(403);
    expect((await settings(lead, { auto_resolve_hours: 72 })).status).toBe(200);
    expect((await body(await hub(agent).get('/platform/errors/config'))).can_edit_settings).toBe(false);
  });

  it('an account admin sees only the account’s own errors, without support’s fields; members do not', async () => {
    recordError(db, { source: 'automation', code: 'acme_failed', accountId: acmeId, links: { board_id: 'B1' } });
    recordError(db, { source: 'automation', code: 'other_failed', accountId: otherId });
    recordError(db, { source: 'code', code: 'TypeError', accountId: acmeId }); // not a visible source by default
    await flushErrors(db);
    const id = (await rows()).find((r) => r.code === 'acme_failed')!.id;
    await hub(owner).patch(`/platform/errors/${id}`, { note: 'internal note', status: 'acknowledged' });
    const health = await body(await as(admin).get('/account-health'));
    expect(health.enabled).toBe(true);
    expect(health.data.map((e: Json) => e.code)).toEqual(['acme_failed']);
    expect(Object.keys(health.data[0]).sort()).toEqual(
      [
        'code',
        'count',
        'first_seen_at',
        'id',
        'last_seen_at',
        'links',
        'message',
        'severity',
        'source',
        'state',
      ].sort(),
    );
    expect(JSON.stringify(health)).not.toContain('internal note');
    expect((await body(await as(otherAdmin, otherId).get('/account-health'))).data.map((e: Json) => e.code)).toEqual([
      'other_failed',
    ]);
    expect((await as(bob).get('/account-health')).status).toBe(403);
    // The owner can turn the page off.
    await settings(owner, {
      account_page: {
        enabled: false,
        sources: ['automation'],
        admin_alerts: { enabled: false, min_severity: 'error', threshold: 5, window_hours: 1 },
      },
    });
    expect(await body(await as(admin).get('/account-health'))).toMatchObject({ enabled: false, data: [] });
    await settings(owner, {
      account_page: {
        enabled: true,
        sources: ['automation', 'agent', 'ai', 'flow', 'webhook', 'email', 'sms', 'import', 'extension'],
        admin_alerts: { enabled: false, min_severity: 'error', threshold: 5, window_hours: 1 },
      },
    });
  });

  it("support sees metadata only; the account's data (trace, link in) needs an active grant", async () => {
    recordError(db, {
      source: 'automation',
      code: 'acme_failed',
      accountId: acmeId,
      links: { board_id: 'B1', run_id: 'R404', automation_id: 'A1' },
    });
    await flushErrors(db);
    const [r] = await rows();
    const before = await body(await hub(owner).get(`/platform/errors/${r!.id}`));
    expect(before.access).toEqual({ granted: false, mode: null });
    expect(before.trace).toBeNull();
    expect(before.open_path).toBeNull();
    expect(before.event.links).toMatchObject({ board_id: 'B1' });
    // The account's admin lets platform support in.
    expect((await as(admin).post('/support-access', { duration_hours: 24, reason: 'errors' })).status).toBe(201);
    const after = await body(await hub(owner).get(`/platform/errors/${r!.id}`));
    expect(after.access).toEqual({ granted: true, mode: 'view' });
    expect(after.open_path).toBe('/a/acme/b/B1');
    for (const g of (await body(await as(admin).get('/support-access'))).grants as Json[])
      await as(admin).del(`/support-access/${g.id}`);
    expect((await body(await hub(owner).get(`/platform/errors/${r!.id}`))).access.granted).toBe(false);
  });
});

describe('the workflow', () => {
  it('acknowledge, assign (support only), mute, resolve, and the views', async () => {
    for (let i = 0; i < 12; i++) recordError(db, { source: 'flow', code: 'flow_run_failed', accountId: acmeId });
    recordError(db, {
      source: 'flow',
      code: 'flow_platform_unreachable',
      accountId: acmeId,
      at: new Date(Date.now() - 5 * HOUR),
    });
    await flushErrors(db);
    const id = (await rows()).find((r) => r.code === 'flow_run_failed')!.id;
    const agentId = (await body(await hub(owner).get('/platform/errors/config'))).agents.find(
      (a: Json) => a.email === 'agent@support.test',
    ).id;
    const bobId = (await body(await as(bob).get('/auth/me'))).user.id;
    expect((await hub(owner).patch(`/platform/errors/${id}`, { assignee_id: bobId })).status).toBe(422);
    const assigned = await body(await hub(owner).patch(`/platform/errors/${id}`, { assignee_id: agentId }));
    expect(assigned.event.status).toBe('acknowledged'); // taking it acknowledges it
    expect((await body(await hub(agent).get('/platform/errors?assignee=me'))).data.map((e: Json) => e.id)).toEqual([
      id,
    ]);
    const until = new Date(Date.now() + 8 * HOUR).toISOString();
    expect(
      (await body(await hub(agent).patch(`/platform/errors/${id}`, { muted_until: until }))).event.muted_until,
    ).toBe(until);
    // Views: recurring = most frequent first; spikes = the last hour far above the day's average.
    const recurring = await body(await hub(owner).get('/platform/errors?view=recurring'));
    expect(recurring.data[0].id).toBe(id);
    const spikes = await body(await hub(owner).get('/platform/errors?view=spikes'));
    expect(spikes.data.map((e: Json) => e.id)).toEqual([id]);
    const accounts = await body(await hub(owner).get('/platform/errors/accounts'));
    expect(accounts.data.find((a: Json) => a.account?.id === acmeId)).toMatchObject({ open: 2 });
    const resolved = await body(await hub(owner).patch(`/platform/errors/${id}`, { status: 'resolved' }));
    expect(resolved.event.resolved_at).toBeTruthy();
  });

  it('a ticket from an error (an internal note, the error linked), and attaching to a ticket of the same account only', async () => {
    recordError(db, { source: 'webhook', code: 'http_500', accountId: acmeId, message: 'http_500' });
    recordError(db, { source: 'webhook', code: 'http_502', accountId: otherId, message: 'http_502' });
    await flushErrors(db);
    const acmeErr = (await rows()).find((r) => r.accountId === acmeId)!;
    const otherErr = (await rows()).find((r) => r.accountId === otherId)!;
    const res = await body(
      await hub(agent).post(`/platform/errors/${acmeErr.id}/ticket`, { subject: 'Webhook failing' }),
    );
    expect(res.ticket.number).toBeGreaterThan(0);
    expect(res.detail.event.ticket).toEqual({ id: res.ticket.id, number: res.ticket.number });
    const ticket = (await db.select().from(supportTickets).where(eq(supportTickets.id, res.ticket.id)))[0]!;
    expect(ticket.accountId).toBe(acmeId);
    const msgs = await db.select().from(supportTicketMessages).where(eq(supportTicketMessages.ticketId, ticket.id));
    expect(msgs.every((m) => m.visibility === 'internal')).toBe(true);
    expect(msgs[0]!.body).toContain(`/owner?section=errors&error=${acmeErr.id}`);
    expect((await hub(agent).post(`/platform/errors/${acmeErr.id}/ticket`, {})).status).toBe(409);
    // The other account's error cannot join Acme's ticket.
    const attach = await hub(agent).post(`/platform/errors/${otherErr.id}/attach`, { ticket_number: ticket.number });
    expect(attach.status).toBe(409);
    expect((await body(attach)).error.message).toBe('ticket_other_account');
  });

  it('auto-resolve after the quiet time; a new occurrence reopens it; ignored stays ignored; retention per severity', async () => {
    const now = Date.now();
    recordError(db, { source: 'agent', code: 'quiet_one', accountId: acmeId, at: new Date(now - 80 * HOUR) });
    recordError(db, { source: 'agent', code: 'ignored_one', accountId: acmeId, at: new Date(now - 80 * HOUR) });
    recordError(db, { source: 'client', code: 'old_info', severity: 'info', at: new Date(now - 20 * 24 * HOUR) });
    recordError(db, { source: 'agent', code: 'old_error', at: new Date(now - 20 * 24 * HOUR) });
    await flushErrors(db);
    const ignored = (await rows()).find((r) => r.code === 'ignored_one')!;
    await hub(owner).patch(`/platform/errors/${ignored.id}`, { status: 'ignored' });
    const r = await maintainErrors(t.deps, new Date(now));
    expect(r.purged).toBe(1); // info kept 14 days; an error 90
    const after = await rows();
    expect(after.find((x) => x.code === 'old_info')).toBeUndefined();
    expect(after.find((x) => x.code === 'old_error')).toBeDefined();
    const quiet = after.find((x) => x.code === 'quiet_one')!;
    expect(quiet.status).toBe('resolved');
    expect(quiet.resolvedBy).toBeNull();
    expect(after.find((x) => x.code === 'ignored_one')!.status).toBe('ignored');
    recordError(db, { source: 'agent', code: 'quiet_one', accountId: acmeId });
    recordError(db, { source: 'agent', code: 'ignored_one', accountId: acmeId });
    await flushErrors(db);
    const again = await rows();
    expect(again.find((x) => x.code === 'quiet_one')).toMatchObject({ status: 'new', reopenedCount: 1, count: 2 });
    expect(again.find((x) => x.code === 'ignored_one')!.status).toBe('ignored');
  });
});

describe('alerts', () => {
  const ownerEmail = OWNER_EMAIL;
  const mailsTo = (email: string) => t.mailer.sent.filter((m) => m.to === email);

  it('instant rules: critical at once, a spike past its threshold, once per window; mutes keep quiet', async () => {
    const now = new Date();
    recordError(db, { source: 'code', code: 'TypeError', at: now });
    for (let i = 0; i < 19; i++)
      recordError(db, { source: 'flow', code: 'flow_run_failed', accountId: acmeId, at: now });
    await flushErrors(db);
    const before = mailsTo('agent@support.test').length;
    expect(await runInstantAlerts(t.deps, now)).toBe(1); // only the critical one (19 < the spike rule's 20)
    expect(mailsTo('agent@support.test').length).toBe(before + 1); // the whole support team, by default
    expect(mailsTo(ownerEmail).length).toBeGreaterThan(0);
    expect(await runInstantAlerts(t.deps, now)).toBe(0); // dedupe within the window
    recordError(db, { source: 'flow', code: 'flow_run_failed', accountId: acmeId, at: now });
    await flushErrors(db);
    expect(await runInstantAlerts(t.deps, now)).toBe(1); // 20 → the spike rule
    // The console bell: the agent's alerts, unread until read.
    const feed = await body(await hub(agent).get('/platform/errors/alerts'));
    expect(feed.unread).toBe(2);
    expect(feed.data.map((a: Json) => a.rule_id).sort()).toEqual(['critical', 'spike']);
    expect((await body(await hub(agent).post('/platform/errors/alerts/read'))).unread).toBe(0);
    // A mute on the source keeps a new critical quiet.
    const cfg = await body(await hub(owner).get('/platform/errors/config'));
    await settings(owner, {
      alerts: {
        ...cfg.settings.alerts,
        mutes: [
          {
            id: 'm1',
            source: 'code',
            account_id: null,
            text: null,
            until: new Date(now.getTime() + HOUR).toISOString(),
          },
        ],
      },
    });
    recordError(db, { source: 'code', code: 'RangeError', at: now });
    await flushErrors(db);
    expect(await runInstantAlerts(t.deps, now)).toBe(0);
    await settings(owner, { alerts: { ...cfg.settings.alerts, mutes: [] } });
  });

  it('the daily digest goes out once at the digest hour; account admins are alerted only when the owner turns it on', async () => {
    const now = new Date();
    const cfg = await body(await hub(owner).get('/platform/errors/config'));
    await settings(owner, { alerts: { ...cfg.settings.alerts, digest_hour: now.getUTCHours(), timezone: 'UTC' } });
    for (let i = 0; i < 6; i++)
      recordError(db, { source: 'automation', code: 'acme_failed', accountId: acmeId, at: now });
    await flushErrors(db);
    const before = mailsTo('lead@support.test').length;
    expect(await runDigests(t.deps, now)).toBe(1);
    expect(mailsTo('lead@support.test').length).toBe(before + 1);
    expect(await runDigests(t.deps, now)).toBe(0); // once a day
    expect(await runDigests(t.deps, new Date(now.getTime() + 2 * HOUR))).toBe(0); // not the digest hour
    // Account admins: off by default.
    await runInstantAlerts(t.deps, now);
    const adminNotes = () =>
      db
        .select()
        .from(notifications)
        .where(sql`${notifications.type} = 'error_alert' and ${notifications.accountId} = ${acmeId}`);
    expect(await adminNotes()).toHaveLength(0);
    await settings(owner, {
      account_page: {
        ...cfg.settings.account_page,
        admin_alerts: { enabled: true, min_severity: 'error', threshold: 5, window_hours: 1 },
      },
    });
    await runInstantAlerts(t.deps, now);
    const notes = await adminNotes();
    expect(notes).toHaveLength(1); // the one active admin
    expect(String(notes[0]!.payload.excerpt)).toContain('acme_failed');
    await runInstantAlerts(t.deps, now);
    expect(await adminNotes()).toHaveLength(1); // once per window
    await settings(owner, { account_page: cfg.settings.account_page, alerts: cfg.settings.alerts });
  });
});
