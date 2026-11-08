// SPDX-License-Identifier: AGPL-3.0-only
import type { AiClientFactory, AiCompletionRequest } from '@bines/server-ai';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountSettings,
  aiUsage,
  boards,
  columns,
  dashboardWidgets,
  dashboards,
  items,
  workspaces,
} from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * "How to start?": a new account's admin picks a gallery kit (the owner's starter kits marked
 * "shown") or builds a structure the AI proposed — previewed, then built in one go into the empty first workspace,
 * within the plan's boards. The AI runs on the platform's connection, capped per account; only admins build.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let adminB: string;
let acmeId: string;
let betaId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const BLUEPRINT = {
  workspace_name: 'נדל״ן',
  folders: ['מכירות'],
  boards: [
    {
      key: 'properties',
      name: 'נכסים',
      folder: 'מכירות',
      item_name: 'נכס',
      groups: [{ title: 'למכירה' }, { title: 'נמכר' }],
      columns: [
        { title: 'סטטוס', type: 'status', labels: ['חדש', 'בתהליך', 'נמכר'] },
        { title: 'מחיר', type: 'numbers' },
        { title: 'סוכן', type: 'people' },
        { title: 'תאריך כניסה', type: 'date' },
        { title: 'קונה', type: 'board_relation', link_to: 'buyers' },
      ],
      items: [
        {
          name: 'דירת 4 חדרים',
          group: 'למכירה',
          values: { סטטוס: 'בתהליך', מחיר: '2450000', 'תאריך כניסה': '2026-11-03' },
        },
        { name: 'קוטג׳', group: 'נמכר', values: { סטטוס: 'נמכר', מחיר: '4100000' } },
      ],
    },
    {
      key: 'buyers',
      name: 'קונים',
      groups: [{ title: 'חדשים' }],
      columns: [{ title: 'טלפון', type: 'phone' }],
      items: [{ name: 'קונה לדוגמה' }],
    },
  ],
  dashboard: {
    name: 'תמונת מצב',
    widgets: [
      { type: 'chart', title: 'נכסים לפי סטטוס', board: 'properties', column: 'סטטוס', chart_type: 'pie' },
      { type: 'numbers', title: 'שווי', board: 'properties', column: 'מחיר' },
      // No such column: skipped and reported, the rest is built.
      { type: 'calendar', title: 'כניסות', board: 'buyers', column: 'אין כזו' },
    ],
  },
};

/** The mocked provider: a question first, then the blueprint through the tool. */
const calls: AiCompletionRequest[] = [];
const aiClient: AiClientFactory = (conn) => ({
  provider: conn.provider,
  test: async () => ({ ok: true, error: null }),
  complete: async (req) => {
    calls.push(req);
    const usage = { input_tokens: 3000, output_tokens: 800 };
    const asked = req.messages.length > 1;
    return {
      model: req.model,
      text: asked ? 'הכנתי הצעה.' : 'כמה סוכנים יש לכם?',
      stopReason: asked ? 'tool_use' : 'end_turn',
      usage,
      costUsd: 0.2,
      content: asked
        ? [
            { type: 'text', text: 'הכנתי הצעה.', citations: null },
            { type: 'tool_use', id: 'tu1', name: 'propose_blueprint', input: BLUEPRINT },
          ]
        : [{ type: 'text', text: 'כמה סוכנים יש לכם?', citations: null }],
    } as never;
  },
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);
const pending = (accountId: string) =>
  t.db
    .select()
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId))
    .then(async ([row]) => {
      const s = (row?.settings ?? {}) as Json;
      await t.db
        .update(accountSettings)
        .set({ settings: { ...s, onboarding: { status: 'pending', choice: null, done_at: null } } })
        .where(eq(accountSettings.accountId, accountId));
    });
