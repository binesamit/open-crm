// SPDX-License-Identifier: AGPL-3.0-only
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Agent mentions: a new agent answers mentions by default (the account's AI setting, on by default
 * existing agents untouched); the directory also returns the agents one could mention that do not act now, each
 * with the reason (mention off, inactive, not on a board I can see, guests not allowed, no AI connection) — a guest
 * never hears of an agent off their boards; agent changes reach `/me/events` so open mention lists refresh.
 */
let t: TestContext;
let admin: string;
let bob: string;
let guest: string;
let acmeId: string;
let leadsId: string;
let portalId: string;
let connectionId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const fakeAnthropic: AnthropicLike = {
  messages: { create: async () => ({}) as never },
  models: { list: async () => ({ data: [] }) },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fakeAnthropic });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newAgent = async (extra: Json = {}) => {
  const res = await as(admin).post('/agents', {
    name: `Agent ${Math.random().toString(36).slice(2, 7)}`,
    connection_id: connectionId,
    model: 'claude-opus-5-5',
    tools: ['get_item'],
    boards: [{ board_id: leadsId, level: 'view' }],
    ...extra,
  });
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json;
};
const directory = async (cookie: string) => body(await as(cookie).get('/agents/directory'));
const reasonOf = (dir: Json, id: string) => dir.unavailable.find((x: Json) => x.id === id)?.reason;

beforeAll(async () => {
  t = await createTestContext({ aiClient });
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
  expect((await as(admin).patch('/ai/settings', { enabled: true })).status).toBe(200);
  connectionId = (
    await body(
      await as(admin).post('/ai/connections', { name: 'Claude', provider: 'anthropic', api_key: 'sk-ant-test-0000' }),
    )
  ).id;
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  leadsId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  portalId = (await body(await as(admin).post('/boards', { name: 'Portal', workspace_id: wsId, kind: 'shareable' })))
    .id;
  await as(admin).post('/users/invite', { emails: ['g1@client.test'], role: 'guest' });
  guest = await join('g1@client.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const guestId = users.find((u) => u.email === 'g1@client.test')!.user_id;
  await as(admin).put(`/boards/${portalId}/members/${guestId}`, {});
});
afterAll(() => t.close());

describe('a new agent answers mentions by default', () => {
  it('mention is on when the request does not say; an explicit choice wins', async () => {
    expect((await newAgent()).triggers.mention).toBe(true);
    expect((await newAgent({ triggers: { assign: true } })).triggers).toMatchObject({ mention: true, assign: true });
    expect((await newAgent({ triggers: { mention: false } })).triggers.mention).toBe(false);
    expect((await body(await as(admin).get('/agents'))).new_agent_mention).toBe(true);
  });

  it('existing agents are not changed by an edit that does not touch the triggers', async () => {
    const quiet = await newAgent({ triggers: { mention: false } });
    const next = await body(await as(admin).patch(`/agents/${quiet.id}`, { role: 'Answers questions' }));
    expect(next.triggers.mention).toBe(false);
  });

  it("the account's AI setting decides the default (and the editor reads it from the list)", async () => {
    expect((await as(admin).patch('/ai/settings', { agent_mention_default: false })).status).toBe(200);
    expect((await body(await as(admin).get('/agents'))).new_agent_mention).toBe(false);
    expect((await newAgent()).triggers.mention).toBe(false);
    expect((await as(admin).patch('/ai/settings', { agent_mention_default: true })).status).toBe(200);
  });
});

describe('the directory says why an agent is unavailable', () => {
  it('lists acting agents in data and the others in unavailable, with the reason', async () => {
    const on = await newAgent({ triggers: { mention: true } });
    const off = await newAgent({ triggers: { mention: false, assign: false } });
    const paused = await newAgent({ triggers: { mention: true }, is_active: false });
    const nowhere = await newAgent({ triggers: { mention: true }, boards: [] });
    const dir = await directory(bob);
    expect(dir.data.find((x: Json) => x.id === on.id)).toMatchObject({ mention: true, board_ids: [leadsId] });
    expect(reasonOf(dir, off.id)).toBe('mention_off');
    expect(reasonOf(dir, paused.id)).toBe('inactive');
    expect(reasonOf(dir, nowhere.id)).toBe('not_on_board');
    for (const id of [off.id, paused.id, nowhere.id]) expect(dir.data.some((x: Json) => x.id === id)).toBe(false);
    expect(JSON.stringify(dir)).not.toContain('instructions');
  });

  it('an agent whose AI connection is gone, or with AI off, has no connection', async () => {
    const conn2 = (
      await body(
        await as(admin).post('/ai/connections', { name: 'Spare', provider: 'anthropic', api_key: 'sk-ant-test-1111' }),
      )
    ).id as string;
    const orphan = await newAgent({ connection_id: conn2, triggers: { mention: true } });
    expect((await as(admin).del(`/ai/connections/${conn2}`)).status).toBeLessThan(300);
    expect(reasonOf(await directory(bob), orphan.id)).toBe('no_connection');

    const ok = await newAgent({ triggers: { mention: true } });
    await as(admin).patch('/ai/settings', { enabled: false });
    expect(reasonOf(await directory(bob), ok.id)).toBe('no_connection');
    await as(admin).patch('/ai/settings', { enabled: true });
    expect((await directory(bob)).data.some((x: Json) => x.id === ok.id)).toBe(true);
  });

  it('a guest: "guests not allowed" on their boards; agents off their boards stay hidden', async () => {
    const portal = await newAgent({ triggers: { mention: true }, boards: [{ board_id: portalId, level: 'view' }] });
    const forGuests = await newAgent({
      triggers: { mention: true, allow_guests: true },
      boards: [{ board_id: portalId, level: 'view' }],
    });
    const internal = await newAgent({ triggers: { mention: true } });
    const dir = await directory(guest);
    expect(reasonOf(dir, portal.id)).toBe('guests_not_allowed');
    expect(dir.data.find((x: Json) => x.id === forGuests.id)).toMatchObject({ board_ids: [portalId] });
    const all = [...dir.data, ...dir.unavailable].map((x: Json) => x.id);
    expect(all).not.toContain(internal.id);
  });
});

describe('live: agent changes reach /me/events', () => {
  it('an agent update is an account-wide signal on the personal stream', async () => {
    const { meStream } = await import('../src/modules/realtime/realtime.service');
    const ctx = { accountId: acmeId, role: 'member' } as never;
    const filter = meStream(t.db as never, { ctx, user: { id: 'someone' } } as never);
    for (const type of ['agent.created', 'agent.updated', 'agent.deleted'])
      expect(await filter.accept({ id: 'x', account_id: acmeId, type } as never)).toBe('send');
    expect(await filter.accept({ id: 'x', account_id: acmeId, type: 'item.updated' } as never)).toBe('skip');
  });
});
