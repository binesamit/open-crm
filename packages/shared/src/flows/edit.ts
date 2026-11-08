// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import {
  type FlowStep,
  flowStepSchema,
  flowTriggerSchema,
  N8N_STEP_NAMES,
  type N8nNode,
  n8nNodeId,
  n8nStepNode,
  n8nTriggerNode,
} from './draft';

/**
 * Editing an existing flow with the AI ("I see no way to edit or operate the flow with the AI").
 * The model never writes a workflow: it proposes **edits** in the same small, safe vocabulary as a draft (flows/draft.ts)
 * — a step is one of the draft's steps, a trigger one of its triggers — and the server applies them to the workflow it
 * read from the platform. Whatever the workflow already has (code nodes, credentials, other node types) stays exactly
 * as it was; a new or replaced step never carries credentials, headers or code. Pure: the server reads and saves, the
 * approval card shows `diffN8nWorkflows` of before / after.
 */

const nodeName = z.string().trim().min(1).max(128).describe('The node name exactly as in the workflow (flows_get)');

export const flowEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename_flow'), name: z.string().trim().min(1).max(120) }),
  z.object({
    op: z.literal('add_step'),
    after: nodeName.describe('The new step runs right after this node'),
    step: flowStepSchema,
  }),
  z.object({ op: z.literal('replace_step'), node: nodeName, step: flowStepSchema }),
  z.object({ op: z.literal('remove_step'), node: nodeName }),
  z.object({ op: z.literal('rename_step'), node: nodeName, name: z.string().trim().min(1).max(128) }),
  z.object({ op: z.literal('set_trigger'), trigger: flowTriggerSchema }),
]);
export type FlowEdit = z.infer<typeof flowEditSchema>;
export const flowEditsSchema = z.array(flowEditSchema).min(1).max(20);

type Link = { node: string; type: string; index: number };
/** A workflow as n8n's API returns it (only what an edit reads; the rest is carried as is). */
export type N8nWorkflowFull = {
  id?: string;
  name: string;
  active?: boolean;
  nodes: (N8nNode & { credentials?: Record<string, unknown>; disabled?: boolean })[];
  connections: Record<string, Record<string, Link[][]>>;
  settings?: Record<string, unknown>;
  [k: string]: unknown;
};

