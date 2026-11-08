// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixMcpAutomations } from '../scripts/fix-mcp-automations.lib';
import { activityLog, automations } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** The D26 recipes (a fixture copy — the real per-account recipes are private, SEED_AUTOMATIONS_DIR). */
const SEEDS_DIR = fileURLToPath(new URL('./fixtures/seed-automations', import.meta.url));

/**
 * D26: the seed automations that waited for {{MCP_URL}} / mcp:* are rebuilt from built-in actions by
 * scripts/fix-mcp-automations — on an account with the full starter kit boards, then they run:
 * L3 (lead won → client created and linked), T1 (task's project → its client copied), S3c/S3d (SLA by priority).
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boards: Json[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);
const board = (name: string) => boards.find((b) => b.name === name)!;

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
const labelIndex = async (boardId: string, key: string, label: string) =>
  (await body(await as().get(`/boards/${boardId}`))).columns
    .find((c: Json) => c.id === key)
    .settings.labels.find((l: Json) => l.label === label).id as number;

/** What automations:seed loaded before D26 (the old recipes, inactive, "needs fixing"). */
const OLD: Record<string, { board: string; recipe: Json }> = {
  L3: {
    board: 'לידים',
    recipe: {
      trigger: { type: 'status_changed', column: 'color_mm6x5rvw', labels: ['זכינו'] },
      actions: [{ type: 'webhook', url: '{{MCP_URL}}/lead.convert', method: 'POST', payload: 'item' }],
    },
  },
  S3c: {
    board: 'כרטיסי תמיכה',
    recipe: {
      trigger: { type: 'status_changed', column: 'color_mm6xv88q', labels: ['P1 השבתה', 'P2 פגיעה'] },
      actions: [{ type: 'webhook', url: '{{MCP_URL}}/ticket.sla', method: 'POST', payload: 'item' }],
    },
  },
  T1: {
    board: 'משימות',
    recipe: {
      trigger: { type: 'item_created' },
      actions: [{ type: 'run_extension', block: 'mcp:task.inherit_account' }],
    },
  },
  Q1: {
    board: 'הצעות מחיר',
    recipe: {
      trigger: { type: 'status_changed', column: 'color_mm6xbq8z', labels: ['אושרה'] },
      actions: [{ type: 'webhook', url: '{{MCP_URL}}/quote.approve', method: 'POST', payload: 'item' }],
    },
  },
};

const ownerId = async () =>
  ((await body(await as().get('/users'))).data as Json[]).find((u) => u.email === 'admin@acme.test')!.user_id;
const bySeed = async (key: string) =>
  (
    await t.db
      .select()
      .from(automations)
      .where(and(eq(automations.accountId, acmeId), eq(automations.seedKey, key)))
  )[0];

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'bines',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const ws = (await body(await as().get('/workspaces'))).data[0];
  boards = (await body(await as().get(`/workspaces/${ws.id}/tree`))).boards;
  const owner_ = await ownerId();
  for (const [key, old] of Object.entries(OLD))
    await t.db.insert(automations).values({
      id: newId(),
      accountId: acmeId,
      boardId: board(old.board).id,
      title: key,
      recipe: old.recipe as never,
      isActive: false,
      ownerId: owner_,
      createdBy: owner_,
      seedKey: key,
      deactivatedReason: 'needs_fixing',
    });
  await drain();
});
afterAll(() => t.close());

