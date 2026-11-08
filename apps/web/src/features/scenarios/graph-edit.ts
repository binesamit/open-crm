// SPDX-License-Identifier: AGPL-3.0-only
import { ELSE_BRANCH, type ScenarioGraph, type ScenarioNode } from '@bines/shared';

/**
 * (back from review) — the canvas's graph edits: a block into a connection, after a free output
 * and removing blocks so a chain stays joined.
 */

/** Where a new block joins: after `from` (by `branch` of a router), or into the connection `edge` (the "+" on a line). */
export type Link = { from: string; branch?: string; edge?: string };

/** How far apart blocks stand along the flow. */
export const STEP = 280;

export const newNodeId = (g: ScenarioGraph, kind: ScenarioNode['kind']) => {
  for (let i = 1; ; i++) {
    const id = `${kind}${i}`;
    if (!g.nodes.some((n) => n.id === id)) return id;
  }
};
export const newEdgeId = (g: ScenarioGraph) => {
  for (let i = 1; ; i++) {
    const id = `e${i}`;
    if (!g.edges.some((e) => e.id === id)) return id;
  }
};

/** Every node the flow reaches from `start` (itself included). */
const downstream = (g: ScenarioGraph, start: string) => {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.from === id) queue.push(e.to);
  }
  return seen;
};

/**
 * Removes blocks and connections. A removed block with one way in and one way out leaves its neighbours joined
 * (deleting the middle of a chain keeps the chain).
 */
export const removeFromGraph = (g: ScenarioGraph, nodeIds: string[], edgeIds: string[] = []): ScenarioGraph => {
  const gone = new Set(nodeIds);
  const bridges: ScenarioGraph['edges'] = [];
  // React Flow hands over a deleted block's connections along with it, so `edgeIds` may hold its ways in and out.
  for (const id of nodeIds) {
    const ins = g.edges.filter((e) => e.to === id);
    const outs = g.edges.filter((e) => e.from === id);
    if (ins.length !== 1 || outs.length !== 1) continue;
    const [a, b] = [ins[0]!, outs[0]!];
    if (gone.has(a.from) || gone.has(b.to) || a.from === b.to) continue;
    bridges.push({ ...a, to: b.to });
  }
  const edges = g.edges.filter((e) => !edgeIds.includes(e.id) && !gone.has(e.from) && !gone.has(e.to));
  for (const b of bridges)
    if (!edges.some((e) => e.from === b.from && e.to === b.to && e.branch === b.branch)) edges.push(b);
  return { ...g, nodes: g.nodes.filter((n) => !gone.has(n.id)), edges };
};

/**
 * Adds the new block `n` and joins it by `link`. Into a connection: the block takes the middle, and when the two ends
 * stand too close, the far end and everything after it move along by the missing room (dir = 1 left to right, -1 RTL).
 * After a router with no branch named: its first free branch.
 */
export const placeInGraph = (g: ScenarioGraph, n: ScenarioNode, link: Link | null, dir: 1 | -1): ScenarioGraph => {
  g.nodes.push(n);
  if (!link) return g;
  const split = link.edge ? g.edges.find((e) => e.id === link.edge) : undefined;
  if (split) {
    const from = g.nodes.find((x) => x.id === split.from);
    const to = g.nodes.find((x) => x.id === split.to);
    if (from && to) {
      const gap = (to.x - from.x) * dir;
      if (gap < 2 * STEP) {
        const move = downstream(g, to.id);
        move.delete(from.id);
        for (const x of g.nodes) if (move.has(x.id)) x.x += (2 * STEP - gap) * dir;
      }
      n.x = from.x + STEP * dir;
      n.y = to.y;
    }
    g.edges = g.edges.filter((e) => e.id !== split.id);
    g.edges.push({ id: newEdgeId(g), from: split.from, to: n.id, ...(split.branch ? { branch: split.branch } : {}) });
    g.edges.push({
      id: newEdgeId(g),
      from: n.id,
      to: split.to,
      ...(n.kind === 'router' ? { branch: n.branches[0]?.id ?? ELSE_BRANCH } : {}),
    });
    return g;
  }
  const src = g.nodes.find((x) => x.id === link.from);
  if (!src) return g;
  let branch = link.branch;
  if (src.kind === 'router' && !branch) {
    const used = new Set(g.edges.filter((e) => e.from === src.id).map((e) => e.branch));
    branch = [...src.branches.map((b) => b.id), ELSE_BRANCH].find((b) => !used.has(b)) ?? ELSE_BRANCH;
  }
  g.edges.push({ id: newEdgeId(g), from: src.id, to: n.id, ...(branch ? { branch } : {}) });
  return g;
};

/** The outputs of `n` with nothing connected: '' for a plain block's one output, else the router's branch ids. */
export const freeOutputs = (g: ScenarioGraph, n: ScenarioNode): string[] => {
  const out = g.edges.filter((e) => e.from === n.id);
  if (n.kind !== 'router') return out.length ? [] : [''];
  return [...n.branches.map((b) => b.id), ELSE_BRANCH].filter((b) => !out.some((e) => (e.branch ?? '') === b));
};
