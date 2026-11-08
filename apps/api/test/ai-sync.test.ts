// SPDX-License-Identifier: AGPL-3.0-only
import { type AiClientFactory, createAiClient, scriptedAnthropic } from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasCachedModels } from '../src/modules/ai/models.service';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * The product owner's fix list, AI round (sync-ai):
 * 1. connecting / disconnecting AI reaches every screen at once — `/me/events` carries the AI signals to everyone in
 *    the account (type only), and the server forgets a removed connection's model list;
 * 2. text an AI writes into updates is Markdown, stored formatted (a rich doc) unless the account turned it off;
 * 3. the assistant's proposed change reads as a sentence with names (board, item, column, label), not JSON.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let otherId: string;
let otherAdmin: string;
let leadsId: string;
let statusKey: string;
let label: string;
let danaId: string;
let connectionId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: scriptedAnthropic() });

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);

const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as Json);

const say = async (text: string) => {
  const conv = (await body(await as(admin).post('/ai/assistant/conversations', { board_id: leadsId }))).id as string;
  const res = await as(admin).post(`/ai/assistant/conversations/${conv}/messages`, { text });
  expect(res.status).toBe(200);
  return (await events(res)).at(-1)!.message as Json;
};

/** A personal SSE stream, as EventSource opens it; collects events. */
const openMe = async (cookie: string, account = acmeId) => {
  const res = await t.app.request(`/api/v1/me/events?account_id=${account}`, {
    headers: { origin: WEB_ORIGIN, cookie },
  });
  expect(res.status).toBe(200);
  const got: Json[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let buf = '';
  void (async () => {
    while (!done) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) got.push(JSON.parse(data) as Json);
      }
    }
  })();
  const waitFor = async (pred: (e: Json) => boolean, ms = 3000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = got.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no matching event; got ${JSON.stringify(got.map((e) => e.type))}`);
  };
  await waitFor((e) => e.type === 'ready');
  return {
    got,
    waitFor,
    close: async () => {
      done = true;
      await reader.cancel().catch(() => {});
    },
  };
};

beforeAll(async () => {
  t = await createTestContext({ aiClient });
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
  otherAdmin = await join('admin@other.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const a = as(admin);
  expect((await a.patch('/ai/settings', { enabled: true })).status).toBe(200);
  connectionId = (
    await body(
      await a.post('/ai/connections', { name: 'Claude', provider: 'anthropic', api_key: 'sk-ant-test-0000000000' }),
    )
  ).id;
  await a.patch('/ai/settings', {
    assistant: {
      enabled: true,
      connection_id: connectionId,
      model: 'claude-sonnet-5-5',
      roles: ['member', 'viewer'],
      max_steps: 8,
      max_usd_per_message: 0.5,
      daily_messages_per_user: 100,
    },
  });
  const wsId = (await body(await a.get('/workspaces'))).data[0].id;
  leadsId = (await body(await a.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  statusKey = (await body(await a.post(`/boards/${leadsId}/columns`, { title: 'Status', type: 'status' }))).id;
  const board = await body(await a.get(`/boards/${leadsId}`));
  label = board.columns.find((c: Json) => c.id === statusKey).settings.labels[0].label;
  danaId = (await body(await a.post(`/boards/${leadsId}/items`, { name: 'Lead X' }))).id;
});
afterAll(() => t.close());

describe('sync-ai — AI connection is live everywhere', () => {
  it('a connection added / removed reaches another member of the account on /me/events (type only)', async () => {
    const bobStream = await openMe(bob);
    const otherStream = await openMe(otherAdmin, otherId);
    const created = await body(
      await as(admin).post('/ai/connections', {
        name: 'Second',
        provider: 'anthropic',
        api_key: 'sk-ant-test-1111111111',
      }),
    );
    const ev = await bobStream.waitFor((e) => e.type === 'ai_connection.created');
    // Ids only — never the key, never the name.
    expect(Object.keys(ev).every((k) => !/key|name/.test(k))).toBe(true);
    // The models were cached when it was saved; removing it forgets them.
    expect(hasCachedModels(created.id)).toBe(true);
    expect((await as(admin).del(`/ai/connections/${created.id}`)).status).toBe(200);
    await bobStream.waitFor((e) => e.type === 'ai_connection.deleted');
    expect(hasCachedModels(created.id)).toBe(false);
    // The AI settings changing (AI on / off, the assistant's connection) too.
    await as(admin).patch('/ai/settings', { budget_alert_pct: 81 });
    await bobStream.waitFor((e) => e.type === 'account.updated');
    // Another account hears nothing.
    await new Promise((r) => setTimeout(r, 150));
    expect(otherStream.got.some((e) => e.type.startsWith('ai_connection.'))).toBe(false);
    await bobStream.close();
    await otherStream.close();
  });

  it('the assistant becomes available as soon as a connection is chosen, and unavailable when it is removed', async () => {
    const temp = await body(
      await as(admin).post('/ai/connections', {
        name: 'Temp',
        provider: 'anthropic',
        api_key: 'sk-ant-test-2222222222',
      }),
    );
    const settings = await body(await as(admin).get('/ai/settings'));
    await as(admin).patch('/ai/settings', { assistant: { ...settings.assistant, connection_id: temp.id } });
    expect((await body(await as(bob).get('/ai/assistant/status'))).available).toBe(true);
    await as(admin).del(`/ai/connections/${temp.id}`);
    expect(await body(await as(bob).get('/ai/assistant/status'))).toMatchObject({
      available: false,
      reason: 'not_configured',
    });
    await as(admin).patch('/ai/settings', { assistant: { ...settings.assistant, connection_id: connectionId } });
  });
});

describe('sync-ai — approvals in words', () => {
  it("the assistant's proposed change names the item, board, column and label", async () => {
    const msg = await say(`TOOL update_item {"item_id":"${danaId}","cells":{"${statusKey}":"${label}"}}`);
    const action = msg.actions[0];
    expect(action.description).toEqual({
      tool: 'update_item',
      variant: 'one_cell',
      params: { item: 'Lead X', column: 'Status', value: label, board: 'Leads' },
      details: [],
    });
    expect(action.preview).toBe(`Update item: "Lead X" · "Leads" · Status: ${label}`);
    // Read back from history the same way.
    const conv = await body(await as(admin).get(`/ai/assistant/conversations?board_id=${leadsId}`));
    expect(conv.data.length).toBeGreaterThan(0);
  });

  it('an id the person cannot resolve stays unnamed instead of leaking', async () => {
    const msg = await say(`TOOL move_item {"item_id":"${danaId}","group_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}`);
    expect(msg.actions[0].description.params).toMatchObject({ item: 'Lead X', group: null, board: 'Leads' });
  });
});

