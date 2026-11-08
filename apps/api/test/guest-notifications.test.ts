// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryMailer } from '@bines/server-mail';
import { newId } from '@bines/shared';
import { dispatchNotification } from '../../worker/src/notifications';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import { activityLog, automations, notifications } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * M7 stage 4: guests use the existing notifications — an update on their item, a mention, and (the DoD)
 * "status changed → email the guest" as an automation the account builds (notify `@creator`). Only for items they see.
 */
let t: TestContext;
let admin: string;
let g1: string;
let g2: string;
let acmeId: string;
let adminId: string;
let boardId: string;
let statusKey: string;
const user: Record<string, string> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const inbox = async (cookie: string) => (await body(await as(cookie).get('/me/notifications'))).data as Json[];

/** Dispatches every activity row not seen yet and runs the automations it causes. */
const seen = new Set<string>();
const drain = async () => {
  for (let round = 0; round < 10; round++) {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) return;
    for (const r of fresh) {
      seen.add(r.id);
      for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
    }
  }
};

beforeAll(async () => {
  t = await createTestContext();
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
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Requests', workspace_id: ws, kind: 'shareable' }))).id;
  statusKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Status', type: 'status' }))).id;
  await as(admin).put(`/boards/${boardId}/permissions`, {
    view_items: { mode: 'assigned_or_created' },
  });
  const invite = (email: string) =>
    as(admin).post('/users/invite', { emails: [email], role: 'guest', board_ids: [boardId] });
  await invite('g1@client.test');
  g1 = await join('g1@client.test');
  await invite('g2@other.test');
  g2 = await join('g2@other.test');
  for (const u of (await body(await as(admin).get('/users'))).data as Json[]) user[u.email] = u.user_id;
  adminId = user['admin@acme.test']!;
});
afterAll(() => t.close());

describe('guest notifications', () => {
  let item: string;

  it('an update on their item reaches them (they follow what they create); not another guest', async () => {
    item = (await body(await as(g1).post(`/boards/${boardId}/items`, { name: 'Logo request' }))).id;
    expect((await as(admin).post(`/items/${item}/updates`, { body: 'In progress' })).status).toBe(200);
    expect((await inbox(g1)).map((n) => n.type)).toContain('item_update');
    expect(await inbox(g2)).toEqual([]);
  });

  it('a mention reaches them; mentioning a guest on an item they cannot see does not', async () => {
    await as(admin).post(`/items/${item}/updates`, { body: `[@g1](user:${user['g1@client.test']}) please check` });
    expect((await inbox(g1)).map((n) => n.type)).toContain('mention');
    await as(admin).post(`/items/${item}/updates`, { body: `[@g2](user:${user['g2@other.test']}) see this` });
    expect(await inbox(g2)).toEqual([]);
  });

  it('status changed → notify the creator (an automation): bell + email with a link to the item', async () => {
    await drain(); // what happened so far triggers nothing
    await t.db.insert(automations).values({
      id: newId(),
      accountId: acmeId,
      boardId,
      title: 'Status → tell the requester',
      recipe: {
        trigger: { type: 'status_changed', column: statusKey },
        actions: [{ type: 'notify', to: '@creator', message: 'הסטטוס של {item.name} השתנה' }],
      } as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    expect((await as(admin).put(`/items/${item}/cells/${statusKey}`, { value: { index: 1 } })).status).toBe(200);
    await drain();
    const n = (await inbox(g1)).find((x) => x.type === 'automation');
    expect(n).toBeDefined();
    expect(await inbox(g2)).toEqual([]);

    const [row] = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, user['g1@client.test']!), eq(notifications.type, 'automation')));
    const mailer = memoryMailer();
    const res = await dispatchNotification(
      t.pg as unknown as SqlClient,
      { mailer, appUrl: 'https://app.test' },
      row!.id,
    );
    expect(res).toBe('sent');
    expect(mailer.sent[0]!.to).toBe('g1@client.test');
    expect(mailer.sent[0]!.html).toContain(`https://app.test/a/acme/b/${boardId}/i/${item}`);
    // The link opens for the guest.
    expect((await as(g1).get(`/items/${item}`)).status).toBe(200);
  });
});
