// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  aiTool,
  createFlowConnectionSchema,
  describeFlowDraft,
  EXTERNAL_PLATFORM_TOOLS,
  FLOW_PLATFORM_CAPS,
  flowConnectionSettingsSchema,
  flowDraftSchema,
  isSensitiveTool,
  N8N_BINES_NODE,
  N8N_BINES_TRIGGER,
  needsApproval,
  platformSettingsSchema,
  toN8nWorkflow,
} from '../src';

const draft = flowDraftSchema.parse({
  name: 'ליד חדש → SMS',
  trigger: { kind: 'bines_event', event: 'item_created', board_id: 'b1' },
  steps: [
    { kind: 'if', left: '={{ $json.item.phone }}', operator: 'is_not_empty' },
    { kind: 'http_request', method: 'POST', url: 'https://sms.example.com/send', body: { to: '={{ $json.phone }}' } },
    { kind: 'bines', resource: 'update', operation: 'create', item_id: '={{ $json.item.id }}', text: 'SMS sent' },
    { kind: 'bines', resource: 'item', operation: 'update', board_id: 'b1', columns: { status: 'Contacted' } },
  ],
});

describe('flow drafts → n8n', () => {
  it('compiles a line of nodes: our trigger, core nodes, our action node', () => {
    const wf = toN8nWorkflow(draft);
    expect(wf.name).toBe('ליד חדש → SMS');
    expect(wf.settings).toEqual({ executionOrder: 'v1' });
    expect(wf.nodes.map((n) => n.type)).toEqual([
      N8N_BINES_TRIGGER,
      'n8n-nodes-base.if',
      'n8n-nodes-base.httpRequest',
      N8N_BINES_NODE,
      N8N_BINES_NODE,
    ]);
    // Unique names, a line of connections.
    expect(new Set(wf.nodes.map((n) => n.name)).size).toBe(wf.nodes.length);
    expect(Object.keys(wf.connections)).toHaveLength(wf.nodes.length - 1);
    expect(wf.connections[wf.nodes[0]!.name]!.main[0]![0]!.node).toBe(wf.nodes[1]!.name);
    expect(wf.nodes[0]!.parameters).toMatchObject({ boardId: 'b1', event: 'item_created' });
    const http = wf.nodes[2]!.parameters as { jsonBody: string; sendBody: boolean };
    expect(http.sendBody).toBe(true);
    expect(JSON.parse(http.jsonBody)).toEqual({ to: '={{ $json.phone }}' });
    expect(wf.nodes[4]!.parameters).toMatchObject({
      resource: 'item',
      operation: 'update',
      columns: { mappingMode: 'defineBelow', value: { status: 'Contacted' } },
    });
    // No credentials, no code — ever.
    expect(JSON.stringify(wf)).not.toContain('credentials');
    expect(wf.nodes.some((n) => n.type.includes('code') || n.type.includes('function'))).toBe(false);
  });

  it('refuses what is not in the vocabulary', () => {
    const bad = (steps: unknown[], trigger: unknown = { kind: 'manual' }) =>
      flowDraftSchema.safeParse({ name: 'x', trigger, steps }).success;
    expect(bad([{ kind: 'bines', resource: 'item', operation: 'drop_table' }])).toBe(false);
    expect(bad([{ kind: 'http_request', url: 'http://169.254.169.254/' }])).toBe(false);
    expect(bad([{ kind: 'code', js: 'process.exit()' }])).toBe(false);
    expect(bad([])).toBe(false);
    expect(bad([{ kind: 'wait', minutes: 1 }], { kind: 'webhook', path: '../etc' })).toBe(false);
    expect(bad([{ kind: 'wait', minutes: 5 }], { kind: 'schedule', every: 'days', at_hour: 9 })).toBe(true);
  });

  it('describes the draft for people, one line per node', () => {
    const lines = describeFlowDraft(draft);
    expect(lines.map((l) => l.key)).toEqual([
      'flows.draft.trigger.bines_event',
      'flows.draft.step.if',
      'flows.draft.step.http_request',
      'flows.draft.step.bines',
      'flows.draft.step.bines',
    ]);
  });

  it('a schedule trigger uses the interval field of its unit', () => {
    const wf = toN8nWorkflow(
      flowDraftSchema.parse({
        name: 's',
        trigger: { kind: 'schedule', every: 'hours', interval: 2 },
        steps: [{ kind: 'set_fields', fields: { a: '1' } }],
      }),
    );
    expect(wf.nodes[0]!.parameters).toEqual({ rule: { interval: [{ field: 'hours', hoursInterval: 2 }] } });
  });
});

describe('flow connections', () => {
  it('settings default to the plan’s recommendations', () => {
    expect(flowConnectionSettingsSchema.parse({})).toEqual({
      visibility: 'admins',
      ai_create: true,
      ai_operate: true,
      ai_edit: true,
      ai_connection_id: null,
      ai_model: null,
      alert_on_failure: true,
      alert_recipients: [],
      alert_channel: 'bell',
      check_every_minutes: 15,
      max_calls_per_hour: 600,
      max_calls_per_minute: 30,
      background_share_percent: 75,
      cache_list_seconds: 120,
      cache_stats_seconds: 300,
      cache_runs_seconds: 60,
      refresh_min_seconds: 30,
      stats_concurrency: 1,
      stats_pacing_ms: 400,
      backoff_default_seconds: 60,
    });
  });

  it('each platform takes its own fields', () => {
    const ok = (target: unknown) => createFlowConnectionSchema.safeParse({ name: 'x', target }).success;
    expect(ok({ platform: 'n8n', base_url: 'https://n8n.example.com', api_key: 'k'.repeat(20) })).toBe(true);
    expect(ok({ platform: 'n8n', base_url: 'https://u:p@n8n.example.com', api_key: 'k'.repeat(20) })).toBe(false);
    expect(ok({ platform: 'make', zone: 'eu1', team_id: 7, api_token: 't'.repeat(20) })).toBe(true);
    expect(ok({ platform: 'make', zone: 'evil.com/x', team_id: 7, api_token: 't'.repeat(20) })).toBe(false);
    expect(ok({ platform: 'zapier', access_token: 'z'.repeat(20) })).toBe(true);
  });

  it('Zapier is monitoring only; n8n can do everything', () => {
    expect(FLOW_PLATFORM_CAPS.zapier).toEqual({ toggle: false, retry: false, create: false, edit: false });
    expect(FLOW_PLATFORM_CAPS.n8n).toEqual({ toggle: true, retry: true, create: true, edit: true });
  });

  it('the owner allows every platform by default', () => {
    expect(platformSettingsSchema.parse({}).flows.platforms).toEqual(['n8n', 'make', 'zapier']);
  });
});

describe('flow AI tools', () => {
  it('creating is sensitive (always approval), reading is not', () => {
    const create = aiTool('flows_draft_create')!;
    expect(EXTERNAL_PLATFORM_TOOLS).toContain('flows_draft_create');
    expect(create.risk).toBe('sensitive');
    expect(isSensitiveTool(create)).toBe(true);
    expect(needsApproval(create, { approval_mode: 'autonomous', approval_tools: [] })).toBe(true);
    expect(needsApproval(aiTool('flows_list')!, { approval_mode: 'learner', approval_tools: [] })).toBe(false);
    expect(aiTool('flows_runs')!.risk).toBe('read');
  });

  it('the draft input is a plain JSON schema (no $ref) a model can fill', () => {
    const schema = JSON.stringify(z.toJSONSchema(aiTool('flows_draft_create')!.input, { io: 'input' }));
    expect(schema).not.toContain('$ref');
    expect(schema).toContain('bines_event');
  });
});
