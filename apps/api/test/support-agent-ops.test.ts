// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { type AiClientFactory, type AnthropicLike, createAiClient } from '@bines/server-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { errorEvents, items, supportAgentRuns, supportTicketMessages } from '../src/db/schema';
import { flushErrors, recordError } from '../src/modules/errors/errors.writer';
import { notePrOnOpsTasks } from '../src/modules/support-agent/ops-tasks';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Ops tasks: the support agent proposes a task for the operations team; the types (board and group
 * per kind of issue, one default) are settings an account admin chooses; an approved proposal opens the item there as
 * the approving person — never past their access — with the description, why, and the link back; a draft PR opened
 * later is noted on it.
 */
let t: TestContext;
let db: Db;
let owner: string;
let lead: string;
let agent: string;
let opsId: string;
let codeBoard: string;
let dataBoard: string;
let urgent: string;
let errorId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

type Turn = { content: Anthropic.ContentBlock[]; stop: string };
let script: (n: number) => Turn;
const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
const end = (): Turn => ({
  content: [{ type: 'text', text: 'done', citations: null } as Anthropic.TextBlock],
  stop: 'end_turn',
});
const plays =
  (...calls: [string, Json][]) =>
  (n: number): Turn =>
    n < calls.length
      ? {
          content: [
            { type: 'tool_use', id: `tu_${n}`, name: calls[n]![0], input: calls[n]![1] } as Anthropic.ToolUseBlock,
          ],
          stop: 'tool_use',
        }
      : end();
