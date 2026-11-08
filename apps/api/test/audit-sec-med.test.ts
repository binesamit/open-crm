// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, automationRuns, automations, users } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Audit 2026-10-10, security mediums that need a whole account (the others live with their modules' tests). */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string; // member, owner of his own board
let acmeId: string;
let adminId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const recipe = (message: string) => ({
  trigger: { type: 'item_created' },
  actions: [{ type: 'notify', to: '@owner', message }],
});

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  adminId = users.find((u) => u.email === 'admin@acme.test')!.user_id;
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(bob).post('/boards', { name: 'Bob board', workspace_id: ws }))).id;
});
afterAll(() => t.close());

describe('#5 an automation never runs with rights its owner did not agree to', () => {
  it('handed to an admin: switched off until the admin switches it on; the giver cannot', async () => {
    const auto = await body(
      await as(bob).post(`/boards/${boardId}/automations`, { recipe: recipe('hi'), is_active: true }),
    );
    expect(auto.is_active).toBe(true);
    const moved = await body(await as(bob).patch(`/automations/${auto.id}`, { owner_id: adminId }));
    expect(moved).toMatchObject({ owner_id: adminId, is_active: false, deactivated_reason: 'owner_review' });
    const again = await as(bob).patch(`/automations/${auto.id}`, { is_active: true });
    expect(again.status).toBe(403);
    expect((await body(again)).error.message).toBe('automation_owner_must_activate');
    const on = await body(await as(admin).patch(`/automations/${auto.id}`, { is_active: true }));
    expect(on).toMatchObject({ is_active: true, deactivated_reason: null });
  });

  it("a board owner changing someone else's recipe switches it off for its owner to review", async () => {
    const auto = await body(
      await as(admin).post(`/boards/${boardId}/automations`, { recipe: recipe('by admin'), is_active: true }),
    );
    const edited = await body(await as(bob).patch(`/automations/${auto.id}`, { recipe: recipe('changed by bob') }));
    expect(edited).toMatchObject({ is_active: false, deactivated_reason: 'owner_review' });
    expect((await as(bob).patch(`/automations/${auto.id}`, { is_active: true })).status).toBe(403);
    expect((await body(await as(admin).patch(`/automations/${auto.id}`, { is_active: true }))).is_active).toBe(true);
  });

  it('my own automation: edits and switches stay as before', async () => {
    const auto = await body(
      await as(bob).post(`/boards/${boardId}/automations`, { recipe: recipe('mine'), is_active: true }),
    );
    const edited = await body(await as(bob).patch(`/automations/${auto.id}`, { recipe: recipe('mine, changed') }));
    expect(edited.is_active).toBe(true);
    expect((await body(await as(bob).patch(`/automations/${auto.id}`, { is_active: false }))).is_active).toBe(false);
    expect((await body(await as(bob).patch(`/automations/${auto.id}`, { is_active: true }))).is_active).toBe(true);
  });
});

const seen = new Set<string>();
/** Runs every automation the account's events since the last call trigger (as the worker would). */
const drain = async () => {
  for (let round = 0; round < 10; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.id);
      for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
    }
  }
};
/** A send_email automation inserted directly (email actions are a plan feature), owned by `ownerId`. */
const mailer = async (to: string[], ownerId: string, subject: string) => {
  const id = newId();
  await t.db.insert(automations).values({
    id,
    accountId: acmeId,
    boardId,
    title: subject,
    recipe: {
      trigger: { type: 'item_created' },
      actions: [{ type: 'send_email', to, subject, body_html: 'B' }],
    } as never,
    isActive: true,
    ownerId,
    createdBy: ownerId,
  });
  return id;
};
const mailsWith = (subject: string) => t.mailer.sent.filter((m) => m.subject === subject).map((m) => m.to);
const lastLog = async (automationId: string) => {
  const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
  runs.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id));
  return (runs.at(-1)!.actionsLog as Json[])[0]!;
};

describe('#1 automation email is not an open relay', () => {
  it('a member cannot save a typed external address; an admin can', async () => {
    const action = { type: 'send_email', to: ['someone@outside.test'], subject: 's', body_html: 'b' };
    const refused = await as(bob).post(`/boards/${boardId}/automations`, {
      recipe: { trigger: { type: 'item_created' }, actions: [action] },
    });
    expect(refused.status).toBe(422);
    const issues = (await body(refused)).error.details.issues as Json[];
    expect(issues.some((i) => i.code === 'external_email_admin_only')).toBe(true);
  });

  it('user:<id> of another account and typed addresses of a non-admin owner are never mailed', async () => {
    await t.api(owner).post('/platform/accounts', {
      name: 'Beta',
      slug: 'beta',
      first_admin_email: 'stranger@beta.test',
      template_set: 'empty',
    });
    await join('stranger@beta.test');
    const [stranger] = await t.db.select().from(users).where(eq(users.email, 'stranger@beta.test'));
    const bobId = (await body(await t.api(bob).get('/auth/me'))).user.id as string;
    const byAdmin = await mailer([`user:${stranger!.id}`, `user:${bobId}`, 'partner@outside.test'], adminId, 'M1');
    const byBob = await mailer(['partner2@outside.test', `user:${bobId}`], bobId, 'M2');
    await as(bob).post(`/boards/${boardId}/items`, { name: 'Trigger 1' });
    await drain();
    expect(mailsWith('M1').sort()).toEqual(['bob@acme.test', 'partner@outside.test']);
    expect(mailsWith('M2')).toEqual(['bob@acme.test']);
    expect((await lastLog(byBob)).warnings).toContain('external_email_admin_only');
    for (const id of [byAdmin, byBob])
      await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
  });

  it("the account's daily budget (owner console) caps what automations send", async () => {
    expect((await t.api(owner).patch('/platform/settings', { email: { automation_emails_per_day: 4 } })).status).toBe(
      200,
    );
    // Earlier today: 3 sent (M1: 2, M2: 1). One left.
    const id = await mailer(['partner@outside.test', 'admin@acme.test'], adminId, 'M3');
    await as(bob).post(`/boards/${boardId}/items`, { name: 'Trigger 2' });
    await drain();
    expect(mailsWith('M3')).toHaveLength(1);
    expect((await lastLog(id)).warnings).toContain('email_budget');
    await as(bob).post(`/boards/${boardId}/items`, { name: 'Trigger 3' });
    await drain();
    expect(mailsWith('M3')).toHaveLength(1);
    expect(await lastLog(id)).toMatchObject({ status: 'skipped', reason: 'email_budget' });
    await t.api(owner).patch('/platform/settings', { email: { automation_emails_per_day: null } });
  });
});
