// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { AI_TOOL_NAMES } from '@bines/shared';
import type { AiClientFactory } from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiConnections, aiUsage, auditLog } from '../src/db/schema';
import { createSecretBox } from '../src/lib/secrets';
import { completeWith } from '../src/modules/ai/ai.service';
import { TOOL_RUNNERS } from '../src/modules/ai/tools/runners';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * AI infrastructure (the planning notes "AGENTS-MCP" מ1, D26): settings and AI connections are admin-only, keys are
 * encrypted and never returned, a (mocked) model call is priced and recorded in ai_usage. No test spends money.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let otherId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const seenKeys: string[] = [];
const fakeAi: AiClientFactory = (conn) => {
  seenKeys.push(conn.apiKey);
  return {
    provider: 'anthropic',
    test: async () =>
      conn.apiKey.includes('bad') ? { ok: false, error: 'invalid_api_key' } : { ok: true, error: null },
    complete: async (req) => ({
      model: req.model,
      text: 'סיכום',
      stopReason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      costUsd: 0.006,
      content: [],
    }),
  };
};

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

beforeAll(async () => {
  t = await createTestContext({ aiClient: fakeAi });
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
});
afterAll(() => t.close());

describe('secrets', () => {
  it('seal / open round trip; a different key cannot open; tampering is detected', () => {
    const box = createSecretBox({ BETTER_AUTH_SECRET: 'a'.repeat(40), SECRETS_KEY: undefined });
    const sealed = box.seal('sk-ant-secret-1234');
    expect(sealed).not.toContain('sk-ant');
    expect(box.open(sealed)).toBe('sk-ant-secret-1234');
    expect(box.seal('x')).not.toBe(box.seal('x')); // random IV
    const other = createSecretBox({ BETTER_AUTH_SECRET: 'b'.repeat(40), SECRETS_KEY: undefined });
    expect(() => other.open(sealed)).toThrow();
    const [v, iv, tag, data] = sealed.split('.');
    const flipped = `${data![0] === 'A' ? 'B' : 'A'}${data!.slice(1)}`;
    expect(() => box.open([v, iv, tag, flipped].join('.'))).toThrow();
    const explicit = createSecretBox({
      SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
      BETTER_AUTH_SECRET: undefined,
    });
    expect(explicit.open(explicit.seal('k'))).toBe('k');
  });
});

describe('AI settings', () => {
  it('defaults: AI off, MCP on for admins and members, agents by admins', async () => {
    const s = await body(await t.api(admin, acmeId).get('/ai/settings'));
    expect(s).toMatchObject({
      enabled: false,
      mcp_enabled: true,
      mcp_roles: ['member'],
      agent_creators: 'admins',
      mcp_sensitive: 'allow',
      monthly_budget_usd: null,
    });
  });

  it('admin only — a member gets 403', async () => {
    expect((await t.api(bob, acmeId).get('/ai/settings')).status).toBe(403);
    expect((await t.api(bob, acmeId).patch('/ai/settings', { enabled: true })).status).toBe(403);
    expect((await t.api(bob, acmeId).get('/ai/connections')).status).toBe(403);
    expect((await t.api(bob, acmeId).post('/ai/connections', { name: 'x', api_key: 'sk-ant-xxxxxxxxxx' })).status).toBe(
      403,
    );
  });

  it('changes only what was sent, audited', async () => {
    const s = await body(await t.api(admin, acmeId).patch('/ai/settings', { enabled: true, monthly_budget_usd: 50 }));
    expect(s).toMatchObject({ enabled: true, monthly_budget_usd: 50, mcp_enabled: true });
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, 'ai.settings_changed'));
    expect(audit).toHaveLength(1);
    expect((await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['guest'] })).status).toBe(400);
  });
});

