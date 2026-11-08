// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  aggregateNumbers,
  canDashboard,
  clampRect,
  columnFitsRole,
  compactLayout,
  dashboardCapabilities,
  dateBucket,
  type GridItem,
  mobileOrder,
  nextFreeRect,
  parseWidgetSettings,
  placeWidget,
  readWidgetSettings,
  resolveColumnRef,
  WIDGET_TYPES,
  widgetFilterFor,
  widgetTypes,
} from '../src';

/** M8 ד4: the widget registry, settings validation, column matching across boards, the grid, permissions. */
describe('widget registry', () => {
  it('has every type with sane sizes and defaults that parse', () => {
    expect(WIDGET_TYPES).toEqual([
      'numbers',
      'chart',
      'battery',
      'table',
      'calendar',
      'timeline',
      'workload',
      'time_report',
      'board_view',
      'text',
      'extension',
    ]);
    for (const def of widgetTypes.values()) {
      expect(def.minSize.w).toBeLessThanOrEqual(def.defaultSize.w);
      expect(def.minSize.h).toBeLessThanOrEqual(def.defaultSize.h);
      expect(() => def.settingsSchema.parse(def.defaultSettings)).not.toThrow();
    }
  });

  it('validates settings and fills defaults', () => {
    expect(parseWidgetSettings('chart', {})).toMatchObject({
      chart_type: 'bar',
      x: { kind: 'board' },
      measure: { fn: 'count', column: null },
      board_ids: [],
    });
    expect(() => parseWidgetSettings('chart', { chart_type: 'radar' })).toThrow();
    expect(() => parseWidgetSettings('nope', {})).toThrow();
    // A sum needs a column.
    expect(() => parseWidgetSettings('numbers', { measure: { fn: 'sum' } })).toThrow();
    expect(
      parseWidgetSettings('numbers', { measure: { fn: 'sum', column: { type: 'numbers', title: 'X' } } }),
    ).toMatchObject({ measure: { fn: 'sum' } });
    expect(() => parseWidgetSettings('table', { limit: 1000 })).toThrow();
    // Stored settings that no longer parse fall back to the defaults.
    expect(readWidgetSettings('text', { text: 5 })).toEqual({ text: '' });
  });
});

describe('columns across boards', () => {
  const cols = [
    { id: 'status', type: 'status', title: 'Status' },
    { id: 'stage', type: 'status', title: 'Stage' },
    { id: 'amount', type: 'numbers', title: ' amount ' },
  ];
  it('matches by type + title, or the key chosen for the board', () => {
    expect(resolveColumnRef({ type: 'numbers', title: 'Amount' }, 'b1', cols)).toBe('amount');
    expect(resolveColumnRef({ type: 'status', title: 'Status' }, 'b1', cols)).toBe('status');
    expect(resolveColumnRef({ type: 'status', title: 'Status', keys: { b1: 'stage' } }, 'b1', cols)).toBe('stage');
    // A manual key that is gone falls back to the title.
    expect(resolveColumnRef({ type: 'status', title: 'Status', keys: { b1: 'gone' } }, 'b1', cols)).toBe('status');
    expect(resolveColumnRef({ type: 'date', title: 'Status' }, 'b1', cols)).toBeNull();
  });

  it('turns a widget filter into a board query; a missing column drops the board under "and"', () => {
    const rule = (title: string) => ({
      column: { type: 'status', title },
      operator: 'any_of' as const,
      values: ['Done'],
    });
    expect(widgetFilterFor(undefined, 'b1', cols)).toBeUndefined();
    expect(widgetFilterFor({ operator: 'and', rules: [rule('Status')] }, 'b1', cols)).toEqual({
      kind: 'group',
      operator: 'and',
      negate: false,
      rules: [{ kind: 'rule', column_id: 'status', operator: 'any_of', values: ['Done'], negate: false }],
    });
    expect(widgetFilterFor({ operator: 'and', rules: [rule('Status'), rule('Missing')] }, 'b1', cols)).toBeNull();
    expect(
      widgetFilterFor({ operator: 'or', rules: [rule('Status'), rule('Missing')] }, 'b1', cols)?.rules,
    ).toHaveLength(1);
  });

  it('knows which columns fit a field', () => {
    expect(columnFitsRole('status', 'labels')).toBe(true);
    expect(columnFitsRole('dropdown', 'labels')).toBe(true);
    expect(columnFitsRole('numbers', 'number')).toBe(true);
    expect(columnFitsRole('text', 'number')).toBe(false);
    expect(columnFitsRole('date', 'date')).toBe(true);
    expect(columnFitsRole('people', 'people')).toBe(true);
    expect(columnFitsRole('file', 'any')).toBe(false);
  });

  it('aggregates like the group footer and buckets dates', () => {
    expect(aggregateNumbers('count', [1, 2])).toBe(2);
    expect(aggregateNumbers('sum', [1, 2, 3])).toBe(6);
    expect(aggregateNumbers('avg', [1, 2, 3])).toBe(2);
    expect(aggregateNumbers('median', [5, 1, 2, 9])).toBe(3.5);
    expect(aggregateNumbers('min', [])).toBeNull();
    expect(dateBucket('2026-10-07', 'month')).toBe('2026-10');
    expect(dateBucket('2026-11-30', 'quarter')).toBe('2026-Q4');
    expect(dateBucket('2026-10-07', 'week', 0)).toBe('2026-10-04'); // a Wednesday → its Sunday
    expect(dateBucket('2026-10-07', 'year')).toBe('2026');
  });
});

