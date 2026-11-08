// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Column, type FilterRule, mirrorSourceOf, setLocale, t } from '@bines/shared';
import { RuleEditor, ruleChipLabel } from './FilterPanel';

/**
 * a mirror rule that looks for a value offers "any / all linked items" next to its operator (and its
 * chip says "all"); other rules — and a mirror's "is not" — do not.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
setLocale('en');

const labels = [
  { id: 0, label: 'In progress', color: 'yellow' },
  { id: 1, label: 'Done', color: 'forest', is_done: true },
];
const columns = [
  {
    id: 'm',
    title: 'Deal stages',
    type: 'mirror',
    settings: { relation_column_id: 'rel', source_column_id: 'x' },
    mirror_source: mirrorSourceOf('status', { labels }, { withLabels: true }),
  },
  { id: 'notes', title: 'Notes', type: 'text', settings: {} },
] as unknown as Column[];
const ctx = {
  columns,
  subColumns: [],
  groups: [],
  members: [],
  teams: [],
  tags: [],
  meId: 'u1',
  env: {
    columns: columns.map((c) => ({ id: c.id, type: c.type, settings: c.settings, mirror_source: c.mirror_source })),
    meId: 'u1',
    today: '2026-10-25',
    timezone: 'UTC',
    weekend: 'fri_sat' as const,
    firstDay: 0,
  },
} as unknown as Parameters<typeof RuleEditor>[0]['ctx'];

const rule = (r: Partial<FilterRule>): FilterRule => ({
  kind: 'rule',
  column_id: 'm',
  operator: 'any_of',
  values: ['Done'],
  negate: false,
  ...r,
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
const render = async (r: FilterRule) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(RuleEditor, { rule: r, ctx, onChange: vi.fn(), onRemove: vi.fn() }));
  });
  return document.querySelector<HTMLElement>('[data-testid="rule-match"]');
};

describe('mirror rules: any / all linked items', () => {
  it('shows the choice on a mirror "is" / "done" rule, with the stored value', async () => {
    expect((await render(rule({})))?.textContent).toContain(t('filter.match.any'));
    act(() => root?.unmount());
    expect((await render(rule({ match: 'all' })))?.textContent).toContain(t('filter.match.all'));
    act(() => root?.unmount());
    expect(await render(rule({ operator: 'is_done', values: [] }))).not.toBeNull();
  });

  it('not on "is not", "is empty", or another column', async () => {
    expect(await render(rule({ operator: 'not_any_of' }))).toBeNull();
    act(() => root?.unmount());
    expect(await render(rule({ operator: 'is_empty', values: [] }))).toBeNull();
    act(() => root?.unmount());
    expect(await render(rule({ column_id: 'notes', operator: 'contains_text', values: ['x'] }))).toBeNull();
  });

  it('the chip says "all linked items"', () => {
    expect(ruleChipLabel(rule({ match: 'all' }), ctx)).toBe(`Deal stages: ${t('filter.match.all')} Done`);
    expect(ruleChipLabel(rule({}), ctx)).toBe('Deal stages: Done');
  });
});