describe('sync-ai — Markdown in updates written by AI', () => {
  const approveAll = async (msg: Json) =>
    body(
      await as(admin).post(`/ai/assistant/messages/${msg.id}/actions`, {
        approve: msg.actions.map((x: Json) => x.id),
      }),
    );
  const lastUpdate = async () => (await body(await as(admin).get(`/items/${danaId}/updates`))).data[0] as Json;
  const md = '## Summary\\n\\n- **won** the deal\\n- next: call\\n\\n| a | b |\\n|-|-|\\n| 1 | 2 |';

  it('is stored as a formatted update (rich doc) — headings, lists, tables', async () => {
    const msg = await say(`TOOL create_update {"item_id":"${danaId}","text":"${md}"}`);
    expect(msg.actions[0].description).toMatchObject({
      tool: 'create_update',
      params: { item: 'Lead X', board: 'Leads' },
      details: [{ field: 'text' }],
    });
    expect((await approveAll(msg)).message.actions[0].status).toBe('done');
    const u = await lastUpdate();
    expect(u.body_html).toContain('<h2>Summary</h2>');
    expect(u.body_html).toContain('<li><p><strong>won</strong> the deal</p></li>');
    expect(u.body_html).toContain('<div class="rich-table"><table>');
    expect(u.body_json.type).toBe('doc');
    expect(u.body_text).toContain('Summary');
    expect(u.body_text).not.toContain('**');
  });

  it('raw HTML in the Markdown stays text', async () => {
    const msg = await say(`TOOL create_update {"item_id":"${danaId}","text":"<img src=x onerror=alert(1)> hi"}`);
    await approveAll(msg);
    const u = await lastUpdate();
    expect(u.body_html).not.toContain('<img');
    expect(u.body_html).toContain('&lt;img');
  });

  it('the account can turn it off: the text is kept as sent', async () => {
    await as(admin).patch('/ai/settings', { format_markdown: false });
    const msg = await say(`TOOL create_update {"item_id":"${danaId}","text":"**plain** text"}`);
    await approveAll(msg);
    const u = await lastUpdate();
    expect(u.body_html).toBe('**plain** text');
    expect(u.body_json).toBeNull();
    await as(admin).patch('/ai/settings', { format_markdown: true });
    expect((await body(await as(admin).get('/ai/settings'))).format_markdown).toBe(true);
  });
});