const fakeAnthropic: AnthropicLike = {
  messages: {
    create: async (params) => {
      requests.push(structuredClone(params));
      const turn = script(params.messages.filter((m) => m.role === 'assistant').length);
      return {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: turn.content,
        stop_reason: turn.stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as Anthropic.Message;
    },
  },
  models: { list: async () => ({ data: [] }) },
};
const aiClient: AiClientFactory = (conn) => createAiClient(conn, { anthropic: fakeAnthropic });

const report = {
  summary: 'An automation points to a deleted column.',
  root_cause: 'column 7 was deleted while an automation used it',
  evidence: [],
  impact: 'one account',
  proposed_fix: 'skip missing columns',
  confidence: 'medium',
};
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const settings = (cookie: string, patch: Json) => t.api(cookie).patch('/platform/support-agent/settings', patch);

beforeAll(async () => {
  t = await createTestContext({ aiClient });
  db = t.db as unknown as Db;
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  opsId = await mk('Ops', 'ops', 'lead@ops.test');
  await mk('Desk', 'desk', 'agent@ops.test');
  lead = await join('lead@ops.test');
  agent = await join('agent@ops.test');
  await t.api(owner).post('/platform/support/staff', { email: 'lead@ops.test', role: 'lead' });
  await t.api(owner).post('/platform/support/staff', { email: 'agent@ops.test', role: 'agent' });
  const ws = (await body(await t.api(lead, opsId).get('/workspaces'))).data[0].id;
  codeBoard = (await body(await t.api(lead, opsId).post('/boards', { name: 'Dev tasks', workspace_id: ws }))).id;
  dataBoard = (await body(await t.api(lead, opsId).post('/boards', { name: 'Data fixes', workspace_id: ws }))).id;
  urgent = (await body(await t.api(lead, opsId).post(`/boards/${codeBoard}/groups`, { title: 'Urgent' }))).id;

  await t.api(lead).patch('/platform/support/help/settings', {
    ai: { enabled: true, provider: 'anthropic', api_key: 'sk-platform-key-123456', model: 'claude-haiku-4-5' },
  });
  await settings(lead, { enabled: true });
  recordError(db, { source: 'automation', code: 'column_not_found', message: 'column 7 missing', accountId: opsId });
  await flushErrors(db);
  errorId = (await db.select().from(errorEvents))[0]!.id;
});
afterAll(async () => {
  await t.close();
});

describe('support agent: ops tasks', () => {
  it('types are boards of an account where the person is an admin; one default; names shown', async () => {
    // Boards and groups to choose from — only in an account where I am an admin.
    const boards = await body(await t.api(lead).get(`/platform/support-agent/ops-boards?account_id=${opsId}`));
    expect(boards.data.map((b: Json) => b.name)).toEqual(expect.arrayContaining(['Dev tasks', 'Data fixes']));
    expect(boards.data.find((b: Json) => b.id === codeBoard).groups.map((g: Json) => g.name)).toContain('Urgent');
    expect((await t.api(agent).get(`/platform/support-agent/ops-boards?account_id=${opsId}`)).status).toBe(403);

    // Settings: leads only; a board outside my accounts or a group not on the board is refused.
    const code = { name: 'Code', hint: 'a bug that needs a code change', account_id: opsId, board_id: codeBoard };
    expect((await settings(agent, { ops_tasks: [code] })).status).toBe(403);
    const elsewhere = await body(await t.api(owner).get('/platform/support-agent/connections'));
    expect(elsewhere.accounts.some((a: Json) => a.id === opsId)).toBe(false);
    expect((await settings(owner, { ops_tasks: [code] })).status).toBe(403);
    expect((await settings(lead, { ops_tasks: [{ ...code, group_id: dataBoard }] })).status).toBe(422);

    const res = await settings(lead, {
      ops_tasks: [
        { ...code, group_id: urgent },
        { name: 'Data', account_id: opsId, board_id: dataBoard, is_default: true },
      ],
    });
    const saved = await body(res);
    expect(res.status, JSON.stringify(saved)).toBe(200);
    expect(saved.ops_tasks).toMatchObject([
      { name: 'Code', account_name: 'Ops', board_name: 'Dev tasks', group_name: 'Urgent', is_default: false },
      { name: 'Data', board_name: 'Data fixes', group_name: null, is_default: true, missing: false },
    ]);
    // Same names twice: refused.
    expect((await settings(lead, { ops_tasks: [code, { ...code, name: 'code' }] })).status).toBe(422);
  });

  it('the agent sees the types; proposes; nothing opens until approved; opens as the approver, linked back', async () => {
    script = plays(
      [
        'propose_action',
        {
          kind: 'open_ops_task',
          reason: 'the automation needs a guard',
          title: 'Skip missing columns in automations',
          body: 'Make the action skip a deleted column.',
          ops_type: 'Code',
        },
      ],
      ['propose_action', { kind: 'open_ops_task', reason: 'no title' }],
      ['submit_report', report],
    );
    requests.length = 0;
    const run = await body(await t.api(agent).post('/platform/support-agent/runs', { error_id: errorId }));
    expect(run.status).toBe('succeeded');
    expect(JSON.stringify(requests[0]!.system)).toContain('- Code: a bug that needs a code change');
    expect(JSON.stringify(requests[0]!.system)).toContain('- Data (default)');
    expect(run.actions).toHaveLength(1); // the one without a title / body was refused to the model
    const proposal = run.actions[0];
    expect(proposal).toMatchObject({
      kind: 'open_ops_task',
      status: 'pending',
      payload: { title: expect.any(String) },
    });
    const types = (await body(await t.api(lead).get('/platform/support-agent/settings'))).ops_tasks as Json[];
    expect(proposal.payload.ops_type).toBe(types.find((x) => x.name === 'Code')!.id);
    expect(await db.select().from(items).where(eq(items.boardId, codeBoard))).toHaveLength(0);

    // The agent staff member is not a member of Ops: approving cannot open a task there.
    const refused = await t.api(agent).post(`/platform/support-agent/actions/${proposal.id}`, { approve: true });
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.message).toBe('support_agent_ops_not_member');

    // The lead approves (renamed): the item opens on the type's board and group, with its description.
    const decided = await body(
      await t.api(lead).post(`/platform/support-agent/actions/${proposal.id}`, {
        approve: true,
        title: 'Guard deleted columns',
      }),
    );
    const task = decided.actions[0].payload.task;
    expect(decided.actions[0].status).toBe('approved');
    expect(task).toMatchObject({ account_id: opsId, board_id: codeBoard, type: 'Code' });
    expect(task.url).toContain(`/a/ops/b/${codeBoard}/i/${task.item_id}`);
    const [item] = await db.select().from(items).where(eq(items.id, task.item_id));
    expect(item).toMatchObject({ name: 'Guard deleted columns', groupId: urgent });
    const updates = (await body(await t.api(lead, opsId).get(`/items/${task.item_id}/updates`))).data as Json[];
    const text = JSON.stringify(updates);
    expect(text).toContain('Make the action skip a deleted column.');
    expect(text).toContain('the automation needs a guard');
    expect(text).toContain(`/owner?section=errors&error=${errorId}`);

    // A draft PR opened later (approve development): its link on the task.
    const [row] = await db
      .update(supportAgentRuns)
      .set({ devPrUrl: 'https://github.com/bines/platform/pull/9' })
      .where(eq(supportAgentRuns.id, run.id))
      .returning();
    await notePrOnOpsTasks(t.deps, row!, 'en');
    const after = JSON.stringify((await body(await t.api(lead, opsId).get(`/items/${task.item_id}/updates`))).data);
    expect(after).toContain('pull/9');
  });

  it('no type named = the default; the approver may choose another; a ticket gets a note', async () => {
    const opened = await body(await t.api(lead).post(`/platform/errors/${errorId}/ticket`, {}));
    const ticketId = opened.ticket.id as string;
    script = plays(
      ['propose_action', { kind: 'open_ops_task', reason: 'r', title: 'Fix the data', body: 'Restore column 7.' }],
      ['submit_report', report],
    );
    const run = await body(await t.api(lead).post('/platform/support-agent/runs', { ticket_id: ticketId }));
    const types = (await body(await t.api(lead).get('/platform/support-agent/settings'))).ops_tasks as Json[];
    const proposal = run.actions?.find((a: Json) => a.kind === 'open_ops_task');
    expect(proposal, JSON.stringify(run)).toBeTruthy();
    expect(proposal.payload.ops_type).toBe(types.find((x) => x.is_default)!.id);

    const code = types.find((x) => x.name === 'Code')!.id;
    const decided = await body(
      await t.api(lead).post(`/platform/support-agent/actions/${proposal.id}`, { approve: true, ops_type: code }),
    );
    expect(decided.actions.find((a: Json) => a.id === proposal.id).payload.task.board_id).toBe(codeBoard);
    const notes = await db
      .select()
      .from(supportTicketMessages)
      .where(and(eq(supportTicketMessages.ticketId, ticketId), eq(supportTicketMessages.visibility, 'internal')));
    expect(notes.some((n) => n.body.includes('/i/'))).toBe(true);
  });

  it('without types the agent is not told about them and cannot propose one', async () => {
    await settings(lead, { ops_tasks: [] });
    script = plays(
      ['propose_action', { kind: 'open_ops_task', reason: 'r', title: 'x', body: 'y' }],
      ['submit_report', report],
    );
    requests.length = 0;
    const run = await body(await t.api(lead).post('/platform/support-agent/runs', { error_id: errorId }));
    expect(run.status).toBe('succeeded');
    expect(run.actions).toHaveLength(0);
    expect(JSON.stringify(requests[0]!.system)).not.toContain('open_ops_task with');
  });
});