export class FlowEditError extends Error {
  constructor(
    public code: string,
    public detail: string,
  ) {
    super(code);
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Nodes that start a flow: nothing leads into them. */
const incoming = (wf: N8nWorkflowFull) => {
  const into = new Set<string>();
  for (const outs of Object.values(wf.connections ?? {}))
    for (const lists of Object.values(outs ?? {}))
      for (const list of lists ?? []) for (const l of list ?? []) into.add(l.node);
  return into;
};

const find = (wf: N8nWorkflowFull, name: string) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new FlowEditError('flow_edit_node_not_found', name);
  return n;
};

const uniqueName = (wf: N8nWorkflowFull, base: string) => {
  const used = new Set(wf.nodes.map((n) => n.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
};

const stepLabel = (s: FlowStep) =>
  s.kind === 'bines' ? `${N8N_STEP_NAMES.bines}: ${s.resource} ${s.operation}` : N8N_STEP_NAMES[s.kind];

const renameIn = (wf: N8nWorkflowFull, from: string, to: string) => {
  const next: N8nWorkflowFull['connections'] = {};
  for (const [src, outs] of Object.entries(wf.connections ?? {})) {
    const fixed: Record<string, Link[][]> = {};
    for (const [type, lists] of Object.entries(outs ?? {}))
      fixed[type] = (lists ?? []).map((list) => (list ?? []).map((l) => (l.node === from ? { ...l, node: to } : l)));
    next[src === from ? to : src] = fixed;
  }
  wf.connections = next;
};

/**
 * The workflow with the edits applied, in order (each sees the previous). Throws `FlowEditError` when an edit does not
 * fit (an unknown node, removing the trigger). `seed` keeps generated ids stable for one call.
 */
export const applyFlowEdits = (before: N8nWorkflowFull, edits: FlowEdit[], seed = before.name): N8nWorkflowFull => {
  const wf = clone(before);
  wf.connections ??= {};
  edits.forEach((e, i) => {
    const s = `${seed}:edit:${i}`;
    switch (e.op) {
      case 'rename_flow':
        wf.name = e.name;
        return;
      case 'rename_step': {
        const n = find(wf, e.node);
        const to = e.name === n.name ? n.name : uniqueName(wf, e.name);
        renameIn(wf, n.name, to);
        n.name = to;
        return;
      }
      case 'add_step': {
        const after = find(wf, e.after);
        const name = uniqueName(wf, stepLabel(e.step));
        const node = {
          id: n8nNodeId(s, 1),
          name,
          position: [after.position?.[0] ?? 0, (after.position?.[1] ?? 0) + 200] as [number, number],
          ...n8nStepNode(e.step, s, 1),
        };
        wf.nodes.push(node);
        const outs = (wf.connections[after.name] ??= {});
        const main = (outs.main ??= [[]]);
        const next = main[0] ?? [];
        main[0] = [{ node: name, type: 'main', index: 0 }];
        if (next.length) wf.connections[name] = { main: [next] };
        return;
      }
      case 'replace_step': {
        const n = find(wf, e.node);
        if (!incoming(wf).has(n.name)) throw new FlowEditError('flow_edit_is_trigger', n.name);
        const compiled = n8nStepNode(e.step, s, 1);
        // The person's credentials stay only on a node of the same type (a new type gets its own in the platform).
        if (compiled.type !== n.type) delete n.credentials;
        n.type = compiled.type;
        n.typeVersion = compiled.typeVersion;
        n.parameters = compiled.parameters;
        if (compiled.webhookId) n.webhookId = compiled.webhookId;
        else delete n.webhookId;
        return;
      }
      case 'remove_step': {
        const n = find(wf, e.node);
        if (!incoming(wf).has(n.name)) throw new FlowEditError('flow_edit_is_trigger', n.name);
        const after = wf.connections[n.name]?.main?.[0] ?? [];
        delete wf.connections[n.name];
        for (const outs of Object.values(wf.connections))
          for (const [type, lists] of Object.entries(outs ?? {}))
            outs[type] = (lists ?? []).map((list) => {
              const pointed = (list ?? []).some((l) => l.node === n.name);
              const kept = (list ?? []).filter((l) => l.node !== n.name);
              // Whoever led into the removed step now leads to what came after it (main lines only).
              return pointed && type === 'main'
                ? [...kept, ...after.filter((a) => !kept.some((k) => k.node === a.node))]
                : kept;
            });
        wf.nodes = wf.nodes.filter((x) => x !== n);
        return;
      }
      case 'set_trigger': {
        const into = incoming(wf);
        const starts = wf.nodes.filter((x) => !into.has(x.name) && wf.connections[x.name]?.main?.[0]?.length);
        const current = starts[0] ?? wf.nodes.find((x) => !into.has(x.name));
        if (!current) throw new FlowEditError('flow_edit_no_trigger', wf.name);
        const compiled = n8nTriggerNode(e.trigger, s);
        if (compiled.type !== current.type) delete current.credentials;
        current.type = compiled.type;
        current.typeVersion = compiled.typeVersion;
        current.parameters = compiled.parameters;
        if (compiled.webhookId) current.webhookId = compiled.webhookId;
        else delete current.webhookId;
        return;
      }
    }
  });
  return wf;
};

// ---- the diff a person approves ----

export type FlowDiffLine = {
  kind: 'flow_renamed' | 'added' | 'removed' | 'changed' | 'renamed' | 'relinked';
  node: string;
  /** changed: the parameter; renamed / flow_renamed: unused. */
  field?: string;
  before?: string;
  after?: string;
};

const MAX_VALUE = 120;
const show = (v: unknown) => {
  if (v === undefined) return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
};

/** Leaf parameters as `a.b.c` → value (arrays as a whole value: a list of conditions / assignments reads as one). */
const flat = (v: unknown, prefix = '', out: Record<string, unknown> = {}) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flat(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = v;
  return out;
};

const linksOf = (wf: N8nWorkflowFull, name: string, rename: (n: string) => string = (n) => n) =>
  ((wf.connections?.[name]?.main ?? []) as Link[][])
    .map((list) => (list ?? []).map((l) => rename(l.node)).join(', '))
    .join(' | ');

/** What changed, node by node (matched by id, else by name), for the approval card and the audit. */
export const diffN8nWorkflows = (before: N8nWorkflowFull, after: N8nWorkflowFull): FlowDiffLine[] => {
  const out: FlowDiffLine[] = [];
  if (before.name !== after.name) out.push({ kind: 'flow_renamed', node: '', before: before.name, after: after.name });
  const key = (n: { id?: string; name: string }) => n.id || `name:${n.name}`;
  const was = new Map(before.nodes.map((n) => [key(n), n]));
  const now = new Map(after.nodes.map((n) => [key(n), n]));
  for (const [k, n] of was) if (!now.has(k)) out.push({ kind: 'removed', node: n.name, before: n.type });
  for (const [k, n] of now) {
    const old = was.get(k);
    if (!old) {
      out.push({ kind: 'added', node: n.name, after: n.type });
      continue;
    }
    if (old.name !== n.name) out.push({ kind: 'renamed', node: n.name, before: old.name, after: n.name });
    if (old.type !== n.type)
      out.push({ kind: 'changed', node: n.name, field: 'type', before: old.type, after: n.type });
    const a = flat(old.parameters ?? {});
    const b = flat(n.parameters ?? {});
    for (const p of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (JSON.stringify(a[p]) !== JSON.stringify(b[p]))
        out.push({ kind: 'changed', node: n.name, field: p, before: show(a[p]), after: show(b[p]) });
  }
  // What each node leads to (a step added / removed in the middle moves the lines); renamed nodes read by new names.
  const renamed = new Map<string, string>();
  for (const [k, n] of now) {
    const old = was.get(k);
    if (old) renamed.set(old.name, n.name);
  }
  for (const [k, n] of now) {
    const old = was.get(k);
    if (!old) continue;
    const l1 = linksOf(before, old.name, (x) => renamed.get(x) ?? x);
    const l2 = linksOf(after, n.name);
    if (l1 !== l2) out.push({ kind: 'relinked', node: n.name, before: l1 || '—', after: l2 || '—' });
  }
  return out;
};

/** One line per change, English — what the model and the audit log read back. */
export const flowDiffText = (lines: FlowDiffLine[]) =>
  lines
    .map((l) =>
      l.kind === 'flow_renamed'
        ? `~ flow name: "${l.before}" → "${l.after}"`
        : l.kind === 'added'
          ? `+ "${l.node}" (${l.after})`
          : l.kind === 'removed'
            ? `- "${l.node}" (${l.before})`
            : l.kind === 'renamed'
              ? `~ "${l.before}" renamed to "${l.after}"`
              : l.kind === 'relinked'
                ? `~ "${l.node}" leads to: ${l.before} → ${l.after}`
                : `~ "${l.node}" ${l.field}: ${l.before} → ${l.after}`,
    )
    .join('\n');

/** A line of the approval card: `field` = an i18n key part (`ai.field.<field>`), `text` = what it says. */
export type FlowDetail = { field: string; text: string };

const stepText = (s: FlowStep) =>
  s.kind === 'bines'
    ? `${s.resource} ${s.operation}${s.name ? ` "${s.name}"` : ''}${s.text ? ` "${show(s.text)}"` : ''}`
    : s.kind === 'http_request'
      ? `${s.method} ${s.url}`
      : s.kind === 'set_fields'
        ? Object.keys(s.fields).join(', ')
        : s.kind === 'if'
          ? `${s.left} ${s.operator} ${s.right ?? ''}`.trim()
          : `${s.minutes} min`;

/** The proposed edits as lines (no platform call): an agent's approval screen and anywhere the diff is not at hand. */
export const flowEditDetails = (edits: FlowEdit[]): FlowDetail[] =>
  edits.map((e) => {
    switch (e.op) {
      case 'rename_flow':
        return { field: 'flow_edit_rename_flow', text: e.name };
      case 'rename_step':
        return { field: 'flow_edit_rename_step', text: `"${e.node}" → "${e.name}"` };
      case 'add_step':
        return { field: 'flow_edit_add_step', text: `"${e.after}" → ${stepLabel(e.step)}: ${stepText(e.step)}` };
      case 'replace_step':
        return { field: 'flow_edit_replace_step', text: `"${e.node}" → ${stepLabel(e.step)}: ${stepText(e.step)}` };
      case 'remove_step':
        return { field: 'flow_edit_remove_step', text: `"${e.node}"` };
      case 'set_trigger':
        return { field: 'flow_edit_set_trigger', text: e.trigger.kind };
    }
  });

/** The real diff (before / after the platform's definition) as lines. */
export const flowDiffDetails = (lines: FlowDiffLine[]): FlowDetail[] =>
  lines.map((l) => ({
    field: `flow_diff_${l.kind}`,
    text:
      l.kind === 'flow_renamed' || l.kind === 'renamed'
        ? `"${l.before}" → "${l.after}"`
        : l.kind === 'added'
          ? `"${l.node}" (${l.after})`
          : l.kind === 'removed'
            ? `"${l.node}" (${l.before})`
            : l.kind === 'relinked'
              ? `"${l.node}": ${l.before} → ${l.after}`
              : `"${l.node}" · ${l.field}: ${l.before} → ${l.after}`,
  }));
