// SPDX-License-Identifier: AGPL-3.0-only
import type { ScenarioGraph, ScenarioNode } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import { freeOutputs, placeInGraph, removeFromGraph, STEP } from './graph-edit';

const wait = (id: string, x: number, y = 0): ScenarioNode => ({ id, kind: 'wait', x, y, minutes: 60 });
const router = (id: string, x: number): ScenarioNode => ({
  id,
  kind: 'router',
  x,
  y: 0,
  mode: 'first',
  branches: [{ id: 'b1', label: 'a' }],
});
// a → b → c, left to right, one step apart.
const chain = (): ScenarioGraph => ({
  nodes: [wait('a', 0), wait('b', STEP), wait('c', 2 * STEP)],
  edges: [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'b', to: 'c' },
  ],
});
const pairs = (g: ScenarioGraph) => g.edges.map((e) => `${e.from}>${e.to}${e.branch ? `:${e.branch}` : ''}`).sort();

describe('placeInGraph: a block into a line', () => {
  it('takes the middle and joins both ends', () => {
    const g = placeInGraph(chain(), wait('n', 0), { from: 'a', edge: 'e1' }, 1);
    expect(pairs(g)).toEqual(['a>n', 'b>c', 'n>b']);
    expect(g.nodes.find((n) => n.id === 'n')).toMatchObject({ x: STEP, y: 0 });
  });

  it('moves the far end and everything after it along when there is no room', () => {
    const g = placeInGraph(chain(), wait('n', 0), { from: 'a', edge: 'e1' }, 1);
    expect(g.nodes.find((n) => n.id === 'b')!.x).toBe(2 * STEP);
    expect(g.nodes.find((n) => n.id === 'c')!.x).toBe(3 * STEP);
    expect(g.nodes.find((n) => n.id === 'a')!.x).toBe(0);
  });

  it('right to left: the flow runs towards smaller x', () => {
    const g: ScenarioGraph = {
      nodes: [wait('a', 0), wait('b', -STEP)],
      edges: [{ id: 'e1', from: 'a', to: 'b' }],
    };
    placeInGraph(g, wait('n', 0), { from: 'a', edge: 'e1' }, -1);
    expect(g.nodes.find((n) => n.id === 'n')!.x).toBe(-STEP);
    expect(g.nodes.find((n) => n.id === 'b')!.x).toBe(-2 * STEP);
  });

  it("keeps the router's branch on the way in; a new router leads on by its first branch", () => {
    const g: ScenarioGraph = {
      nodes: [router('r', 0), wait('b', 3 * STEP)],
      edges: [{ id: 'e1', from: 'r', to: 'b', branch: 'b1' }],
    };
    placeInGraph(g, router('n', 0), { from: 'r', edge: 'e1' }, 1);
    expect(pairs(g)).toEqual(['n>b:b1', 'r>n:b1']);
    // Enough room already: nothing moved.
    expect(g.nodes.find((n) => n.id === 'b')!.x).toBe(3 * STEP);
  });
});

describe('placeInGraph: after a block', () => {
  it("a router's named branch, else its first free one", () => {
    const g: ScenarioGraph = { nodes: [router('r', 0)], edges: [] };
    placeInGraph(g, wait('x', STEP), { from: 'r', branch: 'else' }, 1);
    placeInGraph(g, wait('y', STEP), { from: 'r' }, 1);
    expect(pairs(g)).toEqual(['r>x:else', 'r>y:b1']);
  });
});

describe('removeFromGraph', () => {
  it('deleting the middle of a chain keeps the chain', () => {
    const g = removeFromGraph(chain(), ['b'], ['e1', 'e2']);
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(pairs(g)).toEqual(['a>c']);
  });

  it('a block with two ways out leaves no bridge', () => {
    const g = chain();
    g.nodes.push(wait('d', 2 * STEP, 100));
    g.edges.push({ id: 'e3', from: 'b', to: 'd' });
    expect(pairs(removeFromGraph(g, ['b']))).toEqual([]);
  });

  it('removing a line alone', () => {
    expect(pairs(removeFromGraph(chain(), [], ['e1']))).toEqual(['b>c']);
  });
});

describe('freeOutputs', () => {
  it("a plain block's one output; a router's unconnected branches", () => {
    const g = chain();
    expect(freeOutputs(g, g.nodes[0]!)).toEqual([]);
    expect(freeOutputs(g, g.nodes[2]!)).toEqual(['']);
    const r = router('r', 0);
    expect(freeOutputs({ nodes: [r], edges: [{ id: 'e', from: 'r', to: 'x', branch: 'b1' }] }, r)).toEqual(['else']);
  });
});
