// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { activityLog, aiColumnPending, aiColumnRuns, supportStaff } from '../src/db/schema';
import { executeColumnRun, runDueAutoCells } from '../src/modules/ai2/columns.service';
import { personActor } from '../src/modules/ai2/context';
import { loadBoardAccess } from '../src/modules/boards/boards.access';
import { mergeInvitationAccess } from '../src/modules/invitations/invitations.service';
import { dispatchEvent } from '../src/modules/automations/engine/runner';
import { namesManagedElsewhere } from '../src/modules/users/admin.repo';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Security audit, the deferred low findings (docs/SECURITY-REVIEW.md S-62 … S-64)
 * - S-62 re-inviting an address merges doc / dashboard levels per object — a later inviter never raises the level
 *   an earlier inviter set on an object the later one cannot share;
 * - S-63 an account admin never renames someone whose name shows in other accounts (409 name_managed_elsewhere);
 * - S-64 an AI column run asked through a narrowed token keeps the token's board limit and scopes in the background.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let otherCookie: string;
let wsId: string;
let leadsId: string;
let elsewhereId: string;
let notesKey: string;
let connectionId: string;
let ids: Record<string, string> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);

let answer = () => 'סיכום קצר';
const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
const fakeAnthropic: AnthropicLike = {
  messages: {
    create: async (params) => {
      requests.push(structuredClone(params));
      return {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: answer(), citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Message;
    },
  },
  models: { list: async () => ({ data: [] }) },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fakeAnthropic });
const sent = () => requests.map((r) => JSON.stringify(r.messages)).join('\n');

const withToken = (token: string, method: string, path: string, payload?: unknown) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const mint = async (scopes: string[], extra: Json = {}) =>
  (await body(await as(admin).post('/auth/tokens', { name: 'Script', scopes, ...extra }))).token as string;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const refreshIds = async () => {
  const list = (await body(await as(admin).get('/users'))).data as Json[];
  ids = Object.fromEntries(list.map((u) => [u.email, u.user_id]));
  return list;
};
const newDoc = async (cookie: string, input: Json) => {
  const res = await as(cookie).post(`/workspaces/${wsId}/docs`, input);
  expect(res.status).toBe(201);
  return body(res);
};
const newItem = async (boardId: string, name: string) =>
  (await body(await as(admin).post(`/boards/${boardId}/items`, { name }))).id as string;