const liveBoards = (accountId: string) =>
  t.db
    .select()
    .from(boards)
    .where(and(eq(boards.accountId, accountId), isNull(boards.deletedAt), isNull(boards.parentBoardId)));

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
  betaId = await mk('Beta', 'beta', 'admin@beta.test');
  admin = await join('admin@acme.test');
  adminB = await join('admin@beta.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
});
afterAll(() => t.close());

describe('the gallery: starter kits the owner shows', () => {
  it('a kit marked "shown" is a card; the start screen opens by itself only while pending, for admins', async () => {
    const before = await body(await as(admin).get('/onboarding'));
    expect(before).toMatchObject({ pending: false, can_build: true, kits: [], boards_left: null });
    const res = await t.api(owner).patch('/platform/starter-kits/crm-starter', {
      gallery: { show: true, recommended: true, category: 'Sales', order: 1, illustration: 'chart' },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await body(res)).gallery).toMatchObject({ show: true, recommended: true, illustration: 'chart' });
    await pending(acmeId);
    const state = await body(await as(admin).get('/onboarding'));
    expect(state.pending).toBe(true);
    expect(state.kits).toEqual([
      expect.objectContaining({ key: 'crm-starter', installed: false, gallery: expect.objectContaining({ order: 1 }) }),
    ]);
    // A member neither sees it nor builds.
    expect(await body(await as(bob).get('/onboarding'))).toMatchObject({ pending: false, can_build: false, kits: [] });
    expect((await as(bob).post('/onboarding/kit', { kit: 'crm-starter' })).status).toBe(403);
    expect((await as(bob).post('/onboarding/build', { blueprint: BLUEPRINT })).status).toBe(403);
  });

  it('picking it builds the kit into the empty first workspace, once; the screen is then done', async () => {
    const [first] = await t.db.select().from(workspaces).where(eq(workspaces.accountId, acmeId));
    const res = await as(admin).post('/onboarding/kit', { kit: 'crm-starter' });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect((await body(res)).workspace_id).toBe(first!.id);
    const made = await liveBoards(acmeId);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((b) => b.workspaceId === first!.id)).toBe(true);
    const state = await body(await as(admin).get('/onboarding'));
    expect(state.pending).toBe(false);
    expect(state.kits[0].installed).toBe(true);
    expect((await as(admin).post('/onboarding/kit', { kit: 'crm-starter' })).status).toBe(409);
  });
});

