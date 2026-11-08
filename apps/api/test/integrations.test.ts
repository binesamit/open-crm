// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellMatches, samePhone } from '@bines/shared';
import { activityLog } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Integration helpers for the n8n / Make apps: a token-driven REST-hook lifecycle (subscribe, check, unsubscribe),
 * the board schema for dynamic fields, find by column value, `include_item` payloads and the automation action
 * "send to integrations" (`automation_sent`).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Hit = { path: string; headers: Record<string, string>; raw: string; body: Json };

let server: Server;
let base: string;
const hits: Hit[] = [];

let t: TestContext;
let admin: string;
let acmeId: string;
let token: string;
let boardId: string;
let statusKey: string;
let phoneKey: string;
let emailKey: string;
let labels: { id: number; label: string }[];
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const withToken = (method: string, path: string, payload?: unknown) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

const join = async (email: string) => {
  const invite = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, invite))!;
  await t.api(cookie).post('/invitations/accept', { token: invite });
  return cookie;
};

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
      for (const run of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, run);
    }
  }
};
const hitsTo = (path: string) => hits.filter((h) => h.path === path && h.body.challenge === undefined);

beforeAll(async () => {
  // A receiver like the n8n trigger: echoes the challenge, records every delivery.
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parsed = raw ? (JSON.parse(raw) as Json) : {};
      hits.push({ path: req.url ?? '', headers: req.headers as Record<string, string>, raw, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(parsed.challenge ? { challenge: parsed.challenge } : { ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

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
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  statusKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Status', type: 'status' }))).id;
  phoneKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Phone', type: 'phone' }))).id;
  emailKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Email', type: 'email' }))).id;
  const board = await body(await as(admin).get(`/boards/${boardId}`));
  labels = board.columns.find((c: Json) => c.id === statusKey).settings.labels;
  token = (
    await body(
      await as(admin).post('/auth/tokens', { name: 'n8n', scopes: ['boards:read', 'items:write', 'webhooks'] }),
    )
  ).token;
  await drain();
});
afterAll(async () => {
  await t.close();
  await new Promise((r) => server.close(r));
});

describe('matching rules', () => {
  it('compares phones by digits, ignoring formatting, leading zeros and a country prefix', () => {
    expect(samePhone('+972 50-123-4567', '050-1234567')).toBe(true);
    expect(samePhone('(050) 123 4567', '0501234567')).toBe(true);
    expect(samePhone('0501234567', '0501234568')).toBe(false);
    // Too short to be a suffix match.
    expect(samePhone('4567', '0501234567')).toBe(false);
  });
  it('compares emails by the address, case-insensitively; contains looks inside the text', () => {
    expect(
      cellMatches('email', { value: { email: 'Dana@X.test', text: 'Dana' }, text: 'Dana' }, 'dana@x.test', 'exact'),
    ).toBe(true);
    expect(cellMatches('text', { value: 'Hello World', text: 'Hello World' }, 'world', 'contains')).toBe(true);
    expect(cellMatches('text', { value: 'Hello World', text: 'Hello World' }, 'world', 'exact')).toBe(false);
  });
});

describe('board list and schema (dynamic fields)', () => {
  it('lists the boards a token can open, flat, filtered by name', async () => {
    const res = await withToken('GET', '/boards?q=lea');
    expect(res.status).toBe(200);
    const list = (await body(res)).data as Json[];
    expect(list.map((b) => b.id)).toContain(boardId);
    expect(list[0]).toHaveProperty('workspace_name');
    expect((await body(await withToken('GET', '/boards?q=zzz-none'))).data).toEqual([]);
  });

  it('describes every column: type, writable, options and the value schema', async () => {
    const res = await withToken('GET', `/boards/${boardId}/schema`);
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(s.groups.length).toBeGreaterThan(0);
    const status = s.columns.find((c: Json) => c.id === statusKey);
    expect(status).toMatchObject({ type: 'status', writable: true, value_model: 'label' });
    expect(status.options.map((o: Json) => o.label)).toEqual(labels.filter((l) => l.label).map((l) => l.label));
    expect(status.value_schema.properties.index).toBeTruthy();
    const phone = s.columns.find((c: Json) => c.id === phoneKey);
    expect(phone).toMatchObject({ type: 'phone', writable: true, options: null });
    expect(phone.value_schema.properties.phone).toBeTruthy();
    expect(s.subitems).toBeNull();
  });
});

describe('find by column value', () => {
  let dana: string;
  let yossi: string;
  beforeAll(async () => {
    dana = (
      await body(
        await withToken('POST', `/boards/${boardId}/items`, {
          name: 'Dana',
          cells: { [phoneKey]: { phone: '+972 50-123-4567' }, [emailKey]: { email: 'Dana@Example.com' } },
        }),
      )
    ).id;
    yossi = (
      await body(
        await withToken('POST', `/boards/${boardId}/items`, {
          name: 'Yossi',
          cells: { [phoneKey]: { phone: '052-7654321' }, [statusKey]: { index: labels.find((l) => l.label)!.id } },
        }),
      )
    ).id;
  });

  const find = async (payload: Json) => {
    const res = await withToken('POST', `/boards/${boardId}/items/find`, payload);
    expect(res.status).toBe(200);
    return ((await body(res)).data as Json[]).map((i) => i.id);
  };

  it('finds by phone digits, by email case-insensitively, by name and by status label', async () => {
    expect(await find({ column_id: phoneKey, value: '0501234567' })).toEqual([dana]);
    expect(await find({ column_id: emailKey, value: 'dana@example.COM' })).toEqual([dana]);
    expect(await find({ column_id: 'name', value: 'yossi' })).toEqual([yossi]);
    expect(await find({ column_id: statusKey, value: labels.find((l) => l.label)!.label })).toEqual([yossi]);
    expect(await find({ column_id: 'name', value: 'o', match: 'contains' })).toEqual([yossi]);
    expect(await find({ column_id: phoneKey, value: '0500000000' })).toEqual([]);
  });

  it('answers 404 for an unknown column; the token needs only a read scope', async () => {
    expect((await withToken('POST', `/boards/${boardId}/items/find`, { column_id: 'nope', value: 'x' })).status).toBe(
      404,
    );
    const readOnly = (await body(await as(admin).post('/auth/tokens', { name: 'ro', scopes: ['boards:read'] }))).token;
    const res = await t.app.request(`/api/v1/boards/${boardId}/items/find`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnly}`, 'content-type': 'application/json' },
      body: JSON.stringify({ column_id: 'name', value: 'Dana' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('REST hooks for the n8n trigger', () => {
  it('subscribes with a token (challenge answered), checks it exists, deletes it on deactivation', async () => {
    const created = await withToken('POST', `/boards/${boardId}/webhooks`, {
      url: `${base}/n8n/created`,
      event: 'item_created',
      config: { include_item: true },
      secret: 'n8n-secret-0123456789',
      description: 'n8n: Leads workflow',
    });
    expect(created.status).toBe(201);
    const hook = await body(created);
    expect((await withToken('GET', `/webhooks/${hook.id}`)).status).toBe(200);

    await withToken('POST', `/boards/${boardId}/items`, {
      name: 'Rina',
      cells: { [emailKey]: { email: 'rina@example.com' } },
    });
    await drain();
    const h = hitsTo('/n8n/created').at(-1)!;
    expect(h.body.event).toMatchObject({ type: 'item_created', boardId, itemName: 'Rina', subscriptionId: hook.id });
    // include_item: the item with its stored cells, keyed by column id.
    expect(h.body.event.item.cells[emailKey].value.email).toBe('rina@example.com');
    expect(h.body.event.item.cells[emailKey].text).toBe('rina@example.com');
    const expected = createHmac('sha256', 'n8n-secret-0123456789')
      .update(`${h.headers['x-bines-timestamp']}.${h.raw}`)
      .digest('hex');
    expect(h.headers['x-bines-signature']).toBe(`sha256=${expected}`);

    expect((await withToken('DELETE', `/webhooks/${hook.id}`)).status).toBe(200);
    expect((await withToken('GET', `/webhooks/${hook.id}`)).status).toBe(404);
  });

  it('narrows a status subscription to one label', async () => {
    const [first, second] = labels.filter((l) => l.label);
    const hook = await body(
      await withToken('POST', `/boards/${boardId}/webhooks`, {
        url: `${base}/n8n/status`,
        event: 'status_changed',
        config: { column_id: statusKey, label: second!.label },
      }),
    );
    const item = await body(await withToken('POST', `/boards/${boardId}/items`, { name: 'Moshe' }));
    await drain();
    await withToken('PUT', `/items/${item.id}/cells/${statusKey}`, { value: { index: first!.id } });
    await drain();
    expect(hitsTo('/n8n/status')).toHaveLength(0);
    await withToken('PUT', `/items/${item.id}/cells/${statusKey}`, { value: { index: second!.id } });
    await drain();
    expect(hitsTo('/n8n/status')).toHaveLength(1);
    expect(hitsTo('/n8n/status')[0]!.body.event).toMatchObject({ columnId: statusKey, itemId: item.id });
    await withToken('DELETE', `/webhooks/${hook.id}`);
  });
});

describe('automation action "send to integrations"', () => {
  it('reaches the automation_sent subscriptions of its channel (and those without one)', async () => {
    const sub = async (path: string, channel?: string) =>
      body(
        await withToken('POST', `/boards/${boardId}/webhooks`, {
          url: `${base}${path}`,
          event: 'automation_sent',
          ...(channel ? { config: { channel } } : {}),
        }),
      );
    await sub('/sent/leads', 'Leads');
    await sub('/sent/other', 'other');
    await sub('/sent/any');
    const auto = await as(admin).post(`/boards/${boardId}/automations`, {
      recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'send_to_integrations', channel: 'leads' }] },
      is_active: true,
    });
    expect(auto.status).toBe(201);
    await as(admin).post(`/boards/${boardId}/items`, { name: 'Avi' });
    await drain();
    expect(hitsTo('/sent/leads')).toHaveLength(1);
    expect(hitsTo('/sent/any')).toHaveLength(1);
    expect(hitsTo('/sent/other')).toHaveLength(0);
    const e = hitsTo('/sent/leads')[0]!.body.event;
    expect(e).toMatchObject({ type: 'automation_sent', channel: 'leads', boardId, itemName: 'Avi' });
    expect(e.item.name).toBe('Avi');
    expect(e.automationId).toBe((await body(auto)).id);
  });
});

describe('subitems for integrations (n8n / Make subitem operations and triggers)', () => {
  let parent: string;
  let subBoardId: string;
  let subStatus: string;
  let subLabels: { id: number; label: string }[];
  let first: string;
  let second: string;
  beforeAll(async () => {
    parent = (await body(await withToken('POST', `/boards/${boardId}/items`, { name: 'Parent' }))).id;
    first = (await body(await withToken('POST', `/items/${parent}/subitems`, { name: 'Sub A' }))).id;
    subBoardId = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id;
    subStatus = (await body(await as(admin).post(`/boards/${subBoardId}/columns`, { title: 'Stage', type: 'status' })))
      .id;
    second = (await body(await withToken('POST', `/items/${parent}/subitems`, { name: 'Sub B' }))).id;
    const sub = await body(await as(admin).get(`/boards/${subBoardId}`));
    subLabels = sub.columns.find((c: Json) => c.id === subStatus).settings.labels.filter((l: Json) => l.label);
    await drain();
  });

  it('the board schema carries the sub-board columns (with their labels) under `subitems`', async () => {
    const s = await body(await withToken('GET', `/boards/${boardId}/schema`));
    expect(s.subitems.board_id).toBe(subBoardId);
    const stage = s.subitems.columns.find((c: Json) => c.id === subStatus);
    expect(stage).toMatchObject({ type: 'status', writable: true, linked_board_ids: null });
    expect(stage.options.map((o: Json) => o.label)).toEqual(subLabels.map((l) => l.label));
  });

  it('lists the subitems right under an item, in order; archived ones are left out', async () => {
    const res = await withToken('GET', `/items/${parent}/subitems`);
    expect(res.status).toBe(200);
    expect(((await body(res)).data as Json[]).map((i) => i.name)).toEqual(['Sub A', 'Sub B']);
    const archived = (await body(await withToken('POST', `/items/${parent}/subitems`, { name: 'Sub C' }))).id;
    expect((await withToken('POST', `/items/${archived}/archive`, {})).status).toBe(200);
    await drain();
    expect(((await body(await withToken('GET', `/items/${parent}/subitems`))).data as Json[]).length).toBe(2);
    expect((await body(await withToken('GET', `/items/${first}/subitems`))).data).toEqual([]);
    expect((await withToken('GET', '/items/nope/subitems')).status).toBe(404);
  });

  it('finds and queries subitems on the sub-board', async () => {
    await withToken('PATCH', `/items/${second}`, { cells: { [subStatus]: { index: subLabels[1]!.id } } });
    await drain();
    const found = await body(
      await withToken('POST', `/boards/${subBoardId}/items/find`, { column_id: subStatus, value: subLabels[1]!.label }),
    );
    expect((found.data as Json[]).map((i) => i.id)).toEqual([second]);
    const page = await body(
      await withToken('POST', `/boards/${subBoardId}/items/query`, {
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ kind: 'rule', column_id: subStatus, operator: 'any_of', values: [subLabels[1]!.label] }],
        },
      }),
    );
    expect((page.data as Json[]).map((i) => i.id)).toEqual([second]);
  });

  it('narrows subitem_column_changed to one sub-board column and one status label', async () => {
    const sub = async (path: string, config?: Json) =>
      body(
        await withToken('POST', `/boards/${boardId}/webhooks`, {
          url: `${base}${path}`,
          event: 'subitem_column_changed',
          ...(config ? { config } : {}),
        }),
      );
    await sub('/sub/any');
    await sub('/sub/stage', { column_id: subStatus });
    await sub('/sub/label', { column_id: subStatus, label: subLabels[0]!.label });
    await sub('/sub/other', { column_id: 'nope' });
    await sub('/sub/status', { column_type: 'status' });
    await sub('/sub/numbers', { column_type: 'numbers' });
    await withToken('PATCH', `/items/${first}`, { cells: { [subStatus]: { index: subLabels[1]!.id } } });
    await drain();
    expect(hitsTo('/sub/any')).toHaveLength(1);
    expect(hitsTo('/sub/stage')).toHaveLength(1);
    expect(hitsTo('/sub/label')).toHaveLength(0);
    await withToken('PATCH', `/items/${first}`, { cells: { [subStatus]: { index: subLabels[0]!.id } } });
    await drain();
    expect(hitsTo('/sub/label')).toHaveLength(1);
    expect(hitsTo('/sub/other')).toHaveLength(0);
    expect(hitsTo('/sub/status')).toHaveLength(2);
    expect(hitsTo('/sub/numbers')).toHaveLength(0);
    expect(hitsTo('/sub/label')[0]!.body.event).toMatchObject({
      type: 'subitem_column_changed',
      boardId,
      itemId: first,
      parentItemId: parent,
      columnId: subStatus,
    });
  });

  it('describes a connect-boards column with the boards it links', async () => {
    const rel = await body(
      await as(admin).post(`/boards/${boardId}/columns`, {
        title: 'Related',
        type: 'board_relation',
        settings: { board_ids: [boardId] },
      }),
    );
    const s = await body(await withToken('GET', `/boards/${boardId}/schema`));
    expect(s.columns.find((c: Json) => c.id === rel.id)).toMatchObject({ writable: true, linked_board_ids: [boardId] });
    // Its values are picked by name.
    const res = await withToken('GET', `/boards/${boardId}/items/search?q=paren`);
    expect(((await body(res)).data as Json[]).map((i) => i.id)).toEqual([parent]);
  });
});

describe('column choices (value pickers)', () => {
  const choices = async (path: string) => {
    const res = await withToken('GET', path);
    expect(res.status).toBe(200);
    return (await body(res)) as { kind: string; data: { id: string | null; text: string; hint: string | null }[] };
  };

  it('offers the labels of a status column, narrowed by q', async () => {
    const all = await choices(`/boards/${boardId}/columns/${statusKey}/choices`);
    expect(all.kind).toBe('labels');
    const named = labels.filter((l) => l.label);
    expect(all.data).toEqual(named.map((l) => ({ id: String(l.id), text: l.label, hint: null })));
    const one = named[1]!.label;
    expect(
      (await choices(`/boards/${boardId}/columns/${statusKey}/choices?q=${encodeURIComponent(one)}`)).data,
    ).toEqual([{ id: String(named[1]!.id), text: one, hint: null }]);
  });

  it('offers people by name (emails only with users:read), item names, typed values and tags', async () => {
    const owner = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Owner', type: 'people' })))
      .id;
    const people = await choices(`/boards/${boardId}/columns/${owner}/choices`);
    expect(people.kind).toBe('people');
    expect(people.data.find((p) => p.hint === null && p.id)).toBeTruthy();
    const withUsers = (
      await body(await as(admin).post('/auth/tokens', { name: 'u', scopes: ['boards:read', 'users:read'] }))
    ).token;
    const res = await t.app.request(`/api/v1/boards/${boardId}/columns/${owner}/choices`, {
      headers: { authorization: `Bearer ${withUsers}` },
    });
    expect(((await body(res)).data as Json[]).map((p) => p.hint)).toContain('admin@acme.test');

    const names = await choices(`/boards/${boardId}/columns/name/choices?q=dan`);
    expect(names).toMatchObject({ kind: 'items', data: [{ text: 'Dana', hint: 'Leads' }] });
    const emails = await choices(`/boards/${boardId}/columns/${emailKey}/choices?q=example`);
    expect(emails.kind).toBe('values');
    expect(emails.data.map((v) => v.text)).toContain('rina@example.com');
    expect(emails.data.every((v) => v.id === null)).toBe(true);

    const tagsKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Tags', type: 'tags' })))
      .id;
    await as(admin).post('/tags', { name: 'vip' });
    expect((await choices(`/boards/${boardId}/columns/${tagsKey}/choices`)).data.map((x) => x.text)).toEqual(['vip']);
  });

  it('offers the linked items of a connect-boards column and the sub-board labels with subitems=true', async () => {
    const rel = await body(
      await as(admin).post(`/boards/${boardId}/columns`, {
        title: 'Linked',
        type: 'board_relation',
        settings: { board_ids: [boardId] },
      }),
    );
    const linked = await choices(`/boards/${boardId}/columns/${rel.id}/choices?q=yos`);
    expect(linked).toMatchObject({ kind: 'items', data: [{ text: 'Yossi' }] });
    const sub = await body(await withToken('GET', `/boards/${boardId}/schema`));
    const stage = sub.subitems.columns.find((c: Json) => c.type === 'status');
    const subChoices = await choices(`/boards/${boardId}/columns/${stage.id}/choices?subitems=true`);
    expect(subChoices.data.map((x) => x.text)).toEqual(stage.options.map((o: Json) => o.label));
    expect((await withToken('GET', `/boards/${boardId}/columns/nope/choices`)).status).toBe(404);
  });
});
