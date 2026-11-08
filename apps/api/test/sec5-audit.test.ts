// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type RecipeInput } from '@bines/shared';
import { activityLog, automations, idempotencyKeys, webhookDeliveries } from '../src/db/schema';
import { isPlaceholderSecret, loadEnv } from '../src/env';
import { restrictedRunBoards } from '../src/modules/agents/engine/context';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { mask } from '../src/modules/flows/flows.ai';
import type { McpPrincipal } from '../src/modules/mcp/mcp.auth';
import { toolsOf } from '../src/modules/mcp/mcp.server';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Open-source security refresh ק5 (docs/SECURITY-REVIEW.md S-65 …): the fixes that are not covered next to their
 * module's own tests (S-65 → mcp-servers / sec3-audit, S-70 → shared formula, S-75 → server-mail, S-85 → secrets).
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let wsId: string;
let bobId: string;
let adminId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  bobId = users.find((u) => u.email === 'bob@acme.test')!.user_id;
  adminId = users.find((u) => u.email === 'admin@acme.test')!.user_id;
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('S-74 — a placeholder secret never starts production', () => {
  const prod = (secret: string) => ({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://db/x',
    SEED_ADMIN_EMAIL: 'owner@example.org',
    BETTER_AUTH_SECRET: secret,
  });
  it('the .env.example value, the dev fallbacks and low-variety values are refused', () => {
    for (const s of [
      'change-me-32-chars-minimum-xxxxxxxx',
      'dev-only-secret-change-me-dev-only-secret',
      'bines-dev-only-secret-not-for-production',
      'a'.repeat(40),
      'abababababababababababababababababab',
    ]) {
      expect(isPlaceholderSecret(s), s).toBe(true);
      expect(() => loadEnv(prod(s)), s).toThrow(/placeholder/);
    }
    expect(() => loadEnv(prod('kq3P9vX2mL7tR4wZ8bN1cF6hJ0dS5gY2aE9uI3oK'))).not.toThrow();
    // Development / tests keep their fallbacks.
    expect(() =>
      loadEnv({ NODE_ENV: 'test', BETTER_AUTH_SECRET: 'change-me-32-chars-minimum-xxxxxxxx' }),
    ).not.toThrow();
  });
});

describe('S-67 — flows_get masks secrets in name/value pairs, URLs and code', () => {
  it('n8n parameters', () => {
    const out = JSON.stringify(
      mask({
        url: 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnopqrstuvwx?token=zzz',
        queryParameters: {
          parameters: [
            { name: 'api_key', value: 'sk-live-1234' },
            { name: 'q', value: 'shoes' },
          ],
        },
        jsCode: 'const key = "hard-coded-secret";',
        authentication: 'headerAuth',
      }),
    );
    for (const leak of ['sk-live-1234', 'abcdefghijklmnopqrstuvwx', 'token=zzz', 'hard-coded-secret'])
      expect(out).not.toContain(leak);
    expect(out).toContain('shoes');
    expect(out).toContain('https://hooks.slack.com/services/T000/B000/');
  });
});

describe('S-69 — API tokens never reach external flows through /mcp', () => {
  it('flows_* tools are offered to an OAuth connection, not to a token', () => {
    const principal = (via: 'token' | 'oauth') =>
      ({
        via,
        scopes: ['admin', 'automations:read', 'automations:write'],
        actor: { ctx: { role: 'admin' } },
        support: null,
        ai: { mcp_sensitive: 'allow' },
      }) as unknown as McpPrincipal;
    const names = (via: 'token' | 'oauth') => toolsOf(principal(via)).map((x) => x.name);
    expect(names('oauth').some((n) => n.startsWith('flows_'))).toBe(true);
    expect(names('token').some((n) => n.startsWith('flows_'))).toBe(false);
    expect(names('token').length).toBeGreaterThan(0);
  });
});

describe('S-66 — a run a guest / non-editor started reads only its board', () => {
  it('restrictedRunBoards', () => {
    expect(restrictedRunBoards({ meta: {} })).toBeNull();
    expect(restrictedRunBoards({ meta: { guest: true, board_scope: ['b1'] } })).toEqual(['b1']);
    expect(restrictedRunBoards({ meta: { untrusted_requester: true, board_scope: ['b2'] } })).toEqual(['b2']);
    // An older run without a scope reads nothing beyond.
    expect(restrictedRunBoards({ meta: { guest: true } })).toEqual([]);
  });
});