const dispatchSince = async (since: Date) => {
  const rows = await t.db
    .select({ id: activityLog.id, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(eq(activityLog.accountId, acmeId));
  for (const r of rows.filter((x) => x.createdAt >= since)) await dispatchEvent(t.deps, r.id);
};

beforeAll(async () => {
  t = await createTestContext({ aiClient });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  await mk('Other', 'other', 'boss@other.test');
  admin = await join('admin@acme.test');
  otherCookie = await join('boss@other.test');
  for (const email of ['bob@acme.test', 'plain@acme.test', 'staffy@acme.test'])
    await as(admin).post('/users/invite', { emails: [email], role: 'member' });
  bob = await join('bob@acme.test');
  await join('plain@acme.test');
  await join('staffy@acme.test');
  // boss@other.test also joins Acme: active in two accounts.
  await as(admin).post('/users/invite', { emails: ['boss@other.test'], role: 'member' });
  await t.api(otherCookie).post('/invitations/accept', { token: t.inviteTokenFor('boss@other.test') });
  await t.db.insert(supportStaff).values({ id: newId(), email: 'staffy@acme.test', role: 'agent', status: 'active' });
  await refreshIds();

  const a = as(admin);
  wsId = (await body(await a.get('/workspaces'))).data[0].id;
  leadsId = (await body(await a.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  elsewhereId = (await body(await a.post('/boards', { name: 'Elsewhere', workspace_id: wsId }))).id;
  notesKey = (await body(await a.post(`/boards/${leadsId}/columns`, { title: 'Notes', type: 'long_text' }))).id;
  expect((await a.patch('/ai/settings', { enabled: true })).status).toBe(200);
  connectionId = (
    await body(
      await a.post('/ai/connections', { name: 'Claude', provider: 'anthropic', api_key: 'sk-ant-test-0000000000' }),
    )
  ).id;
});
afterAll(() => t.close());
beforeEach(() => {
  requests.length = 0;
  answer = () => 'סיכום קצר';
});

describe('S-62 a re-invitation merges doc / dashboard levels per object', () => {
  it('a later inviter sets the level only on what they share; the earlier grant keeps its level', async () => {
    // Members may invite here (an account setting), so Bob can bring someone new in through his own doc.
    await as(admin).patch('/accounts/me', { settings: { permissions: { invite_members: true } } });
    const adminsDoc = await newDoc(admin, { name: 'Admin only', kind: 'private' });
    const bobsDoc = await newDoc(bob, { name: "Bob's", kind: 'private' });
    // Bob cannot share the admin's private doc at all (it does not exist for him).
    expect(
      (
        await as(bob).post(`/docs/${adminsDoc.id}/invite`, {
          emails: ['newbie@acme.test'],
          role: 'member',
          level: 'editor',
        })
      ).status,
    ).toBe(404);
    // The admin shares her doc as viewer; then Bob shares his own doc with the same new person as editor.
    expect(
      (
        await as(admin).post(`/docs/${adminsDoc.id}/invite`, {
          emails: ['newbie@acme.test'],
          role: 'member',
          level: 'viewer',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as(bob).post(`/docs/${bobsDoc.id}/invite`, {
          emails: ['newbie@acme.test'],
          role: 'member',
          level: 'editor',
        })
      ).status,
    ).toBe(200);
    const [inv] = (await body(await as(admin).get('/users/invitations'))).data.filter(
      (i: Json) => i.email === 'newbie@acme.test',
    );
    expect(inv.invited_by?.id).toBe(ids['bob@acme.test']); // one invitation, the later one replaced the first
    const newbie = await join('newbie@acme.test');
    // One invitation opened both — each at its own level: Bob's "editor" never reached the admin's doc.
    expect((await body(await as(newbie).get(`/docs/${adminsDoc.id}`))).capabilities).toMatchObject({
      'doc.read': true,
      'doc.edit': false,
    });
    expect((await body(await as(newbie).get(`/docs/${bobsDoc.id}`))).capabilities).toMatchObject({
      'doc.read': true,
      'doc.edit': true,
    });
  });

  it('the same object shared again by someone who may share it takes the new level', async () => {
    const doc = await newDoc(admin, { name: 'Again', kind: 'private' });
    for (const level of ['viewer', 'editor'])
      expect(
        (await as(admin).post(`/docs/${doc.id}/invite`, { emails: ['again@acme.test'], role: 'member', level })).status,
      ).toBe(200);
    const again = await join('again@acme.test');
    expect((await body(await as(again).get(`/docs/${doc.id}`))).capabilities).toMatchObject({ 'doc.edit': true });
  });

  it('merge: per object; an older single-level invitation keeps its level for its own objects', () => {
    expect(
      mergeInvitationAccess(
        { doc_ids: ['d1'], doc_level: 'viewer', dashboard_ids: ['x1'], dashboard_level: 'viewer' },
        {
          doc_ids: ['d2'],
          doc_levels: { d2: 'owner' },
          dashboard_ids: ['x2'],
          dashboard_levels: { x2: 'editor' },
        },
      ),
    ).toEqual({
      doc_ids: ['d1', 'd2'],
      doc_levels: { d1: 'viewer', d2: 'owner' },
      dashboard_ids: ['x1', 'x2'],
      dashboard_levels: { x1: 'viewer', x2: 'editor' },
    });
    // A payload that names a level for an object it does not share gives nothing for that object.
    expect(
      mergeInvitationAccess({ doc_ids: ['d1'], doc_levels: { d1: 'viewer' } }, { doc_levels: { d1: 'owner' } }),
    ).toEqual({ doc_ids: ['d1'], doc_levels: { d1: 'viewer' } });
  });
});

describe('S-63 an admin renames only people whose name shows nowhere else', () => {
  it('the list says whose name is managed elsewhere (admins only)', async () => {
    const list = await refreshIds();
    const flag = (email: string) => list.find((u) => u.email === email)?.name_managed_elsewhere;
    expect(flag('boss@other.test')).toBe(true);
    expect(flag('staffy@acme.test')).toBe(true);
    expect(flag('plain@acme.test')).toBe(false);
    expect(flag('admin@acme.test')).toBe(false); // your own name is yours to change
    const asMember = (await body(await as(bob).get('/users'))).data as Json[];
    expect(asMember.every((u) => u.name_managed_elsewhere === null)).toBe(true);
  });

  it('409 for someone active in another account and for support staff; other fields still change', async () => {
    for (const email of ['boss@other.test', 'staffy@acme.test']) {
      const res = await as(admin).patch(`/users/${ids[email]}`, { name: 'Renamed' });
      expect(res.status, email).toBe(409);
      expect((await body(res)).error.message).toBe('name_managed_elsewhere');
    }
    const me = await body(await t.api(otherCookie).get('/auth/me'));
    expect(me.user.name).not.toBe('Renamed');
    // Not the name: the title is this account's own — allowed.
    const res = await as(admin).patch(`/users/${ids['boss@other.test']}`, { title: 'Partner' });
    expect(res.status).toBe(200);
    expect((await body(res)).title).toBe('Partner');
  });

  it('the platform owner counts as managed elsewhere', async () => {
    const ownerId = (await body(await t.api(owner).get('/auth/me'))).user.id as string;
    const plainId = ids['plain@acme.test']!;
    expect([...(await namesManagedElsewhere(t.db, acmeId, [ownerId, plainId]))]).toEqual([ownerId]);
  });

  it('allowed for someone only in this account, and for yourself', async () => {
    const res = await as(admin).patch(`/users/${ids['plain@acme.test']}`, { name: 'Plain Person' });
    expect(res.status).toBe(200);
    expect((await body(res)).name).toBe('Plain Person');
    expect((await as(admin).patch(`/users/${ids['admin@acme.test']}`, { name: 'The Admin' })).status).toBe(200);
  });
});

describe('S-64 an AI column run keeps the token’s board limit and scopes in the background', () => {
  let aiKey: string;
  beforeAll(async () => {
    const res = await as(admin).post(`/boards/${leadsId}/columns`, {
      title: 'Summary',
      type: 'ai',
      settings: {
        connection_id: connectionId,
        model: 'claude-haiku-4-5',
        inputs: [notesKey],
        include_updates: true,
        auto_run: true,
      },
    });
    expect(res.status).toBe(201);
    aiKey = (await body(res)).id;
  });

  it('a background actor made with a board limit sees only those boards', async () => {
    const limited = await personActor(t.db, acmeId, ids['admin@acme.test']!, 'test', { boardLimit: [leadsId] });
    expect(limited.ctx.boardLimit).toEqual([leadsId]);
    await expect(loadBoardAccess(t.db, limited.ctx, limited.user, elsewhereId)).rejects.toMatchObject({
      code: 'not_found',
    });
    const free = await personActor(t.db, acmeId, ids['admin@acme.test']!, 'test');
    expect(free.ctx.boardLimit).toBeNull();
    expect((await loadBoardAccess(t.db, free.ctx, free.user, elsewhereId)).board.id).toBe(elsewhereId);
  });

  it('a run asked by a token stores its limit and scopes, and the job runs within them', async () => {
    const token = await mint(['items:write'], { board_ids: [leadsId] });
    const items = [await newItem(leadsId, 'Lead 1'), await newItem(leadsId, 'Lead 2')];
    await as(admin).post(`/items/${items[0]}/updates`, { body: 'UPDATE-ONLY-FOR-READERS' });
    const res = await withToken(token, 'POST', `/boards/${leadsId}/ai-columns/${aiKey}/run`, {
      mode: 'items',
      item_ids: items,
    });
    expect(res.status).toBe(200);
    const runId = (await body(res)).id as string;
    const [row] = await t.db.select().from(aiColumnRuns).where(eq(aiColumnRuns.id, runId));
    expect(row!.boardLimit).toEqual([leadsId]);
    expect(row!.tokenScopes).toEqual(['items:write']);
    expect(requests.length).toBeGreaterThan(0);
    expect(sent()).not.toContain('UPDATE-ONLY-FOR-READERS'); // the token cannot read updates

    // The same run queued for the job (no request around it): what is stored on the run decides.
    const queue = async (p: { boardLimit: string[] | null; tokenScopes: string[] | null }) => {
      requests.length = 0;
      const [copy] = await t.db
        .insert(aiColumnRuns)
        .values({
          ...row!,
          ...p,
          id: newId(),
          batchId: newId(),
          status: 'queued',
          done: 0,
          failed: 0,
          skipped: 0,
          costUsd: 0,
          errors: [],
          stopped: null,
          finishedAt: null,
          createdAt: new Date(),
        })
        .returning();
      return executeColumnRun(t.deps, copy!.id);
    };
    // Limited to another board: the run's own board does not exist for it — nothing is read or sent.
    const outside = await queue({ boardLimit: [elsewhereId], tokenScopes: ['items:write'] });
    expect(requests).toHaveLength(0);
    expect(outside.done).toBe(0);
    expect(outside.skipped).toBe(2);
    // Within the limit, without updates:read: filled, the update never sent.
    const inside = await queue({ boardLimit: [leadsId], tokenScopes: ['items:write'] });
    expect(inside.done).toBe(2);
    expect(sent()).not.toContain('UPDATE-ONLY-FOR-READERS');
    // Asked by the person in the app (nothing stored): the update is part of the input, as the column asks.
    const person = await queue({ boardLimit: null, tokenScopes: null });
    expect(person.done).toBe(2);
    expect(sent()).toContain('UPDATE-ONLY-FOR-READERS');
  });

  it('an auto-run started by a narrowed token keeps its limit and scopes; a session change has none', async () => {
    const token = await mint(['items:write'], { board_ids: [leadsId] });
    const item = await newItem(leadsId, 'Auto lead');
    await as(admin).post(`/items/${item}/updates`, { body: 'AUTO-UPDATE-HIDDEN' });
    const since = new Date(Date.now() - 1);
    const put = await withToken(token, 'PUT', `/items/${item}/cells/${notesKey}`, { value: { text: 'from token' } });
    expect(put.status).toBe(200);
    await dispatchSince(since);
    const [pending] = await t.db.select().from(aiColumnPending).where(eq(aiColumnPending.itemId, item));
    expect(pending!.boardLimit).toEqual([leadsId]);
    expect(pending!.tokenScopes).toEqual(['items:write']);
    expect(await runDueAutoCells(t.deps, new Date(Date.now() + 60_000))).toBe(1);
    expect(sent()).toContain('from token');
    expect(sent()).not.toContain('AUTO-UPDATE-HIDDEN');

    // The same person in the app: no limit, and the updates are read.
    requests.length = 0;
    const since2 = new Date(Date.now() - 1);
    await as(admin).put(`/items/${item}/cells/${notesKey}`, { value: { text: 'from the app' } });
    await dispatchSince(since2);
    const [again] = await t.db.select().from(aiColumnPending).where(eq(aiColumnPending.itemId, item));
    expect(again!.boardLimit).toBeNull();
    expect(again!.tokenScopes).toBeNull();
    expect(await runDueAutoCells(t.deps, new Date(Date.now() + 60_000))).toBe(1);
    expect(sent()).toContain('AUTO-UPDATE-HIDDEN');
  });

  it('a token that may read updates is not stamped (an unlimited token adds nothing to the events)', async () => {
    const token = await mint(['items:write', 'updates:read']);
    const item = await newItem(leadsId, 'Plain token lead');
    const since = new Date(Date.now() - 1);
    expect((await withToken(token, 'PUT', `/items/${item}/cells/${notesKey}`, { value: { text: 'x' } })).status).toBe(
      200,
    );
    const rows = await t.db.select().from(activityLog).where(eq(activityLog.itemId, item));
    const meta = rows.filter((r) => r.createdAt >= since).map((r) => (r.payload as Json).meta ?? {});
    expect(meta.length).toBeGreaterThan(0);
    for (const m of meta) {
      expect(m.board_limit).toBeUndefined();
      expect(m.token_scopes).toBeUndefined();
    }
  });
});
