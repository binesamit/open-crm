// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import {
  activityLog,
  agentRunSteps,
  agentRuns,
  agents,
  auditLog,
  authVerifications,
  docVersions,
  notifications,
  oauthClients,
  oauthGrants,
  tidyRuns,
  trashEntries,
} from '../src/db/schema';
import type { Db } from '../src/db/client';
import { previewTidy, runTidy, scheduledCleaning } from '../src/modules/tidy/cleaning.service';
import { tidyCronItems } from '../src/modules/tidy/jobs';
import { parseCronItems } from 'graphile-worker';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * M8 ד13 — scheduled cleaning: account rules (content rules off by default, technical retention on), a dry run per
 * rule, the run (job or "run now") with its report, CSV and audit row. `now` is passed in instead of waiting.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let ws1: string;
let ws2: string;
let boardA: string;
let boardB: string;
let statusA: string;
let statusB: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);
let db: Db;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const adminActor = async () => {
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const me = users.find((u) => u.email === 'admin@acme.test')!;
  return {
    ctx: { accountId: acmeId, role: 'admin' as const, membershipId: '', account: {} as never },
    user: {
      id: me.user_id,
      email: me.email,
      name: me.name,
      emailVerified: true,
      isPlatformOwner: false,
      locale: 'he',
      timezone: null,
    },
  };
};
const item = async (board: string, name: string) => body(await as(admin).post(`/boards/${board}/items`, { name }));
const setStatus = (itemId: string, column: string, index: number) =>
  as(admin).put(`/items/${itemId}/cells/${column}`, { value: { index } });
const setRules = (rules: Json) => as(admin).put('/admin/tidy/rules', rules);
const audits = (action: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));

beforeAll(async () => {
  t = await createTestContext();
  db = t.db as unknown as Db;
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  ws1 = (await body(await as(admin).get('/workspaces'))).data[0].id;
  ws2 = (await body(await as(admin).post('/workspaces', { name: 'Two' }))).id;
  boardA = (await body(await as(admin).post('/boards', { name: 'Board A', workspace_id: ws1 }))).id;
  boardB = (await body(await as(admin).post('/boards', { name: 'Board B', workspace_id: ws2 }))).id;
  statusA = (await body(await as(admin).post(`/boards/${boardA}/columns`, { title: 'Status', type: 'status' }))).id;
  statusB = (await body(await as(admin).post(`/boards/${boardB}/columns`, { title: 'Status', type: 'status' }))).id;
  // Label 1 = "הושלם" (is_done), 0 = "בתהליך".
  const doneA = await item(boardA, 'done in A');
  await setStatus(doneA.id, statusA, 1);
  const workingA = await item(boardA, 'working in A');
  await setStatus(workingA.id, statusA, 0);
  await item(boardA, 'no status in A');
  const doneB = await item(boardB, 'done in B');
  await setStatus(doneB.id, statusB, 1);
});
afterAll(() => t.close());

describe('the rules', () => {
  it('content rules are off by default; technical retention is on; admins only', async () => {
    const res = await body(await as(admin).get('/admin/tidy/rules'));
    expect(res.rules.archive_done_items).toEqual({ enabled: false, days: 30, exclude_workspace_ids: [] });
    expect(res.rules.empty_trash.enabled).toBe(false);
    expect(res.rules.notifications_retention.enabled).toBe(false);
    expect(res.rules.activity_retention.enabled).toBe(false);
    expect(res.rules.archive_idle_boards.enabled).toBe(false);
    expect(res.rules.doc_auto_versions).toMatchObject({ enabled: true, days: 90 });
    expect(res.rules.agent_run_logs).toMatchObject({ enabled: true, days: 90 });
    expect(res.rules.expired_oauth.enabled).toBe(true);
    expect(res.last_run).toBeNull();
    expect((await as(bob).get('/admin/tidy/rules')).status).toBe(403);
    expect((await as(bob).post('/admin/tidy/preview', {})).status).toBe(403);
  });

  it('only what is sent changes; days are checked per rule; audited', async () => {
    expect((await setRules({ empty_trash: { days: 40 } })).status).toBe(400);
    expect((await setRules({ activity_retention: { days: 30 } })).status).toBe(400);
    const res = await setRules({ archive_done_items: { enabled: true, days: 14 } });
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(s.rules.archive_done_items).toEqual({ enabled: true, days: 14, exclude_workspace_ids: [] });
    expect(s.rules.doc_auto_versions.enabled).toBe(true);
    const rows = await audits('tidy.rules_changed');
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as Json).rules).toEqual(['archive_done_items']);
  });
});

