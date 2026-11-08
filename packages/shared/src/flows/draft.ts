// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { WEBHOOK_EVENTS } from '../api/webhooks';

/**
 * A flow draft ("זרימות", stage 4): what the AI builder — or a person — describes, in a small, safe
 * vocabulary, before anything exists on the external platform. The server compiles it to the platform's own format
 * (n8n workflow JSON today) and creates it **switched off**; a person reviews it in the platform and switches it on.
 *
 * Deliberately narrow: our n8n nodes (the `n8n-nodes-bines-os` community package — `binesOs` / `binesOsTrigger`)
 * plus a handful of core n8n nodes. No credentials, no headers and no code nodes are ever written by a draft: the
 * person connects credentials in n8n, so a model can never smuggle a secret or arbitrary code into a flow.
 */

/** n8n node type names of our community package (`package.json` name + the node's `name`). */
export const N8N_BINES_PACKAGE = 'n8n-nodes-bines-os';
export const N8N_BINES_NODE = `${N8N_BINES_PACKAGE}.binesOs`;
export const N8N_BINES_TRIGGER = `${N8N_BINES_PACKAGE}.binesOsTrigger`;

/** The `binesOs` node's resources → operations (integrations/n8n-nodes-bines-os/nodes/BinesOs/descriptions.ts). */
export const FLOW_BINES_OPERATIONS = {
  item: ['create', 'update', 'get', 'getAll', 'find', 'archive', 'delete', 'duplicate', 'moveToGroup', 'moveToBoard'],
  subitem: ['create', 'update'],
  update: ['create', 'reply'],
  board: ['getAll', 'getSchema'],
  group: ['create'],
  user: ['getAll'],
  agent: ['run'],
} as const;
export type FlowBinesResource = keyof typeof FLOW_BINES_OPERATIONS;
export const FLOW_BINES_RESOURCES = Object.keys(FLOW_BINES_OPERATIONS) as FlowBinesResource[];

/** A text a node receives: plain text or an n8n expression (`={{ $json.item.name }}`). */
const text = (max = 2000) => z.string().max(max);
const nodeRef = z.string().trim().min(1).max(64);

export const FLOW_SCHEDULE_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;
export const FLOW_IF_OPERATORS = ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'] as const;
export const FLOW_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const flowTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bines_event'),
    event: z.enum(WEBHOOK_EVENTS).describe('The board event that starts the flow'),
    board_id: nodeRef.optional().describe('Board id (the person can pick it in n8n when unknown)'),
    column_id: nodeRef.optional().describe('Column id, for column / status events'),
    label: text(120).optional().describe('Status label, for status_changed'),
    group_id: nodeRef.optional().describe('Group id, for item_moved_to_specific_group'),
  }),
  z.object({
    kind: z.literal('webhook'),
    method: z.enum(['GET', 'POST']).default('POST'),
    path: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'flow_webhook_path_invalid')
      .optional()
      .describe('URL path segment (lowercase, digits, dashes)'),
  }),
  z.object({
    kind: z.literal('schedule'),
    every: z.enum(FLOW_SCHEDULE_UNITS),
    interval: z.number().int().min(1).max(1000).default(1),
    at_hour: z.number().int().min(0).max(23).optional().describe('Hour of day (days / weeks)'),
  }),
  z.object({ kind: z.literal('manual') }),
]);
export type FlowTrigger = z.infer<typeof flowTriggerSchema>;

export const flowStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bines'),
      resource: z.enum(FLOW_BINES_RESOURCES as [FlowBinesResource, ...FlowBinesResource[]]),
      operation: z.string().min(1).max(40),
      board_id: nodeRef.optional(),
      item_id: text(200).optional().describe('Item id or an expression such as ={{ $json.item.id }}'),
      name: text(255).optional().describe('Item / group name (create)'),
      text: text(5000).optional().describe('Update text (update.create / update.reply)'),
      columns: z
        .record(z.string().max(64), text(1000))
        .optional()
        .describe('Column values by column id: plain text or expressions'),
    })
    .refine((s) => (FLOW_BINES_OPERATIONS[s.resource] as readonly string[]).includes(s.operation), {
      message: 'flow_bines_operation_invalid',
      path: ['operation'],
    }),
  z.object({
    kind: z.literal('http_request'),
    method: z.enum(FLOW_HTTP_METHODS).default('POST'),
    url: z
      .string()
      .max(2000)
      .regex(/^(https:\/\/|=)/, 'flow_http_url_invalid')
      .describe('An https URL (or an n8n expression)'),
    body: z.record(z.string().max(64), z.unknown()).optional().describe('JSON body (no secrets)'),
  }),
  z.object({
    kind: z.literal('set_fields'),
    fields: z
      .record(z.string().min(1).max(64), text(1000))
      .refine((f) => Object.keys(f).length >= 1 && Object.keys(f).length <= 30, 'flow_fields_count'),
  }),
  z.object({
    kind: z.literal('if'),
    left: text(500).describe('Value to test, usually an expression'),
    operator: z.enum(FLOW_IF_OPERATORS),
    right: text(500).optional(),
  }),
  z.object({ kind: z.literal('wait'), minutes: z.number().int().min(1).max(10_080) }),
]);
export type FlowStep = z.infer<typeof flowStepSchema>;

