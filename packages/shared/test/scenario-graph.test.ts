// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { graphIssues, graphTrigger, outgoing, type ScenarioGraph } from '../src/scenarios/graph';

/** phase 3 — what keeps a scenario off, and the order its paths run in. */
const rule = {
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id: 'n', operator: 'is_not_empty', values: [], negate: false }],
} as const;
const base = (): ScenarioGraph =>
  ({
    nodes: [
      { id: 't', kind: 'trigger', x: 0, y: 0, trigger: { type: 'item_created' } },
      {
        id: 'r',
        kind: 'router',
        x: 0,
        y: 0,
        mode: 'first',
        branches: [
          { id: 'a', label: 'A', conditions: rule },
          { id: 'b', label: 'B' },
        ],
      },
      { id: 'x', kind: 'action', x: 0, y: 50, action: { type: 'archive_item' } },
      { id: 'y', kind: 'action', x: 0, y: 10, action: { type: 'archive_item' } },
      { id: 'z', kind: 'wait', x: 0, y: 0, minutes: 5 },
    ],
    edges: [
      { id: 'e1', from: 't', to: 'r' },
      { id: 'e2', from: 'r', to: 'z', branch: 'else' },
      { id: 'e3', from: 'r', to: 'x', branch: 'b' },
      { id: 'e4', from: 'r', to: 'y', branch: 'a' },
    ],
  }) as ScenarioGraph;

describe('graphIssues', () => {
  it('a sound graph has none; its trigger is found', () => {
    expect(graphIssues(base())).toEqual([]);
    expect(graphTrigger(base())?.id).toBe('t');
  });

  it('no trigger, two triggers, an unsupported trigger', () => {
    const g = base();
    g.nodes = g.nodes.filter((n) => n.kind !== 'trigger');
    expect(graphIssues(g).map((i) => i.code)).toContain('no_trigger');
    const two = base();
    two.nodes.push({ id: 't2', kind: 'trigger', x: 0, y: 0, trigger: { type: 'item_created' } } as never);
    expect(graphIssues(two).map((i) => i.code)).toContain('many_triggers');
    const date = base();
    (date.nodes[0] as { trigger: unknown }).trigger = {
      type: 'every_time_period',
      period: 'day',
      time: '09:00',
      scope: 'board',
    };
    expect(graphIssues(date)).toContainEqual({ node_id: 't', code: 'trigger_unsupported' });
  });

  it('edges: into the trigger, a router edge without a known branch, a branch off a non-router, a cycle', () => {
    const g = base();
    g.edges.push({ id: 'e5', from: 'y', to: 't' });
    g.edges.push({ id: 'e6', from: 'r', to: 'y', branch: 'nope' });
    g.edges.push({ id: 'e7', from: 'y', to: 'z', branch: 'a' });
    const codes = graphIssues(g).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['edge_into_trigger', 'edge_no_branch', 'edge_branch_not_router']));
    const loop = base();
    loop.edges.push({ id: 'e8', from: 'z', to: 'r' });
    expect(graphIssues(loop).map((i) => i.code)).toContain('cycle');
  });

  it('an unreachable block, an empty filter, an action scenarios do not offer', () => {
    const g = base();
    g.nodes.push({
      id: 'f',
      kind: 'filter',
      x: 0,
      y: 0,
      conditions: { kind: 'group', operator: 'and', negate: false, rules: [] },
    } as never);
    g.nodes.push({ id: 's', kind: 'action', x: 0, y: 0, action: { type: 'send_sms', column: 'p' } } as never);
    expect(graphIssues(g)).toEqual(
      expect.arrayContaining([
        { node_id: 'f', code: 'filter_empty' },
        { node_id: 'f', code: 'unreachable' },
        { node_id: 's', code: 'action_unsupported' },
      ]),
    );
  });
});

describe('outgoing', () => {
  it('a router: its edges by branch order, "otherwise" last; others by position', () => {
    expect(outgoing(base(), 'r').map((e) => e.to)).toEqual(['y', 'x', 'z']);
    const g = base();
    g.edges = [
      { id: 'a', from: 't', to: 'x' },
      { id: 'b', from: 't', to: 'y' },
    ];
    expect(outgoing(g, 't').map((e) => e.to)).toEqual(['y', 'x']);
  });
});