describe('Build with AI', () => {
  it('is off until the platform connection is set; then asks, proposes, and logs the platform’s cost', async () => {
    const admB = adminB;
    const turn = (messages: Json[], blueprint?: Json) =>
      t.api(admB, betaId).post('/onboarding/ai', { messages, ...(blueprint ? { blueprint } : {}) });
    expect((await body(await t.api(admB, betaId).get('/onboarding'))).ai.available).toBe(false);
    expect((await turn([{ role: 'user', text: 'נדל״ן' }])).status).toBe(403);
    const set = await t.api(owner).patch('/platform/support/help/settings', {
      ai: { enabled: true, provider: 'anthropic', api_key: 'sk-platform-key-123456', model: 'claude-haiku-4-5' },
    });
    expect(set.status, JSON.stringify(await set.clone().json())).toBe(200);
    const state = await body(await t.api(admB, betaId).get('/onboarding'));
    expect(state.ai.available).toBe(true);
    expect(state.ai.chips.length).toBeGreaterThan(3);
    const q = await body(await turn([{ role: 'user', text: 'סוכנות נדל״ן' }]));
    expect(q).toEqual({ text: 'כמה סוכנים יש לכם?', blueprint: null });
    const p = await body(
      await turn([
        { role: 'user', text: 'סוכנות נדל״ן' },
        { role: 'assistant', text: 'כמה סוכנים יש לכם?' },
        { role: 'user', text: 'ארבעה' },
      ]),
    );
    expect(p.blueprint.boards.map((b: Json) => b.key)).toEqual(['properties', 'buyers']);
    expect(calls.at(-1)!.tools![0]!.name).toBe('propose_blueprint');
    const [usage] = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, betaId), eq(aiUsage.source, 'onboarding')));
    expect(Number(usage!.costUsd)).toBeCloseTo(0.4);
    // The account's allowance (0.5 by default) runs out: the next turn is refused.
    await turn([{ role: 'user', text: 'עוד' }]);
    const capped = await turn([{ role: 'user', text: 'עוד' }]);
    expect(capped.status).toBe(403);
    expect((await body(capped)).error.message).toBe('onboarding_ai_cap_reached');
  });

  it('builds the blueprint in one go: boards, labels, sample rows, links and the dashboard (a bad widget skipped)', async () => {
    const admB = adminB;
    const [first] = await t.db.select().from(workspaces).where(eq(workspaces.accountId, betaId));
    const res = await t.api(admB, betaId).post('/onboarding/build', { blueprint: BLUEPRINT });
    const out = await body(res);
    expect(res.status, JSON.stringify(out)).toBe(201);
    expect(out.workspace_id).toBe(first!.id);
    expect(out.issues).toEqual(['widget_skipped:calendar']);
    const [ws] = await t.db.select().from(workspaces).where(eq(workspaces.id, first!.id));
    expect(ws!.name).toBe('נדל״ן');
    const made = await liveBoards(betaId);
    expect(made.map((b) => b.name).sort()).toEqual(['נכסים', 'קונים'].sort());
    const props = made.find((b) => b.name === 'נכסים')!;
    const cols = await t.db.select().from(columns).where(eq(columns.boardId, props.id));
    const status = cols.find((c) => c.title === 'סטטוס')!;
    expect((status.settings as Json).labels.map((l: Json) => l.label)).toEqual(['חדש', 'בתהליך', 'נמכר']);
    expect(cols.find((c) => c.type === 'name')!.title).toBe('נכס');
    const link = cols.find((c) => c.type === 'board_relation')!;
    expect((link.settings as Json).board_ids).toEqual([made.find((b) => b.name === 'קונים')!.id]);
    const rows = await t.db.select().from(items).where(eq(items.boardId, props.id));
    expect(rows.map((r) => r.name).sort()).toEqual(['דירת 4 חדרים', 'קוטג׳'].sort());
    const [dash] = await t.db.select().from(dashboards).where(eq(dashboards.accountId, betaId));
    expect(dash!.name).toBe('תמונת מצב');
    const widgets = await t.db.select().from(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, dash!.id));
    expect(widgets.map((w) => w.type).sort()).toEqual(['chart', 'numbers']);
    expect((await body(await t.api(admB, betaId).get('/onboarding'))).pending).toBe(false);
  });

  it('stays within the plan: a blueprint with more boards than the plan has room for builds nothing', async () => {
    const plan = await body(
      await t.api(owner).post('/platform/plans', { name: 'Tiny', version: { limits: { boards: 3 }, features: [] } }),
    );
    expect(
      (await t.api(owner).put(`/platform/accounts/${betaId}/subscription`, { plan_version_id: plan.versions[0].id }))
        .status,
    ).toBe(200);
    const admB = adminB;
    expect((await body(await t.api(admB, betaId).get('/onboarding'))).boards_left).toBe(1);
    const res = await t.api(admB, betaId).post('/onboarding/build', { blueprint: BLUEPRINT });
    expect(res.status).toBe(402);
    expect((await body(res)).error.code).toBe('plan_limit_reached');
    expect((await liveBoards(betaId)).length).toBe(2);
    // Leaving one board out fits.
    const one = await t.api(admB, betaId).post('/onboarding/build', {
      blueprint: { ...BLUEPRINT, dashboard: undefined },
      skip_boards: ['buyers'],
      sample_data: false,
    });
    expect(one.status, JSON.stringify(await one.clone().json())).toBe(201);
    expect((await liveBoards(betaId)).length).toBe(3);
  });
});
