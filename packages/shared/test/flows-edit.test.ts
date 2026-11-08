// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  aiTool,
  applyFlowEdits,
  diffN8nWorkflows,
  EXTERNAL_PLATFORM_TOOLS,
  extractTemplate,
  FLOW_PLATFORM_CAPS,
  flowDiffDetails,
  flowEditDetails,
  flowEditsSchema,
  FlowEditError,
  flowPagePath,
  matchTrigger,
  needsApproval,
  type N8nWorkflowFull,
  recipeSchema,
  triggerSentence,
  validateRecipe,
} from '../src';

/**
 * (edit / operate external flows with the AI) and (automations on flow failures): the edit
 * vocabulary over an n8n workflow, its diff, the new tools' risk, and the flow triggers (match, validate, sentence,
 * templates, the deep link).
 */
const WF: N8nWorkflowFull = {
  id: 'w1',
  name: 'Leads → SMS',
  active: true,
  nodes: [
    { id: 'n1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: {} },
    {
      id: 'n2',
      name: 'HTTP Request',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [260, 0],
      parameters: { method: 'POST', url: 'https://sms.example.com/a' },
      credentials: { httpHeaderAuth: { id: 'c1', name: 'SMS key' } },
    },
    {
      id: 'n3',
      name: 'Code',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [520, 0],
      parameters: { jsCode: 'return items;' },
    },
  ],
  connections: {
    Webhook: { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
    'HTTP Request': { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};

describe('editing an n8n workflow in the safe vocabulary', () => {
  it('add_step after a node: inserted in the line, the rest untouched (credentials, code)', () => {
    const after = applyFlowEdits(WF, [
      { op: 'add_step', after: 'Webhook', step: { kind: 'wait', minutes: 5 } as never },
    ]);
    expect(after.nodes.map((n) => n.name)).toEqual(['Webhook', 'HTTP Request', 'Code', 'Wait']);
    expect(after.connections.Webhook!.main![0]).toEqual([{ node: 'Wait', type: 'main', index: 0 }]);
    expect(after.connections.Wait!.main![0]).toEqual([{ node: 'HTTP Request', type: 'main', index: 0 }]);
    expect(after.nodes[1]).toEqual(WF.nodes[1]);
    expect(after.nodes[2]).toEqual(WF.nodes[2]);
    // The original is never changed.
    expect(WF.nodes).toHaveLength(3);
    const diff = diffN8nWorkflows(WF, after);
    expect(diff.map((d) => d.kind)).toEqual(['added', 'relinked']);
    expect(flowDiffDetails(diff)[0]).toEqual({ field: 'flow_diff_added', text: '"Wait" (n8n-nodes-base.wait)' });
  });

  it('replace_step keeps credentials only on the same node type; parameters are the step’s own', () => {
    const same = applyFlowEdits(WF, [
      {
        op: 'replace_step',
        node: 'HTTP Request',
        step: { kind: 'http_request', method: 'POST', url: 'https://sms.example.com/b' } as never,
      },
    ]);
    const http = same.nodes.find((n) => n.name === 'HTTP Request')!;
    expect(http.credentials).toEqual(WF.nodes[1]!.credentials);
    expect(http.parameters.url).toBe('https://sms.example.com/b');
    const diff = diffN8nWorkflows(WF, same);
    expect(diff).toContainEqual({
      kind: 'changed',
      node: 'HTTP Request',
      field: 'url',
      before: 'https://sms.example.com/a',
      after: 'https://sms.example.com/b',
    });
    const other = applyFlowEdits(WF, [
      { op: 'replace_step', node: 'HTTP Request', step: { kind: 'wait', minutes: 1 } as never },
    ]);
    expect(other.nodes.find((n) => n.name === 'HTTP Request')!.credentials).toBeUndefined();
  });

  it('remove_step relinks around it; rename_step follows the links; the trigger is never removed', () => {
    const removed = applyFlowEdits(WF, [{ op: 'remove_step', node: 'HTTP Request' }]);
    expect(removed.nodes.map((n) => n.name)).toEqual(['Webhook', 'Code']);
    expect(removed.connections.Webhook!.main![0]).toEqual([{ node: 'Code', type: 'main', index: 0 }]);
    const renamed = applyFlowEdits(WF, [{ op: 'rename_step', node: 'HTTP Request', name: 'Send SMS' }]);
    expect(renamed.connections.Webhook!.main![0]![0]!.node).toBe('Send SMS');
    expect(renamed.connections['Send SMS']).toBeDefined();
    expect(diffN8nWorkflows(WF, renamed).map((d) => d.kind)).toEqual(['renamed']);
    expect(() => applyFlowEdits(WF, [{ op: 'remove_step', node: 'Webhook' }])).toThrow(FlowEditError);
    expect(() => applyFlowEdits(WF, [{ op: 'remove_step', node: 'Nope' }])).toThrow('flow_edit_node_not_found');
  });

  it('set_trigger swaps the start; rename_flow renames', () => {
    const out = applyFlowEdits(WF, [
      { op: 'set_trigger', trigger: { kind: 'schedule', every: 'hours', interval: 2 } as never },
      { op: 'rename_flow', name: 'Every 2 hours' },
    ]);
    expect(out.nodes[0]).toMatchObject({ name: 'Webhook', type: 'n8n-nodes-base.scheduleTrigger' });
    expect(out.name).toBe('Every 2 hours');
    expect(diffN8nWorkflows(WF, out)[0]).toMatchObject({ kind: 'flow_renamed', after: 'Every 2 hours' });
  });

  it('the vocabulary refuses code, unknown operations and more than 20 edits', () => {
    expect(
      flowEditsSchema.safeParse([{ op: 'add_step', after: 'Webhook', step: { kind: 'code', js: 'x' } }]).success,
    ).toBe(false);
    expect(flowEditsSchema.safeParse([{ op: 'set_parameter', node: 'Code', value: 'x' }]).success).toBe(false);
    expect(
      flowEditsSchema.safeParse(Array.from({ length: 21 }, () => ({ op: 'rename_flow', name: 'x' }))).success,
    ).toBe(false);
    expect(flowEditDetails([{ op: 'remove_step', node: 'Code' }])).toEqual([
      { field: 'flow_edit_remove_step', text: '"Code"' },
    ]);
  });
});

describe('the operate / edit tools', () => {
  it('every write is sensitive (an approval, always); the reads are reads; plain JSON schemas', () => {
    for (const name of ['flows_set_active', 'flows_rerun', 'flows_update_draft']) {
      const tool = aiTool(name)!;
      expect(tool.risk, name).toBe('sensitive');
      expect(EXTERNAL_PLATFORM_TOOLS).toContain(name);
      expect(needsApproval(tool, { approval_mode: 'autonomous', approval_tools: [] })).toBe(true);
      expect(JSON.stringify(z.toJSONSchema(tool.input, { io: 'input' }))).not.toContain('$ref');
    }
    expect(aiTool('flows_explain_failure')!.risk).toBe('read');
    expect(aiTool('flows_get')!.risk).toBe('read');
    expect(
      aiTool('flows_update_draft')!.input.parse({
        connection_id: 'c',
        flow_id: 'w',
        edits: [{ op: 'rename_flow', name: 'x' }],
      }),
    ).toMatchObject({ keep_active: false });
    expect(FLOW_PLATFORM_CAPS.n8n.edit).toBe(true);
    expect(FLOW_PLATFORM_CAPS.make.edit).toBe(false);
  });
});

describe('automations on external flows', () => {
  const ev = (meta: Record<string, unknown>, type = 'flow.failed') => ({
    id: 'e1',
    type,
    board_id: 'b1',
    item_id: null,
    meta,
    actor: { type: 'system', id: null },
  });
  const flow = { connection_id: 'C1', flow_id: 'w1', run_id: 'r1', name: 'Leads' };
  const ctx = (automationId: string) => ({ automationId, columns: [] });

  it('a flow event matches its connection / flow, and only the automations it lists', () => {
    const any = recipeSchema.parse({
      trigger: { type: 'flow_failed' },
      actions: [{ type: 'notify', to: '@actor', message: 'x' }],
    });
    expect(any.trigger).toEqual({ type: 'flow_failed', connection: 'any' });
    expect(matchTrigger(any.trigger, ev({ flow, automation_ids: ['A1'] }), ctx('A1'))).toBe(true);
    expect(matchTrigger(any.trigger, ev({ flow, automation_ids: ['A1'] }), ctx('A2'))).toBe(false);
    expect(matchTrigger(any.trigger, ev({ flow, automation_ids: ['A1'] }, 'flow.recovered'), ctx('A1'))).toBe(false);
    const one = { type: 'flow_failed' as const, connection: 'C1', flow: 'w2' };
    expect(matchTrigger(one, ev({ flow }), ctx('A1'))).toBe(false);
    expect(matchTrigger({ ...one, flow: 'w1' }, ev({ flow }), ctx('A1'))).toBe(true);
    expect(matchTrigger({ ...one, connection: 'C2', flow: undefined }, ev({ flow }), ctx('A1'))).toBe(false);
    const rec = { type: 'flow_recovered' as const, connection: 'any' };
    expect(matchTrigger(rec, ev({ flow }, 'flow.recovered'), ctx('A1'))).toBe(true);
  });

  it('validate: board-level runs; {flow.*} only with a flow trigger, and only known fields', () => {
    const board = {
      columns: [{ key: 'status', type: 'status', title: 'Status', settings: { labels: [] } }],
      groups: [],
    };
    const ok = validateRecipe(
      recipeSchema.parse({
        trigger: { type: 'flow_failed' },
        actions: [{ type: 'notify', to: '@board_owners', message: '{flow.name}: {flow.error} {flow.url}' }],
      }),
      board,
    );
    expect(ok).toEqual({ errors: [], warnings: [] });
    const wrong = validateRecipe(
      recipeSchema.parse({
        trigger: { type: 'flow_failed' },
        actions: [
          { type: 'notify', to: '@board_owners', message: '{flow.nope}' },
          { type: 'clear_column', column: 'status' },
        ],
      }),
      board,
    );
    expect(wrong.warnings).toContainEqual({ path: 'actions.0.message', code: 'unknown_template', detail: 'flow.nope' });
    expect(wrong.errors).toContainEqual({ path: 'actions.1.type', code: 'needs_item' });
    const outside = validateRecipe(
      recipeSchema.parse({
        trigger: { type: 'item_created' },
        actions: [{ type: 'notify', to: '@board_owners', message: '{flow.error}' }],
      }),
      board,
    );
    expect(outside.warnings[0]).toMatchObject({ code: 'flow_vars_without_flow_trigger' });
  });

  it('a template never carries this account’s connection or flow', () => {
    const { recipe } = extractTemplate(
      {
        trigger: { type: 'flow_failed', connection: 'C1', flow: 'w1' },
        actions: [{ type: 'notify', to: '@actor', message: 'x' }],
      },
      { columns: [], groups: [] },
    );
    expect(recipe.trigger).toEqual({ type: 'flow_failed', connection: 'any' });
  });

  it('the deep link to a flow (and run) in the flows screen', () => {
    expect(flowPagePath('acme', { connection_id: 'C1', flow_id: 'w 1', run_id: '9' })).toBe(
      '/a/acme/flows?connection=C1&flow=w+1&run=9',
    );
    expect(flowPagePath('acme', { connection_id: 'C1' })).toBe('/a/acme/flows?connection=C1');
  });

  it('the sentence names the connection and the flow (blanks)', () => {
    const parts = triggerSentence(
      { type: 'flow_failed', connection: 'C1', flow: 'w1' },
      {
        columns: [],
        groups: [],
        flowConnectionName: (id) => (id === 'C1' ? 'n8n שלנו' : undefined),
        flowName: (_c, id) => (id === 'w1' ? 'Leads' : undefined),
      },
    );
    expect(parts.find((p) => p.slot === 'trigger.connection')?.text).toBe('n8n שלנו');
    expect(parts.find((p) => p.slot === 'trigger.flow')?.text).toBe('Leads');
  });
});