/** The draft without an OpenAPI id (AI tool inputs must not use `$ref`). */
export const flowDraftInputSchema = z.object({
  name: z.string().trim().min(1).max(120).describe('Flow name, in the language of the request'),
  description: z.string().max(2000).optional(),
  trigger: flowTriggerSchema,
  steps: z.array(flowStepSchema).min(1).max(20),
});
export const flowDraftSchema = flowDraftInputSchema.meta({ id: 'FlowDraft' });
export type FlowDraft = z.infer<typeof flowDraftSchema>;

// ---- n8n ----

export type N8nNode = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  webhookId?: string;
};
export type N8nWorkflowDraft = {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: { node: string; type: 'main'; index: number }[][] }>;
  settings: Record<string, unknown>;
};

/** A stable, unique-enough id for a node of this draft (n8n accepts any string; it re-keys on save). */
export const n8nNodeId = (seed: string, i: number) => {
  let h = 0;
  for (const ch of `${seed}:${i}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  const hex = (h.toString(16) + '00000000').slice(0, 8);
  return `${hex}-0000-4000-8000-${String(i).padStart(12, '0')}`;
};

const IF_OPERATION: Record<(typeof FLOW_IF_OPERATORS)[number], { operation: string; single?: boolean }> = {
  equals: { operation: 'equals' },
  not_equals: { operation: 'notEquals' },
  contains: { operation: 'contains' },
  is_empty: { operation: 'empty', single: true },
  is_not_empty: { operation: 'notEmpty', single: true },
};

/** One trigger in n8n's terms (no id / position): what a draft or an edit (flows/edit.ts) writes. */
export const n8nTriggerNode = (t: FlowTrigger, seed: string): Omit<N8nNode, 'id' | 'position'> => {
  switch (t.kind) {
    case 'bines_event':
      return {
        name: 'Bines OS Trigger',
        type: N8N_BINES_TRIGGER,
        typeVersion: 1,
        webhookId: n8nNodeId(`${seed}:hook`, 0),
        parameters: {
          boardId: t.board_id ?? '',
          event: t.event,
          ...(t.column_id ? { columnId: t.column_id, statusColumnId: t.column_id } : {}),
          ...(t.label ? { label: t.label } : {}),
          ...(t.group_id ? { groupId: t.group_id } : {}),
        },
      };
    case 'webhook':
      return {
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        webhookId: n8nNodeId(`${seed}:hook`, 0),
        parameters: {
          httpMethod: t.method,
          path: t.path ?? n8nNodeId(`${seed}:path`, 0),
          responseMode: 'onReceived',
          options: {},
        },
      };
    case 'schedule': {
      const field = t.every;
      const rule: Record<string, unknown> = { field, [`${field}Interval`]: t.interval };
      if (t.at_hour !== undefined && (field === 'days' || field === 'weeks')) rule.triggerAtHour = t.at_hour;
      return {
        name: 'Schedule Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        parameters: { rule: { interval: [rule] } },
      };
    }
    case 'manual':
      return { name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };
  }
};

/** One step in n8n's terms (no id / position / name): what a draft or an edit (flows/edit.ts) writes. */
export const n8nStepNode = (s: FlowStep, seed: string, i: number): Omit<N8nNode, 'id' | 'position' | 'name'> => {
  switch (s.kind) {
    case 'bines': {
      const p: Record<string, unknown> = { resource: s.resource, operation: s.operation };
      if (s.board_id) p.boardId = s.board_id;
      if (s.item_id) p.itemId = s.item_id;
      if (s.name) p.name = s.name;
      if (s.text) p.body = s.text;
      if (s.columns && Object.keys(s.columns).length)
        p.columns = {
          mappingMode: 'defineBelow',
          value: s.columns,
          matchingColumns: [],
          schema: Object.keys(s.columns).map((id) => ({
            id,
            displayName: id,
            required: false,
            defaultMatch: false,
            display: true,
            type: 'string',
            canBeUsedToMatch: false,
          })),
        };
      return { type: N8N_BINES_NODE, typeVersion: 1, parameters: p };
    }
    case 'http_request':
      return {
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: s.method,
          url: s.url,
          ...(s.body && s.method !== 'GET'
            ? { sendBody: true, specifyBody: 'json', jsonBody: JSON.stringify(s.body, null, 2) }
            : {}),
          options: {},
        },
      };
    case 'set_fields':
      return {
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        parameters: {
          assignments: {
            assignments: Object.entries(s.fields).map(([name, value], j) => ({
              id: n8nNodeId(`${seed}:set:${i}`, j),
              name,
              value,
              type: 'string',
            })),
          },
          options: {},
        },
      };
    case 'if': {
      const op = IF_OPERATION[s.operator];
      return {
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
            conditions: [
              {
                id: n8nNodeId(`${seed}:if:${i}`, 0),
                leftValue: s.left,
                rightValue: op.single ? '' : (s.right ?? ''),
                operator: { type: 'string', operation: op.operation, ...(op.single ? { singleValue: true } : {}) },
              },
            ],
            combinator: 'and',
          },
          options: {},
        },
      };
    }
    case 'wait':
      return {
        type: 'n8n-nodes-base.wait',
        typeVersion: 1.1,
        webhookId: n8nNodeId(`${seed}:wait`, i),
        parameters: { amount: s.minutes, unit: 'minutes' },
      };
  }
};

/** The English node name of a step (n8n names must be unique within a workflow). */
export const N8N_STEP_NAMES: Record<FlowStep['kind'], string> = {
  bines: 'Bines OS',
  http_request: 'HTTP Request',
  set_fields: 'Set Fields',
  if: 'If',
  wait: 'Wait',
};

/**
 * The draft as an n8n workflow (POST /api/v1/workflows body): the trigger, then each step in a line; an `if` step's
 * "true" output continues the line (its "false" output ends there). Nodes are laid out left to right.
 */
export const toN8nWorkflow = (draft: FlowDraft): N8nWorkflowDraft => {
  const seed = draft.name;
  const used = new Map<string, number>();
  const unique = (base: string) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  };
  const trigger = n8nTriggerNode(draft.trigger, seed);
  const nodes: N8nNode[] = [
    { id: n8nNodeId(seed, 0), position: [0, 0], ...trigger, name: unique(trigger.name) },
    ...draft.steps.map((s, i) => {
      const label =
        s.kind === 'bines' ? `${N8N_STEP_NAMES.bines}: ${s.resource} ${s.operation}` : N8N_STEP_NAMES[s.kind];
      return {
        id: n8nNodeId(seed, i + 1),
        position: [(i + 1) * 260, 0] as [number, number],
        name: unique(label),
        ...n8nStepNode(s, seed, i + 1),
      };
    }),
  ];
  const connections: N8nWorkflowDraft['connections'] = {};
  for (let i = 0; i < nodes.length - 1; i++)
    connections[nodes[i]!.name] = { main: [[{ node: nodes[i + 1]!.name, type: 'main', index: 0 }]] };
  return { name: draft.name, nodes, connections, settings: { executionOrder: 'v1' } };
};

/** One line per node, for people (the approval card, the "draft" dialog): i18n key + values. */
export type FlowDraftLine = { key: string; vars: Record<string, string | number> };

export const describeFlowDraft = (draft: FlowDraft): FlowDraftLine[] => {
  const t = draft.trigger;
  const first: FlowDraftLine =
    t.kind === 'bines_event'
      ? { key: 'flows.draft.trigger.bines_event', vars: { event: t.event, board: t.board_id ?? '—' } }
      : t.kind === 'webhook'
        ? { key: 'flows.draft.trigger.webhook', vars: { method: t.method } }
        : t.kind === 'schedule'
          ? { key: 'flows.draft.trigger.schedule', vars: { every: t.every, interval: t.interval } }
          : { key: 'flows.draft.trigger.manual', vars: {} };
  return [
    first,
    ...draft.steps.map((s): FlowDraftLine => {
      switch (s.kind) {
        case 'bines':
          return { key: 'flows.draft.step.bines', vars: { resource: s.resource, operation: s.operation } };
        case 'http_request':
          return { key: 'flows.draft.step.http_request', vars: { method: s.method, url: s.url } };
        case 'set_fields':
          return { key: 'flows.draft.step.set_fields', vars: { fields: Object.keys(s.fields).join(', ') } };
        case 'if':
          return { key: 'flows.draft.step.if', vars: { left: s.left, operator: s.operator, right: s.right ?? '' } };
        case 'wait':
          return { key: 'flows.draft.step.wait', vars: { minutes: s.minutes } };
      }
    }),
  ];
};

/** English, one line per node — what a model (and the audit log) reads back. */
export const flowDraftOutline = (draft: FlowDraft) =>
  toN8nWorkflow(draft)
    .nodes.map((n, i) => `${i + 1}. ${n.name} (${n.type})`)
    .join('\n');
