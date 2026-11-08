// SPDX-License-Identifier: AGPL-3.0-only
import { encodeQuery, type QueryInput } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tags, teamMembers, teams } from '../src/db/schema';
import {
  columns as fixtureColumns,
  fixtureItems,
  ME,
  OTHER,
  queryCases,
  TAG_BLUE,
  TAG_RED,
  TEAM,
} from '../../../packages/shared/test/query-fixtures';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * 13-FILTERS §6: the items query against Postgres. Every case of the shared truth table runs twice — once as
 * SQL (no computed columns) and once forced through the in-memory engine (AND a formula rule) — and both must
 * return exactly the fixture's expectation, in board order.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let boardId: string;
const ids = new Map<string, string>(); // fixture user/team ids → real ids
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** Replaces fixture ids (u_me, user:u_other, team:t_ops, groups g1/g2) with the real ones, anywhere in a JSON value. */
const real = <T>(v: T): T =>
  JSON.parse(JSON.stringify(v).replace(/\b(u_me|u_other|t_ops|tg_red|tg_blue|g1|g2)\b/g, (m) => ids.get(m)!)) as T;

beforeAll(async () => {
  vi.useFakeTimers({ now: new Date('2026-10-07T09:00:00Z'), toFake: ['Date'] });
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
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const users = (await body(await t.api(admin, acmeId).get('/users'))).data as Json[];
  ids.set(ME, users.find((u) => u.email === 'admin@acme.test')!.user_id);
  ids.set(OTHER, users.find((u) => u.email === 'bob@acme.test')!.user_id);
  ids.set(TEAM, '01TEAMOPS0000000000000000A');
  await t.db.insert(teams).values({ id: ids.get(TEAM)!, accountId: acmeId, name: 'Ops' });
  await t.db.insert(teamMembers).values({ teamId: ids.get(TEAM)!, userId: ids.get(OTHER)!, accountId: acmeId });
  ids.set(TAG_RED, '01TAGRED000000000000000000');
  ids.set(TAG_BLUE, '01TAGBLUE00000000000000000');
  await t.db.insert(tags).values([
    { id: ids.get(TAG_RED)!, accountId: acmeId, name: 'red' },
    { id: ids.get(TAG_BLUE)!, accountId: acmeId, name: 'blue' },
  ]);

  const ws = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0];
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Query', workspace_id: ws.id }))).id;
  const g1 = (await body(await t.api(admin, acmeId).get(`/boards/${boardId}`))).groups[0].id;
  const g2 = (
    await body(await t.api(admin, acmeId).post(`/boards/${boardId}/groups`, { title: 'G2', position: 'bottom' }))
  ).id;
  const groupOf = { g1, g2 };
  ids.set('g1', g1);
  ids.set('g2', g2);
  for (const c of fixtureColumns.filter((c) => c.type !== 'name')) {
    const res = await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, {
      id: c.id,
      title: c.id,
      type: c.type,
      settings: c.settings,
    });
    expect(res.status, c.id).toBe(201);
  }
  // A formula that is never empty: AND-ing it forces the in-memory path without changing the result.
  await t.api(admin, acmeId).post(`/boards/${boardId}/columns`, {
    id: 'calc',
    title: 'calc',
    type: 'formula',
    settings: { formula: '1' },
  });
  for (const it of fixtureItems) {
    const res = await t.api(admin, acmeId).post(`/boards/${boardId}/items`, {
      name: it.name,
      group_id: groupOf[it.group],
      cells: real(it.values),
    });
    expect(res.status, it.name).toBe(201);
  }
});
afterAll(async () => {
  vi.useRealTimers();
  await t.close();
});

const query = async (q: QueryInput & { limit?: number; cursor?: string }, cookie = admin) => {
  const res = await t.api(cookie, acmeId).post(`/boards/${boardId}/items/query`, real(q));
  return { status: res.status, body: await body(res) };
};
const names = (b: Json) => (b.data as Json[]).map((i) => i.name);

const viaMemory = (q: Json): QueryInput => {
  const calc = { kind: 'rule', column_id: 'calc', operator: 'is_not_empty', values: [] };
  return {
    ...q,
    filter: { kind: 'group', operator: 'and', rules: q.filter ? [q.filter, calc] : [calc] },
  } as QueryInput;
};

describe('items/query — SQL', () => {
  for (const c of queryCases) {
    it(c.title, async () => {
      const r = await query(c.query as QueryInput);
      expect(r.status).toBe(200);
      expect(names(r.body)).toEqual(c.expect);
      expect(r.body.total).toBe(c.expect.length);
    });
  }
});

describe('items/query — in memory (computed column in the filter)', () => {
  for (const c of queryCases) {
    it(c.title, async () => {
      const r = await query(viaMemory(c.query));
      expect(r.status).toBe(200);
      expect(names(r.body)).toEqual(c.expect);
    });
  }
});

