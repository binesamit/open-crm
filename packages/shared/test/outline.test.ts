// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  groupRows,
  outlineRequestSchema,
  outlineSchema,
  outlineSections,
  planQuery,
  querySchema,
  resolveField,
  summarize,
} from '../src';
import { env, fixtureRows } from './query-fixtures';

/**
 * Windowed boards (perf review §7.1): the server's outline must be what the browser computes over the whole
 * board — the same ids per section, in the same order, with the same summaries.
 */
const e = env();
const rows = () => applyPlan(fixtureRows(), planQuery(querySchema.parse({}), e), e.timezone);
const groupOrder = [...new Set(fixtureRows().map((r) => r.group_id ?? ''))];

describe('outlineSections', () => {
  it('by board group: sections in the board order, ids in row order, summaries over the whole section', () => {
    const all = rows();
    const amount = resolveField('amount', e);
    const status = resolveField('status', e);
    const out = outlineSections(all, {
      timezone: e.timezone,
      groupOrder: [...groupOrder].reverse(),
      summaries: [{ field: status }, { field: amount, fn: 'max' }],
      groupSummary: { field: amount, fn: 'sum' },
    });
    expect(out.map((s) => s.key)).toEqual([...groupOrder].reverse().filter((g) => all.some((r) => r.group_id === g)));
    for (const s of out) {
      const mine = all.filter((r) => (r.group_id ?? '') === s.key);
      expect(s.ids).toEqual(mine.map((r) => r.id));
      expect(s.summaries.status).toEqual(summarize(status, mine, e.timezone));
      expect(s.summaries.amount).toEqual(summarize(amount, mine, e.timezone, 'max'));
      expect(s.group_summary).toEqual(summarize(amount, mine, e.timezone, 'sum'));
    }
    expect(outlineSchema.parse({ total: all.length, sections: out }).sections).toHaveLength(out.length);
  });

  it('rows of a group the board no longer has are left out', () => {
    const out = outlineSections(rows(), { timezone: e.timezone, groupOrder: [groupOrder[0]!], summaries: [] });
    expect(out.map((s) => s.key)).toEqual([groupOrder[0]]);
  });

  it('grouped by a column: the same buckets as the browser groups into', () => {
    for (const id of ['status', 'tags', 'owner', 'amount', 'due']) {
      const field = resolveField(id, e);
      const out = outlineSections(rows(), {
        timezone: e.timezone,
        groupOrder: [],
        groupBy: { field, direction: 'desc' },
        dates: e,
        summaries: [],
      });
      const want = groupRows(rows(), field, {
        timezone: e.timezone,
        direction: 'desc',
        emptyLabel: '',
        checkedLabel: '',
        dates: { env: e, label: (b) => b },
      });
      expect(out.map((s) => [s.key, s.ids])).toEqual(want.map((b) => [b.key, b.rows.map((r) => r.id)]));
    }
  });
});

describe('outline request', () => {
  it('defaults: empty query, no summaries, by board group', () => {
    expect(outlineRequestSchema.parse({})).toMatchObject({ summaries: [], layout: 'groups', query: { sort: [] } });
  });
  it('rejects unknown summary functions', () => {
    expect(() => outlineRequestSchema.parse({ summaries: [{ column_id: 'a', fn: 'mode' }] })).toThrow();
  });
});
