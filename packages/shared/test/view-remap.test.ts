// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { remapViewSettings, viewSettingsSchema } from '../src';

describe('remapViewSettings (copy a view to another board)', () => {
  it('maps every column reference and drops what the target lacks', () => {
    const s = viewSettingsSchema.parse({
      query: {
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [
            { column_id: 'status', operator: 'any_of', values: ['Done'] },
            { column_id: 'gone', operator: 'is_empty' },
            { kind: 'group', operator: 'or', rules: [{ column_id: 'gone', operator: 'is_empty' }] },
            { column_id: '__group__', operator: 'any_of', values: ['g1'] },
          ],
        },
        sort: [
          { column_id: 'date', direction: 'asc' },
          { column_id: 'gone', direction: 'desc' },
        ],
        group_by: { column_id: 'status' },
        search: 'x',
      },
      hidden_columns: ['gone', 'date'],
      column_widths: { status: 200, gone: 100 },
      kanban: { column_id: 'status', card_fields: ['date', 'gone'], lane_order: ['1', '0'] },
    });
    const out = remapViewSettings(s, (k) => ({ status: 'status_1', date: 'date' })[k] ?? null);
    expect(out.query.filter!.rules.map((r) => ('column_id' in r ? r.column_id : 'group'))).toEqual([
      'status_1',
      '__group__',
    ]);
    expect(out.query.sort.map((x) => x.column_id)).toEqual(['date']);
    expect(out.query.group_by?.column_id).toBe('status_1');
    expect(out.query.search).toBe('x');
    expect(out.hidden_columns).toEqual(['date']);
    expect(out.column_widths).toEqual({ status_1: 200 });
    expect(out.kanban).toMatchObject({ column_id: 'status_1', card_fields: ['date'], lane_order: [] });
  });
});
