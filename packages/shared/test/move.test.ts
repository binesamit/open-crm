// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { columnCopyFor, normalizeTitle, proposeMapping } from '../src';

describe('column mapping proposal (07 §3.4.1)', () => {
  const src = [
    { id: 'name', type: 'name', title: 'שם' },
    { id: 'status', type: 'status', title: 'סטטוס' },
    { id: 'date4', type: 'date', title: 'תאריך יעד' },
    { id: 'num', type: 'numbers', title: 'Budget' },
    { id: 'txt', type: 'text', title: 'הערות' },
    { id: 'txt2', type: 'text', title: 'עוד' },
  ];
  const dst = [
    { id: 'name', type: 'name', title: 'Item' },
    { id: 'stage', type: 'status', title: 'סְטָטוּס' },
    { id: 'due', type: 'date', title: 'מועד' },
    { id: 'n1', type: 'numbers', title: ' budget ' },
    { id: 'n2', type: 'numbers', title: 'Cost' },
    { id: 'notes', type: 'text', title: 'Notes' },
    { id: 'more', type: 'text', title: 'More' },
  ];

  it('maps name→name, type+title (niqqud/case/space-insensitive), then the only free same-type column', () => {
    expect(normalizeTitle('  סְטָטוּס ')).toBe('סטטוס');
    expect(proposeMapping(src, dst)).toEqual({
      name: 'name',
      status: 'stage',
      date4: 'due',
      num: 'n1',
      // two text columns on both sides, no title match: left for the user
      txt: null,
      txt2: null,
    });
  });

  it('never maps two sources to one target', () => {
    const m = proposeMapping(
      [
        { id: 'a', type: 'numbers', title: 'X' },
        { id: 'b', type: 'numbers', title: 'x' },
      ],
      [{ id: 't', type: 'numbers', title: 'X' }],
    );
    expect(m).toEqual({ a: 't', b: null });
  });
});

describe('a new target column from a source column (fix3)', () => {
  it('copies type, title, description and settings, minus references to other source columns', () => {
    const labels = { labels: [{ id: 1, label: 'Done', color: 'green' }] };
    expect(columnCopyFor({ type: 'status', title: 'Stage', description: null, settings: labels })).toEqual({
      title: 'Stage',
      type: 'status',
      settings: labels,
    });
    expect(
      columnCopyFor({
        type: 'date',
        title: 'Due',
        description: 'When',
        settings: { show_time: true, deadline: { status_column_id: 'status' } },
      }),
    ).toEqual({ title: 'Due', type: 'date', description: 'When', settings: { show_time: true } });
    expect(columnCopyFor({ type: 'text', title: 'Notes' })).toEqual({ title: 'Notes', type: 'text', settings: {} });
  });
});