describe('archive_done_items', () => {
  it('dry run: only "done" items unchanged that long, all workspaces unless excluded; nothing changes', async () => {
    const a = await adminActor();
    // Today nothing is 14 days old.
    expect(
      (await body(await as(admin).post('/admin/tidy/preview', { rules: ['archive_done_items'] }))).results,
    ).toEqual([{ rule: 'archive_done_items', count: 0 }]);
    const p = await previewTidy(db, a, { only: ['archive_done_items'], now: later(20) });
    expect(p.results).toEqual([{ rule: 'archive_done_items', count: 2 }]);
    expect(p.samples.map((s) => s.name).sort()).toEqual(['done in A', 'done in B']);
    await setRules({ archive_done_items: { exclude_workspace_ids: [ws2] } });
    const q = await previewTidy(db, a, { only: ['archive_done_items'], now: later(20) });
    expect(q.samples.map((s) => s.name)).toEqual(['done in A']);
    // Nothing archived by a dry run.
    expect((await body(await as(admin).get('/archive'))).data).toHaveLength(0);
  });

  it('a run archives them as `system`, restorable from the archive; the report, CSV and audit row', async () => {
    const run = await runTidy({ db }, acmeId, { trigger: 'schedule', now: later(20) });
    expect(run!.status).toBe('succeeded');
    expect(run!.results.find((r) => r.rule === 'archive_done_items')).toEqual({ rule: 'archive_done_items', count: 1 });
    const archived = (await body(await as(admin).get('/archive'))).data as Json[];
    expect(archived.map((e) => e.name)).toEqual(['done in A']);
    const ev = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'item.archived')));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actorType).toBe('system');
    // The admin who set the rules is who it is recorded under.
    const a = await adminActor();
    expect(ev[0]!.actorId).toBe(a.user.id);
    expect((await as(admin).post(`/archive/item/${archived[0]!.id}/restore`)).status).toBe(200);

    const settings = await body(await as(admin).get('/admin/tidy/rules'));
    expect(settings.last_run).toMatchObject({ id: run!.id, trigger: 'schedule', status: 'succeeded' });
    const runs = (await body(await as(admin).get('/admin/tidy/runs'))).data;
    expect(runs[0].id).toBe(run!.id);
    const csv = await (await as(admin).get(`/admin/tidy/runs/${run!.id}/export.csv`)).text();
    expect(csv).toContain('archive_done_items,item');
    expect(csv).toContain('done in A');
    expect((await as(bob).get(`/admin/tidy/runs/${run!.id}/export.csv`)).status).toBe(403);
    const rows = await audits('tidy.run');
    expect(rows.at(-1)).toMatchObject({ targetId: run!.id, actorId: null });
  });
});