describe('fix-mcp-automations (D26)', () => {
  it('rebuilds L3 / S3c / T1, adds S3d and keeps Q1 a webhook with an n8n placeholder', async () => {
    const report = await fixMcpAutomations(t.db, 'acme', SEEDS_DIR);
    const result = Object.fromEntries(report.map((r) => [r.key, r]));
    expect(result.L3?.result).toBe('rebuilt (inactive — switch on after a test)');
    expect(result.S3c?.result).toBe('rebuilt (inactive — switch on after a test)');
    expect(result.T1?.result).toBe('rebuilt (inactive — switch on after a test)');
    expect(result.S3d?.result).toBe('added (inactive — switch on after a test)');
    expect(result.Q1?.result).toContain('{{N8N_URL}}');
    for (const k of ['L3', 'S3c', 'T1', 'S3d']) expect(result[k]?.issues, k).toBeUndefined();

    const l3 = await bySeed('L3');
    expect(l3).toMatchObject({ isActive: false, deactivatedReason: null, revision: 2 });
    expect(l3!.recipe.actions[0]).toMatchObject({
      type: 'create_item',
      board: board('לקוחות').id,
      connect_column: 'board_relation_mm6x36x0',
    });
    expect((await bySeed('S3c'))!.recipe.actions[0]).toMatchObject({ type: 'set_date', value: 'now+4h' });
    expect((await bySeed('S3d'))!.recipe.actions[0]).toMatchObject({ type: 'set_date', value: 'now+24h' });
    expect((await bySeed('T1'))!.recipe.actions[0]).toMatchObject({ type: 'copy_from_linked', column: 'account' });
    expect(JSON.stringify((await bySeed('Q1'))!.recipe)).toContain('{{N8N_URL}}/quote.approve');

    // Running it again changes nothing.
    const again = await fixMcpAutomations(t.db, 'acme', SEEDS_DIR);
    expect(again.map((r) => r.result)).toEqual([
      'already changed by hand — left as is',
      'already changed by hand — left as is',
      'already changed by hand — left as is',
      'already has its URL — left as is',
    ]);
  });

  it('L3 runs: a won lead gets its client created (contact, phone, email) and linked both ways', async () => {
    const l3 = (await bySeed('L3'))!;
    expect((await as().post(`/automations/${l3.id}/activate`, {})).status).toBe(200);
    const leads = board('לידים');
    const lead = await body(
      await as().post(`/boards/${leads.id}/items`, {
        name: 'Dana Ltd',
        cells: {
          text_mm6xfhf6: 'Dana Levi',
          phone_mm6xspyq: { phone: '+972501234567' },
          email_mm6xp2w0: { email: 'dana@dana.test' },
        },
      }),
    );
    await drain();
    const won = await labelIndex(leads.id, 'color_mm6x5rvw', 'זכינו');
    await as().patch(`/items/${lead.id}`, { cells: { color_mm6x5rvw: { index: won } } });
    await drain();
    const after = await body(await as().get(`/items/${lead.id}`));
    const [clientId] = after.cells.board_relation_mm6x36x0.value.item_ids;
    const client = await body(await as().get(`/items/${clientId}`));
    expect(client.name).toBe('Dana Ltd');
    expect(client.board_id).toBe(board('לקוחות').id);
    expect(client.cells.text_mm6xsb4a.value).toBe('Dana Levi');
    expect(client.cells.email_mm6xjg69.value.email).toBe('dana@dana.test');
    expect(client.cells.board_relation_mm6xwczf.value.item_ids).toContain(lead.id);
  });

  it("T1 runs: setting a task's project copies the project's client", async () => {
    const t1 = (await bySeed('T1'))!;
    expect((await as().post(`/automations/${t1.id}/activate`, {})).status).toBe(200);
    const client = await body(await as().post(`/boards/${board('לקוחות').id}/items`, { name: 'Client A' }));
    const project = await body(
      await as().post(`/boards/${board('פרויקטים').id}/items`, {
        name: 'Site',
        cells: { board_relation_mm6x9vct: { item_ids: [client.id] } },
      }),
    );
    const task = await body(await as().post(`/boards/${board('משימות').id}/items`, { name: 'Design' }));
    await drain();
    await as().patch(`/items/${task.id}`, { cells: { board_relation_mm6x61vz: { item_ids: [project.id] } } });
    await drain();
    expect((await body(await as().get(`/items/${task.id}`))).cells.account.value.item_ids).toEqual([client.id]);
  });

  it('S3c / S3d run: the SLA date follows the priority in hours', async () => {
    for (const k of ['S3c', 'S3d'])
      expect((await as().post(`/automations/${(await bySeed(k))!.id}/activate`, {})).status).toBe(200);
    const tickets = board('כרטיסי תמיכה');
    const ticket = await body(await as().post(`/boards/${tickets.id}/items`, { name: 'Down' }));
    await drain();
    const p1 = await labelIndex(tickets.id, 'color_mm6xv88q', 'P1 השבתה');
    const before = Date.now();
    await as().patch(`/items/${ticket.id}`, { cells: { color_mm6xv88q: { index: p1 } } });
    await drain();
    const sla = (await body(await as().get(`/items/${ticket.id}`))).cells.date_mm6xzz5f.value;
    const at = new Date(`${sla.date}T${sla.time}:00Z`).getTime();
    expect(at - before).toBeGreaterThan(3.9 * 3_600_000);
    expect(at - before).toBeLessThan(4.1 * 3_600_000);
  });
});