describe('S-86 — Idempotency-Key never keeps an answer that carries a secret', () => {
  it('a new API token is not stored or replayed', async () => {
    const mint = () =>
      as(admin).call('POST', '/auth/tokens', { name: 'Make', scopes: ['boards:read'] }, { 'idempotency-key': 'k-1' });
    const a = await body(await mint());
    const b = await body(await mint());
    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    expect(b.token).not.toBe(a.token);
    const rows = await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'k-1'));
    expect(rows).toEqual([]);
    // Ordinary writes still replay.
    const board = await body(await as(admin).post('/boards', { name: 'Idem', workspace_id: wsId }));
    const create = () =>
      as(admin).call('POST', `/boards/${board.id}/items`, { name: 'Once' }, { 'idempotency-key': 'k-2' });
    const first = await body(await create());
    const again = await create();
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await body(again)).id).toBe(first.id);
    // A malformed X-Account-Id with a key is not keyed on (it used to reach the key table and 500 — audit
    // 2026-10-10 security #20); the route answers it as it would without the key.
    const bad = await as(admin).call(
      'POST',
      `/boards/${board.id}/items`,
      { name: 'Bad' },
      { 'idempotency-key': 'k-3', 'x-account-id': 'A'.repeat(30) },
    );
    expect(bad.status).toBeLessThan(500);
    expect(await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'k-3'))).toEqual([]);
  });
});

describe('S-83 — automation templates and the item payload carry only what the owner may see', () => {
  const seen = new Set<string>();
  const drain = async () => {
    for (let round = 0; round < 20; round++) {
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

  it('bob’s webhook gets no "salary"; the admin’s does', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Payroll', workspace_id: wsId }));
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'salary', title: 'Salary', type: 'text' });
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'stage', title: 'Stage', type: 'text' });
    expect(
      (await as(admin).put(`/boards/${board.id}/columns/salary/restriction`, { kind: 'view', users: [], teams: [] }))
        .status,
    ).toBe(200);
    const item = await body(await as(admin).post(`/boards/${board.id}/items`, { name: 'Dana' }));
    await as(admin).put(`/items/${item.id}/cells/salary`, { value: '99999' });
    await drain();
    const add = async (ownerId: string) => {
      const id = newId();
      const recipe = {
        trigger: { type: 'column_changed', column: 'stage' },
        actions: [
          { type: 'webhook', url: 'http://127.0.0.1:9/item', payload: 'item' },
          { type: 'webhook', url: 'http://127.0.0.1:9/tpl', payload: { s: 'pay {item.salary}' } },
        ],
      } as unknown as RecipeInput;
      await t.db.insert(automations).values({
        id,
        accountId: acmeId,
        boardId: board.id,
        title: `leak ${ownerId}`,
        recipe: recipe as never,
        isActive: true,
        ownerId,
        createdBy: ownerId,
      });
      return id;
    };
    const bobAuto = await add(bobId);
    const adminAuto = await add(adminId);
    await as(admin).put(`/items/${item.id}/cells/stage`, { value: 'review' });
    await drain();
    const sent = async (automationId: string) =>
      JSON.stringify(
        (
          await t.db
            .select({ b: webhookDeliveries.requestBody })
            .from(webhookDeliveries)
            .where(and(eq(webhookDeliveries.accountId, acmeId), eq(webhookDeliveries.automationId, automationId)))
        ).map((r) => r.b),
      );
    const bobs = await sent(bobAuto);
    const admins = await sent(adminAuto);
    expect(bobs).toContain('Dana');
    expect(bobs).not.toContain('99999');
    expect(admins).toContain('99999');
  });
});

describe('S-84 — a form editor cannot widen what the form writes', () => {
  it('a question on a column the saver may not edit is refused; one already there stays', async () => {
    const board = await body(await as(admin).post('/boards', { name: 'Quotes', workspace_id: wsId }));
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'price', title: 'Price', type: 'text' });
    await as(admin).post(`/boards/${board.id}/columns`, { id: 'approved', title: 'Approved', type: 'text' });
    for (const id of ['price', 'approved'])
      expect(
        (await as(admin).put(`/boards/${board.id}/columns/${id}/restriction`, { kind: 'edit', users: [adminId] }))
          .status,
      ).toBe(200);
    const view = await body(await as(admin).post(`/boards/${board.id}/views`, { type: 'form', name: 'Quote' }));
    const form = await body(await as(admin).get(`/views/${view.id}/form`));
    expect(form.id ?? form.questions).toBeDefined();
    const name = { id: 'qname0001', column_key: 'name', label: 'Name', required: true };
    const price = { id: 'qprice001', column_key: 'price' };
    const approved = { id: 'qappr0001', column_key: 'approved', hidden: true, default_value: 'yes' };
    // The admin may put the price on the form.
    expect((await as(admin).patch(`/views/${view.id}/form`, { questions: [name, price] })).status).toBe(200);
    // Bob (an editor of the board) may keep it — but not add "approved", which he may not edit.
    const bobSave = (questions: Json[]) => as(bob).patch(`/views/${view.id}/form`, { questions });
    const kept = await bobSave([name, price]);
    expect(kept.status, JSON.stringify(await body(kept.clone()))).toBe(200);
    const added = await bobSave([name, price, approved]);
    expect(added.status).toBe(422);
    expect((await body(added)).error.details.reason).toBe('column_not_editable');
  });
});