describe('empty_trash', () => {
  it('dry run counts trash older than N days; a run makes them due for the hourly purge', async () => {
    const it1 = await item(boardA, 'thrown away');
    await as(admin).del(`/items/${it1.id}`);
    const a = await adminActor();
    expect((await previewTidy(db, a, { only: ['empty_trash'], now: later(3) })).results[0]!.count).toBe(0);
    const p = await previewTidy(db, a, { only: ['empty_trash'], now: later(10) });
    expect(p.results[0]!.count).toBe(1);
    expect(p.samples[0]).toMatchObject({ rule: 'empty_trash', name: 'thrown away' });
    await setRules({ archive_done_items: { enabled: false }, empty_trash: { enabled: true, days: 7 } });
    const run = await runTidy({ db }, acmeId, { trigger: 'schedule', now: later(10) });
    expect(run!.results.find((r) => r.rule === 'empty_trash')!.count).toBe(1);
    const [entry] = await db.select().from(trashEntries).where(eq(trashEntries.objectName, 'thrown away'));
    expect(entry!.purgeAfter.getTime()).toBeLessThanOrEqual(Date.now());
    await setRules({ empty_trash: { enabled: false } });
  });
});

describe('retention rules', () => {
  it('notifications: older than N days go (dry run first)', async () => {
    const users = (await body(await as(admin).get('/users'))).data as Json[];
    const bobId = users.find((u) => u.email === 'bob@acme.test')!.user_id;
    await db.insert(notifications).values({
      id: newId(),
      accountId: acmeId,
      userId: bobId,
      type: 'mention',
      createdAt: new Date(Date.now() - 400 * DAY),
    });
    const a = await adminActor();
    expect((await previewTidy(db, a, { only: ['notifications_retention'] })).results[0]!.count).toBe(1);
    await setRules({ notifications_retention: { enabled: true, days: 180 } });
    const run = await runTidy({ db }, acmeId, { trigger: 'manual', actorId: a.user.id });
    expect(run!.results.find((r) => r.rule === 'notifications_retention')!.count).toBe(1);
    expect((await previewTidy(db, a, { only: ['notifications_retention'] })).results[0]!.count).toBe(0);
    await setRules({ notifications_retention: { enabled: false } });
  });

  it('doc automatic versions: older than N days go; named versions stay', async () => {
    const doc = await body(await as(admin).post(`/workspaces/${ws1}/docs`, { name: 'Spec' }));
    const old = new Date(Date.now() - 200 * DAY);
    await db.insert(docVersions).values([
      { id: newId(), docId: doc.id, accountId: acmeId, ydoc: Buffer.from([0, 0]), auto: true, createdAt: old },
      {
        id: newId(),
        docId: doc.id,
        accountId: acmeId,
        ydoc: Buffer.from([0, 0]),
        auto: false,
        label: 'v1',
        createdAt: old,
      },
    ]);
    const a = await adminActor();
    expect((await previewTidy(db, a, { only: ['doc_auto_versions'] })).results[0]!.count).toBe(1);
    await runTidy({ db }, acmeId, { trigger: 'schedule' });
    const left = await db.select().from(docVersions).where(eq(docVersions.docId, doc.id));
    expect(left.map((v) => v.label)).toEqual(['v1']);
  });

  it('agent run logs: the steps of runs finished long ago go; the run stays', async () => {
    const a = await adminActor();
    const agentId = newId();
    const runId = newId();
    await db.insert(agents).values({ id: agentId, accountId: acmeId, userId: a.user.id, name: 'Bot', model: 'x' });
    await db.insert(agentRuns).values({
      id: runId,
      accountId: acmeId,
      agentId,
      status: 'succeeded',
      finishedAt: new Date(Date.now() - 100 * DAY),
    });
    await db.insert(agentRunSteps).values([
      { id: newId(), accountId: acmeId, runId, seq: 1, kind: 'model' },
      { id: newId(), accountId: acmeId, runId, seq: 2, kind: 'tool' },
    ]);
    expect((await previewTidy(db, a, { only: ['agent_run_logs'] })).results[0]!.count).toBe(2);
    await runTidy({ db }, acmeId, { trigger: 'schedule' });
    expect(await db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId))).toHaveLength(0);
    expect(await db.select().from(agentRuns).where(eq(agentRuns.id, runId))).toHaveLength(1);
  });

  it('expired OAuth codes and tokens of the account; the job also clears ownerless requests and old verifications', async () => {
    const clientPk = newId();
    await db.insert(oauthClients).values({
      id: clientPk,
      clientId: 'https://client.example/meta.json',
      kind: 'cimd',
      clientName: 'Client',
      redirectUris: ['https://client.example/cb'],
    });
    const grant = (accountId: string | null, expiresAt: Date) => ({
      id: newId(),
      clientPk,
      redirectUri: 'https://client.example/cb',
      state: 's',
      codeChallenge: 'c',
      requestedScopes: ['boards:read'],
      resource: 'https://app.example/mcp',
      accountId,
      expiresAt,
    });
    await db
      .insert(oauthGrants)
      .values([
        grant(acmeId, new Date(Date.now() - 60 * DAY)),
        grant(acmeId, later(1)),
        grant(null, new Date(Date.now() - 2 * DAY)),
      ]);
    await db.insert(authVerifications).values({
      id: newId(),
      identifier: 'trust-device-old',
      value: 'x',
      expiresAt: new Date(Date.now() - 3 * DAY),
    });
    const a = await adminActor();
    expect((await previewTidy(db, a, { only: ['expired_oauth'] })).results[0]!.count).toBe(1);
    const out = await scheduledCleaning({ db });
    expect(out.runs).toBeGreaterThan(0);
    expect(out.oauth_requests).toBe(1);
    expect(out.verifications).toBeGreaterThan(0);
    const left = await db.select().from(oauthGrants).where(eq(oauthGrants.clientPk, clientPk));
    expect(left).toHaveLength(1);
    expect(left[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('activity: events older than N days go (off by default; dry run first)', async () => {
    const a = await adminActor();
    const all = (await previewTidy(db, a, { only: ['activity_retention'], now: later(400) })).results[0]!.count;
    expect(all).toBeGreaterThan(0);
    expect((await previewTidy(db, a, { only: ['activity_retention'] })).results[0]!.count).toBe(0);
    await setRules({ activity_retention: { enabled: true, days: 365 } });
    await runTidy({ db }, acmeId, { trigger: 'schedule', now: later(400) });
    const left = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), sql`${activityLog.createdAt} < now() - interval '1 minute'`));
    expect(left[0]!.n).toBe(0);
    await setRules({ activity_retention: { enabled: false } });
  });
});