describe('dashboard grid', () => {
  const it3 = (id: string, x: number, y: number, w: number, h: number): GridItem => ({ id, rect: { x, y, w, h } });

  it('floats widgets up and never overlaps', () => {
    const out = compactLayout([it3('a', 0, 5, 6, 2), it3('b', 6, 9, 6, 2), it3('c', 0, 10, 12, 1)]);
    expect(out.map((i) => [i.id, i.rect.y])).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 2],
    ]);
  });

  it('a placed widget keeps its rect; what it lands on moves down', () => {
    const out = placeWidget([it3('a', 0, 0, 6, 2), it3('b', 6, 0, 6, 2)], 'b', { x: 3, y: 0, w: 6, h: 2 });
    expect(out.find((i) => i.id === 'b')!.rect).toEqual({ x: 3, y: 0, w: 6, h: 2 });
    expect(out.find((i) => i.id === 'a')!.rect).toEqual({ x: 0, y: 2, w: 6, h: 2 });
  });

  it('clamps to the grid and the minimum size; new widgets go under everything; phones read in order', () => {
    expect(clampRect({ x: 10, y: -1, w: 6, h: 0 }, { w: 3, h: 2 })).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(nextFreeRect([it3('a', 0, 0, 6, 3)], { w: 4, h: 2 })).toEqual({ x: 0, y: 3, w: 4, h: 2 });
    expect(
      mobileOrder([
        { id: 'b', position: { x: 6, y: 0, w: 6, h: 2 } },
        { id: 'c', position: { x: 0, y: 2, w: 6, h: 2 } },
        { id: 'a', position: { x: 0, y: 0, w: 6, h: 2 } },
      ]).map((w) => w.id),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('dashboard permissions (D25)', () => {
  const ctx = (over: Partial<Parameters<typeof canDashboard>[0]> = {}) => ({
    accountRole: 'member' as const,
    workspaceVisible: true,
    dashboard: { kind: 'main' as const },
    level: null,
    ...over,
  });
  it('main = the workspace looks; owners edit; private = invited; guests never; viewers only look', () => {
    expect(dashboardCapabilities(ctx())).toEqual({
      'dashboard.read': true,
      'dashboard.edit': false,
      'dashboard.manage': false,
    });
    expect(canDashboard(ctx({ level: 'owner' }), 'dashboard.manage').ok).toBe(true);
    expect(canDashboard(ctx({ dashboard: { kind: 'private' } }), 'dashboard.read')).toMatchObject({ as404: true });
    expect(canDashboard(ctx({ dashboard: { kind: 'private' }, level: 'viewer' }), 'dashboard.read').ok).toBe(true);
    expect(canDashboard(ctx({ workspaceVisible: false }), 'dashboard.read').ok).toBe(false);
    expect(canDashboard(ctx({ accountRole: 'guest', level: 'owner' }), 'dashboard.read').ok).toBe(false);
    expect(canDashboard(ctx({ accountRole: 'viewer', level: 'owner' }), 'dashboard.edit').ok).toBe(false);
    expect(canDashboard(ctx({ accountRole: 'admin', dashboard: { kind: 'private' } }), 'dashboard.manage').ok).toBe(
      true,
    );
  });

  it('editors edit but do not manage; guests only on a shareable dashboard, never as owners', () => {
    expect(dashboardCapabilities(ctx({ dashboard: { kind: 'private' }, level: 'editor' }))).toEqual({
      'dashboard.read': true,
      'dashboard.edit': true,
      'dashboard.manage': false,
    });
    const guest = (kind: 'main' | 'private' | 'shareable', level: 'owner' | 'editor' | 'viewer' | null) =>
      dashboardCapabilities(ctx({ accountRole: 'guest', dashboard: { kind }, level }));
    expect(guest('shareable', 'viewer')).toEqual({
      'dashboard.read': true,
      'dashboard.edit': false,
      'dashboard.manage': false,
    });
    expect(guest('shareable', 'owner')).toEqual({
      'dashboard.read': true,
      'dashboard.edit': true,
      'dashboard.manage': false,
    });
    expect(guest('shareable', null)['dashboard.read']).toBe(false);
    expect(guest('private', 'viewer')['dashboard.read']).toBe(false);
    expect(guest('main', 'viewer')['dashboard.read']).toBe(false);
    // A shareable dashboard is invited-only for members too.
    expect(canDashboard(ctx({ dashboard: { kind: 'shareable' } }), 'dashboard.read').ok).toBe(false);
  });
});