describe('AI connections', () => {
  let id: string;

  it('saves a key encrypted; the key never comes back', async () => {
    const res = await t.api(admin, acmeId).post('/ai/connections', {
      name: 'Anthropic — Bines',
      api_key: 'sk-ant-api03-secret-AbCd',
      default_model: 'claude-sonnet-5-5',
    });
    expect(res.status).toBe(201);
    const c = await body(res);
    id = c.id;
    expect(c).toMatchObject({ provider: 'anthropic', key_hint: '…AbCd', default_model: 'claude-sonnet-5-5' });
    expect(JSON.stringify(c)).not.toContain('secret');
    const row = (await t.db.select().from(aiConnections).where(eq(aiConnections.id, id)))[0]!;
    expect(row.keyEnc).not.toContain('sk-ant');
    const list = await body(await t.api(admin, acmeId).get('/ai/connections'));
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(list.data).toHaveLength(1);
    // An unknown model is refused.
    expect(
      (
        await t
          .api(admin, acmeId)
          .post('/ai/connections', { name: 'x', api_key: 'sk-ant-1234567890', default_model: 'gpt-9' })
      ).status,
    ).toBe(422);
  });

  it('tests the key through the provider client (mocked) and keeps the result', async () => {
    const ok = await body(await t.api(admin, acmeId).post(`/ai/connections/${id}/test`));
    expect(ok).toEqual({ ok: true, error: null });
    expect(seenKeys.at(-1)).toBe('sk-ant-api03-secret-AbCd');
    await t.api(admin, acmeId).patch(`/ai/connections/${id}`, { api_key: 'sk-ant-bad-key-9999' });
    const listed = (await body(await t.api(admin, acmeId).get('/ai/connections'))).data[0];
    expect(listed).toMatchObject({ key_hint: '…9999', last_test: null });
    const bad = await body(await t.api(admin, acmeId).post(`/ai/connections/${id}/test`));
    expect(bad).toEqual({ ok: false, error: 'invalid_api_key' });
    await t.api(admin, acmeId).patch(`/ai/connections/${id}`, { api_key: 'sk-ant-api03-good-1111' });
  });

  it('another account cannot see or use it (404)', async () => {
    const otherAdmin = await join('admin@other.test');
    expect((await t.api(otherAdmin, otherId).post(`/ai/connections/${id}/test`)).status).toBe(404);
    expect((await body(await t.api(otherAdmin, otherId).get('/ai/connections'))).data).toEqual([]);
  });

  it('a (mocked) model call is priced and recorded in ai_usage; the usage report sums it', async () => {
    const out = await completeWith(t.deps, acmeId, id, 'test', {
      messages: [{ role: 'user', content: 'סכם' }],
    });
    expect(out.text).toBe('סיכום');
    await completeWith(t.deps, acmeId, id, 'test', { messages: [{ role: 'user', content: 'שוב' }] });
    const rows = await t.db.select().from(aiUsage).where(eq(aiUsage.accountId, acmeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 2, inputTokens: 2000, outputTokens: 200, model: 'claude-sonnet-5-5' });
    const report = await body(await t.api(admin, acmeId).get('/ai/usage'));
    expect(report).toMatchObject({ total_usd: 0.012, budget_usd: 50 });
    expect(report.rows[0]).toMatchObject({ connection_name: 'Anthropic — Bines', calls: 2, source: 'test' });
  });

  it('refuses when AI is off or the budget is used up', async () => {
    await t.api(admin, acmeId).patch('/ai/settings', { monthly_budget_usd: 0.01 });
    await expect(completeWith(t.deps, acmeId, id, 'test', { messages: [] })).rejects.toThrow('ai_budget_exceeded');
    await t.api(admin, acmeId).patch('/ai/settings', { enabled: false });
    await expect(completeWith(t.deps, acmeId, id, 'test', { messages: [] })).rejects.toThrow('ai_disabled');
  });

  it('deletes (soft) — the usage history keeps its name', async () => {
    expect((await t.api(admin, acmeId).del(`/ai/connections/${id}`)).status).toBe(200);
    expect((await body(await t.api(admin, acmeId).get('/ai/connections'))).data).toEqual([]);
    expect((await body(await t.api(admin, acmeId).get('/ai/usage'))).rows[0].connection_name).toBe('Anthropic — Bines');
  });
});

describe('tool runners', () => {
  it('every registry tool has a runner and every runner a tool', () => {
    expect(Object.keys(TOOL_RUNNERS).sort()).toEqual([...AI_TOOL_NAMES].sort());
  });
});