describe('archive_idle_boards', () => {
  it('boards unchanged that long are archived — never one without an active owner', async () => {
    // Board B loses its owners (nobody active owns it): left for an admin to hand over.
    await t.db.execute(sql`delete from board_members where board_id = ${boardB}`);
    await setRules({ archive_idle_boards: { enabled: true, days: 180 } });
    const a = await adminActor();
    const p = await previewTidy(db, a, { only: ['archive_idle_boards'], now: later(200) });
    const names = p.samples.map((s) => s.name);
    expect(names).toContain('Board A');
    expect(names).not.toContain('Board B');
    await runTidy({ db }, acmeId, { trigger: 'schedule', now: later(200) });
    const archived = (await body(await as(admin).get('/archive'))).data as Json[];
    expect(archived.some((e) => e.type === 'board' && e.name === 'Board A')).toBe(true);
    expect(archived.some((e) => e.name === 'Board B')).toBe(false);
  });
});

describe('the job', () => {
  it('runs daily (the cron item parses); "run now" needs a rule on; every run is a row', async () => {
    expect(() => parseCronItems(tidyCronItems)).not.toThrow();
    const res = await as(admin).post('/admin/tidy/run');
    expect(res.status).toBe(200);
    expect((await body(res)).trigger).toBe('manual');
    const rows = await db.select().from(tidyRuns).where(eq(tidyRuns.accountId, acmeId));
    expect(rows.length).toBeGreaterThan(3);
    // With every rule off there is nothing to run.
    await setRules({
      archive_idle_boards: { enabled: false },
      doc_auto_versions: { enabled: false },
      agent_run_logs: { enabled: false },
      expired_oauth: { enabled: false },
    });
    expect((await as(admin).post('/admin/tidy/run')).status).toBe(409);
  });
});