describe('items/query — sort and paging', () => {
  const sorts: { title: string; sort: Json[]; expect: string[] }[] = [
    {
      title: 'number desc',
      sort: [{ column_id: 'amount', direction: 'desc' }],
      expect: ['Bravo', 'Alpha', 'Charlie', 'Foxtrot', 'Delta', 'Echo'],
    },
    {
      title: 'status then name desc',
      sort: [{ column_id: 'status' }, { column_id: 'name', direction: 'desc' }],
      expect: ['Alpha', 'Bravo', 'Charlie', 'Foxtrot', 'Delta', 'Echo'],
    },
    {
      title: 'text nulls first',
      sort: [{ column_id: 'note', nulls: 'first' }],
      expect: ['Charlie', 'Bravo', 'Alpha', 'Echo', 'Foxtrot', 'Delta'],
    },
    { title: 'date', sort: [{ column_id: 'due' }], expect: ['Charlie', 'Bravo', 'Alpha', 'Delta', 'Foxtrot', 'Echo'] },
  ];
  for (const s of sorts) {
    it(`${s.title} (within groups, SQL = memory)`, async () => {
      expect(names((await query({ sort: s.sort } as QueryInput)).body)).toEqual(s.expect);
      expect(names((await query(viaMemory({ sort: s.sort }))).body)).toEqual(s.expect);
    });
  }

  it('pages with a cursor', async () => {
    const first = await query({ sort: [{ column_id: 'amount' }], limit: 4 } as QueryInput);
    expect(first.body).toMatchObject({ total: 6 });
    expect(names(first.body)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
    const second = await query({
      sort: [{ column_id: 'amount' }],
      limit: 4,
      cursor: first.body.next_cursor,
    } as QueryInput);
    expect(names(second.body)).toEqual(['Foxtrot', 'Echo']);
    expect(second.body.next_cursor).toBeNull();
  });

  it('in memory, a page continues after the last row served even when an earlier row was deleted (audit B1)', async () => {
    const api = t.api(admin, acmeId);
    const made: Json[] = [];
    for (const [name, amount] of [
      ['Page one', 1001],
      ['Page two', 1002],
      ['Page three', 1003],
      ['Page four', 1004],
    ] as const)
      made.push(await body(await api.post(`/boards/${boardId}/items`, { name, cells: { amount } })));
    const q = {
      filter: { kind: 'rule', column_id: 'name', operator: 'contains_text', values: ['Page '] },
      sort: [{ column_id: 'amount' }],
      limit: 2,
    };
    const first = await query(viaMemory(q) as QueryInput & { limit: number });
    expect(names(first.body)).toEqual(['Page one', 'Page two']);
    // The first row of the list goes away between the pages: an offset cursor would skip "Page three".
    expect((await api.del(`/items/${made[0]!.id}`)).status).toBe(200);
    const second = await query({ ...viaMemory(q), cursor: first.body.next_cursor } as QueryInput & { cursor: string });
    expect(names(second.body)).toEqual(['Page three', 'Page four']);
    expect(second.body.next_cursor).toBeNull();
    for (const m of made.slice(1)) await api.del(`/items/${m.id}`);
  });
});

describe('items/query — API surface', () => {
  const stuck = {
    filter: { kind: 'group', operator: 'and', rules: [{ column_id: 'status', operator: 'any_of', values: ['תקוע'] }] },
  } as QueryInput;

  it('GET /items?q= and /items/count?q= use the same query', async () => {
    const q = encodeQuery(stuck);
    const list = await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items?q=${q}`));
    expect(names(list)).toEqual(['Charlie']);
    expect(await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items/count?q=${q}`))).toEqual({ count: 1 });
    expect(await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items/count`))).toEqual({ count: 6 });
  });

  it('limits /items/count to 10 requests a second per user (429 + Retry-After)', async () => {
    const res = await Promise.all(
      Array.from({ length: 15 }, () => t.api(admin, acmeId).get(`/boards/${boardId}/items/count`)),
    );
    const limited = res.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThanOrEqual(5);
    expect(res.filter((r) => r.status === 200).length).toBeLessThanOrEqual(10);
    expect(limited[0]!.headers.get('retry-after')).toBe('1');
    expect(((await limited[0]!.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
  });

  it('rejects bad queries with 422 (strict by default: API, automation, MCP and AI callers see the error)', async () => {
    const bad = (column_id: string, operator: string) =>
      query({
        filter: { kind: 'group', operator: 'and', rules: [{ column_id, operator, values: ['x'] }] },
      } as QueryInput);
    expect((await bad('nope', 'any_of')).body.error.code).toBe('unknown_column');
    expect((await bad('box', 'contains_text')).body.error.code).toBe('invalid_operator');
    const res = await t.api(admin, acmeId).get(`/boards/${boardId}/items?q=not-json`);
    expect(res.status).toBe(422);
    expect((await query({ cursor: 'garbage' } as QueryInput)).status).toBe(422);
  });

  it('ignore_invalid_rules (saved views): rules that cannot run are skipped, the rest still filter', async () => {
    // a saved view with such a rule (old or imported data) must keep working.
    const stale = (column_id: string, operator: string, flag?: boolean) => {
      const filter = {
        kind: 'group',
        operator: 'and',
        rules: [
          { column_id, operator, values: ['x'] },
          { column_id: 'status', operator: 'any_of', values: ['תקוע'] },
        ],
      };
      return query({ filter, ...(flag === undefined ? {} : { ignore_invalid_rules: flag }) } as QueryInput);
    };
    for (const [column_id, operator] of [
      ['nope', 'any_of'],
      ['box', 'contains_text'],
    ] as const) {
      const ok = await stale(column_id, operator, true);
      expect(ok.status).toBe(200);
      expect(names(ok.body)).toEqual(['Charlie']);
      expect((await stale(column_id, operator, false)).status).toBe(422);
      expect((await stale(column_id, operator)).status).toBe(422);
    }
    // Through ?q= (GET /items) too: the only rule is skipped, so every item comes back.
    const q = encodeQuery({
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [{ column_id: 'box', operator: 'contains_text', values: ['x'] }],
      },
      ignore_invalid_rules: true,
    } as QueryInput);
    expect(names(await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items?q=${q}`)))).toHaveLength(6);
  });

  it('a member sees the same results; another account gets 404', async () => {
    expect(names((await query(stuck, bob)).body)).toEqual(['Charlie']);
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const other = (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: 'Other',
          slug: 'other',
          first_admin_email: 'admin@other.test',
          template_set: 'empty',
        }),
      )
    ).account.id;
    const otherAdmin = await join('admin@other.test');
    const res = await t.api(otherAdmin, other).post(`/boards/${boardId}/items/query`, stuck);
    expect(res.status).toBe(404);
  });
});

