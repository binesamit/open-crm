// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { actionSchema, triggerSchema } from '../automations/schema';
import { filterGroupSchema, flattenRules } from '../query/filter';

/**
 * phase 3 — a scenario: the automations' triggers and actions laid out as a graph on a canvas.
 * One trigger; then filters (go on only if), routers (branches, each with its own "only if", and "otherwise"),
 * actions and waits, joined by edges. It lives beside the automations and does not depend on them.
 */
export const SCENARIO_MAX_NODES = 60;
export const SCENARIO_MAX_EDGES = 120;
export const SCENARIO_MAX_BRANCHES = 10;
export const SCENARIO_MAX_WAIT_MINUTES = 30 * 24 * 60;
/**
 * The triggers a scenario listens to: the events of a board (date, period, inbound-webhook, extension and flow
 * triggers stay with the automations in this first version).
 */
export const SCENARIO_TRIGGERS = new Set<string>([
  'item_created',
  'item_created_in_group',
  'status_changed',
  'column_changed',
  'item_moved_to_group',
  'checkbox_checked',
  'update_posted',
  'subitem_created',
  'subitem_status_changed',
  'subitem_column_changed',
  'person_assigned',
  'number_threshold',
  'file_added',
  'button_clicked',
  'item_archived',
  'item_deleted',
  'item_restored',
]);

/** Actions that report to an automation by id (SMS log, integrations, extensions): not in scenarios yet. */
export const SCENARIO_EXCLUDED_ACTIONS = new Set<string>(['send_sms', 'send_to_integrations', 'run_extension']);

/** A router's fallback branch (runs when no other branch matches). */
export const ELSE_BRANCH = 'else';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const at = { id, x: z.number().finite(), y: z.number().finite(), label: z.string().trim().max(80).optional() };

export const scenarioNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...at, kind: z.literal('trigger'), trigger: triggerSchema }),
  z.object({ ...at, kind: z.literal('filter'), conditions: filterGroupSchema }),
  z.object({
    ...at,
    kind: z.literal('router'),
    branches: z
      .array(z.object({ id, label: z.string().trim().max(60), conditions: filterGroupSchema.optional() }))
      .min(1)
      .max(SCENARIO_MAX_BRANCHES),
    /** Every branch whose conditions match runs ('all'), or only the first one ('first'). */
    mode: z.enum(['all', 'first']).default('first'),
  }),
  z.object({ ...at, kind: z.literal('action'), action: actionSchema }),
  z.object({ ...at, kind: z.literal('wait'), minutes: z.number().int().min(1).max(SCENARIO_MAX_WAIT_MINUTES) }),
]);
export type ScenarioNode = z.infer<typeof scenarioNodeSchema>;
export type ScenarioNodeKind = ScenarioNode['kind'];

export const scenarioEdgeSchema = z.object({
  id,
  from: id,
  to: id,
  /** From a router: the branch id it leaves by (or `else`). */
  branch: z.string().max(40).optional(),
});
export type ScenarioEdge = z.infer<typeof scenarioEdgeSchema>;

export const scenarioGraphSchema = z.object({
  nodes: z.array(scenarioNodeSchema).max(SCENARIO_MAX_NODES),
  edges: z.array(scenarioEdgeSchema).max(SCENARIO_MAX_EDGES),
});
export type ScenarioGraph = z.infer<typeof scenarioGraphSchema>;

export type GraphIssue = { node_id?: string; edge_id?: string; code: string };

/**
 * The checks a graph must pass to be switched on: one trigger, no edge into it, edges between known nodes, a router's
 * edges name its branches, no cycles, no unreachable node. A draft may be saved with issues; it cannot be active.
 */
export const graphIssues = (g: ScenarioGraph): GraphIssue[] => {
  const out: GraphIssue[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  if (byId.size !== g.nodes.length) out.push({ code: 'duplicate_node' });
  const triggers = g.nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length !== 1) out.push({ code: triggers.length ? 'many_triggers' : 'no_trigger' });
  for (const t of triggers)
    if (t.kind === 'trigger' && !SCENARIO_TRIGGERS.has(t.trigger.type))
      out.push({ node_id: t.id, code: 'trigger_unsupported' });
  for (const e of g.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || e.from === e.to) {
      out.push({ edge_id: e.id, code: 'edge_unknown_node' });
      continue;
    }
    if (to.kind === 'trigger') out.push({ edge_id: e.id, code: 'edge_into_trigger' });
    if (from.kind === 'router') {
      if (!e.branch || (e.branch !== ELSE_BRANCH && !from.branches.some((b) => b.id === e.branch)))
        out.push({ edge_id: e.id, code: 'edge_no_branch' });
    } else if (e.branch) out.push({ edge_id: e.id, code: 'edge_branch_not_router' });
  }
  for (const n of g.nodes) {
    if (n.kind === 'filter' && !flattenRules(n.conditions).length) out.push({ node_id: n.id, code: 'filter_empty' });
    if (n.kind === 'action' && SCENARIO_EXCLUDED_ACTIONS.has(n.action.type))
      out.push({ node_id: n.id, code: 'action_unsupported' });
  }
  // Cycles (DFS colours) and reachability from the trigger.
  const next = (nid: string) => g.edges.filter((e) => e.from === nid && byId.has(e.to)).map((e) => e.to);
  const state = new Map<string, 1 | 2>();
  let cyclic = false;
  const visit = (nid: string) => {
    if (state.get(nid) === 2) return;
    if (state.get(nid) === 1) {
      cyclic = true;
      return;
    }
    state.set(nid, 1);
    for (const m of next(nid)) visit(m);
    state.set(nid, 2);
  };
  if (triggers[0]) visit(triggers[0].id);
  if (cyclic) out.push({ code: 'cycle' });
  for (const n of g.nodes)
    if (n.kind !== 'trigger' && !state.has(n.id)) out.push({ node_id: n.id, code: 'unreachable' });
  return out;
};

/** The trigger node of a graph (null when it has none or more than one). */
export const graphTrigger = (g: ScenarioGraph) => {
  const t = g.nodes.filter((n) => n.kind === 'trigger');
  return t.length === 1 && t[0]!.kind === 'trigger' ? t[0]! : null;
};

/** The edges leaving a node in a stable order (by branch order for a router, then by the target's position). */
export const outgoing = (g: ScenarioGraph, nid: string) => {
  const node = g.nodes.find((n) => n.id === nid);
  const pos = new Map(g.nodes.map((n) => [n.id, n.y]));
  const rank = (e: ScenarioEdge) =>
    node?.kind === 'router'
      ? e.branch === ELSE_BRANCH
        ? node.branches.length
        : node.branches.findIndex((b) => b.id === e.branch)
      : 0;
  return g.edges
    .filter((e) => e.from === nid)
    .sort((a, b) => rank(a) - rank(b) || (pos.get(a.to) ?? 0) - (pos.get(b.to) ?? 0));
};