describe('placing an item between two others (Kanban order)', () => {
  it('moves across groups by rank, keeping its own group', async () => {
    const all = (await query({} as QueryInput)).body.data as Json[];
    const id = (name: string) => all.find((i) => i.name === name)!.id;
    // Foxtrot (g2) between Alpha and Bravo (g1): its group stays g2, its rank lands between theirs.
    const res = await t.api(admin, acmeId).post(`/items/${id('Foxtrot')}/move-to-group`, {
      group_id: ids.get('g2'),
      between: { after_id: id('Alpha'), before_id: id('Bravo') },
    });
    expect(res.status).toBe(200);
    const moved = await body(res);
    const pos = (name: string) => all.find((i) => i.name === name)!.position as string;
    expect(moved.group_id).toBe(ids.get('g2'));
    expect(moved.position > pos('Alpha') && moved.position < pos('Bravo')).toBe(true);
    // At the top of a lane: before Alpha only.
    const top = await body(
      await t.api(admin, acmeId).post(`/items/${id('Echo')}/move-to-group`, {
        group_id: ids.get('g2'),
        between: { after_id: null, before_id: id('Alpha') },
      }),
    );
    expect(top.position < pos('Alpha')).toBe(true);
  });
});

describe('items/query — the search finds subitems (every depth)', () => {
  it('keeps an item whose sub-subitem matches, by name; items without a match stay out', async () => {
    const all = (await query({} as QueryInput)).body.data as Json[];
    const delta = all.find((i) => i.name === 'Delta')!.id;
    const sub = await body(await t.api(admin, acmeId).post(`/items/${delta}/subitems`, { name: 'Middle step' }));
    const deep = await t.api(admin, acmeId).post(`/items/${sub.id}/subitems`, { name: 'Zulu deep' });
    expect(deep.status).toBe(201);
    expect(names((await query({ search: 'zulu' } as QueryInput)).body)).toEqual(['Delta']);
    expect(names((await query({ search: 'middle' } as QueryInput)).body)).toEqual(['Delta']);
    // Forced through the computed-column path: the same answer.
    expect(names((await query({ search: 'zulu' } as QueryInput)).body)).toEqual(
      names((await query(viaMemory({ search: 'zulu' }))).body),
    );
  });

  it("finds an item by a subitem's cell text too, the same in SQL and in memory (perf review)", async () => {
    const all = (await query({} as QueryInput)).body.data as Json[];
    const echo = all.find((i) => i.name === 'Echo')!.id;
    const sub = await body(await t.api(admin, acmeId).post(`/items/${echo}/subitems`, { name: 'Plain step' }));
    const col = await t.api(admin, acmeId).post(`/boards/${sub.board_id}/columns`, {
      id: 'memo',
      title: 'Memo',
      type: 'text',
    });
    expect(col.status).toBe(201);
    expect((await t.api(admin, acmeId).put(`/items/${sub.id}/cells/memo`, { value: 'Quebec note' })).status).toBe(200);
    expect(names((await query({ search: 'quebec' } as QueryInput)).body)).toEqual(['Echo']);
    expect(names((await query(viaMemory({ search: 'quebec' }))).body)).toEqual(['Echo']);
  });
});
