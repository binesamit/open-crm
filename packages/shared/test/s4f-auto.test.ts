// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  columnTypes,
  computedTriggerDate,
  DATE_TRIGGER_COLUMN_TYPES,
  dateFireAt,
  dateScheduleHash,
  evaluateConditions,
  normalizeConditions,
  TRIGGERS,
  validateRecipe,
  type QueryEnv,
  type QueryRow,
} from '../src';

/**
 * s4f — "date arrives" on a "last updated" column reads the column's computed time (of its chosen columns when
 * set, r23ui) the way the board shows it — never the item's `updated_at`.
 */
const TZ = 'Asia/Jerusalem';

describe('date trigger columns', () => {
  it('offers last updated next to date / timeline', () => {
    expect(DATE_TRIGGER_COLUMN_TYPES).toEqual(['date', 'timeline', 'last_updated']);
    expect(TRIGGERS.date_arrived.columnTypes).toContain('last_updated');
    expect(TRIGGERS.date_arrives_before.columnTypes).toContain('last_updated');
  });

  it('validates a date trigger on a last updated column (with or without chosen columns)', () => {
    const board = {
      columns: [
        { key: 'note', type: 'text', title: 'Note', settings: {} },
        { key: 'touched', type: 'last_updated', title: 'Touched', settings: { columns: ['note'] } },
        { key: 'any', type: 'last_updated', title: 'Any', settings: {} },
        { key: 'made', type: 'creation_log', title: 'Made', settings: {} },
      ],
      groups: [],
    };
    for (const column of ['touched', 'any'])
      expect(
        validateRecipe(
          {
            trigger: { type: 'date_arrived', column, offset_days: 3, time: '09:00' },
            actions: [{ type: 'archive_item' }],
          } as never,
          board,
        ).errors,
      ).toEqual([]);
    expect(
      validateRecipe(
        {
          trigger: { type: 'date_arrived', column: 'made', offset_days: 3, time: '09:00' },
          actions: [{ type: 'archive_item' }],
        } as never,
        board,
      ).errors,
    ).toEqual([{ path: 'trigger.column', code: 'column_type', detail: 'creation_log' }]);
  });
});

describe('computedTriggerDate', () => {
  const t = { type: 'date_arrived' as const, column: 'touched', offset_days: 3, time: '09:00' };
  // 23:30 UTC on Oct 5 is already Oct 6 in Israel (+03:00): the board shows Oct 6.
  const at = '2026-10-05T23:30:00.000Z';

  it('a column without the time is its local calendar date — the trigger time applies', () => {
    const stored = computedTriggerDate(at, false, TZ);
    expect(stored).toBe('2026-10-06');
    expect(dateFireAt(t, stored, TZ).toISOString()).toBe('2026-10-09T06:00:00.000Z'); // Oct 9, 09:00 Israel
  });

  it('a column that shows the time is that moment, moved by the offset', () => {
    const stored = computedTriggerDate(at, true, TZ);
    expect(stored).toBe(at);
    expect(dateFireAt(t, stored, TZ).toISOString()).toBe('2026-10-08T23:30:00.000Z');
  });

  it('a later change of the watched columns is a new schedule', () => {
    const before = computedTriggerDate(at, true, TZ);
    const after = computedTriggerDate('2026-10-07T10:00:00.000Z', true, TZ);
    expect(dateScheduleHash(t, before)).not.toBe(dateScheduleHash(t, after));
  });

  it('reads what the board shows: chosen columns vs any change', () => {
    const def = columnTypes.get('last_updated')!;
    const item = {
      id: 'i',
      key: null,
      createdAt: '2026-10-01T08:00:00.000Z',
      createdBy: null,
      lastChangeAt: '2026-10-07T12:00:00.000Z', // the last change of ANY cell
      lastChangeBy: 'u2',
      columnChange: (key: string) => (key === 'note' ? { at: '2026-10-02T09:00:00.000Z', by: 'u1' } : undefined),
    };
    const chosen = def.fromItem!(item, { columns: ['note'] }) as { at: string };
    const any = def.fromItem!(item, {}) as { at: string };
    expect(computedTriggerDate(def.toDate!(chosen, {})!, true, TZ)).toBe('2026-10-02T09:00:00.000Z');
    expect(computedTriggerDate(def.toDate!(any, {})!, true, TZ)).toBe('2026-10-07T12:00:00.000Z');
    // Chosen columns that never changed: empty — no date, no schedule.
    expect(def.fromItem!(item, { columns: ['other'] })).toBeNull();
  });
});

describe('conditions on a last updated column', () => {
  const env: QueryEnv = {
    today: '2026-10-08',
    timezone: TZ,
    weekend: 'fri_sat',
    firstDay: 0,
    meId: null,
    columns: [
      { id: 'name', type: 'name', settings: {} },
      { id: 'note', type: 'text', settings: {} },
      { id: 'touched', type: 'last_updated', settings: { columns: ['note'] } },
    ],
  };
  const board = {
    columns: [
      { key: 'note', title: 'Note', type: 'text' },
      { key: 'touched', title: 'Touched', type: 'last_updated' },
    ],
  };
  /** `touched`: the column's computed value (as the board shows it); `updated_at`: the row's own, recent. */
  const row = (touched: string | null): QueryRow => ({
    id: 'itm',
    group_id: 'g',
    parent_item_id: null,
    depth: 0,
    name: 'x',
    position: 'a',
    key: null,
    cells: touched ? { touched: { value: { at: touched, by: null }, text: null } } : {},
    created_at: '2026-09-01T08:00:00.000Z',
    created_by: null,
    updated_at: '2026-10-08T08:00:00.000Z',
  });

  it('"older than N days" reads the column, not the item updated_at', () => {
    const conditions = normalizeConditions([{ column: 'touched', operator: 'older_than_days', values: [3] }], board);
    const rules = JSON.stringify(conditions);
    expect(rules).toContain('"column_id":"touched"');
    expect(rules).not.toContain('__updated_at__');
    // Chosen column changed 10 days ago, the item yesterday: older than 3 days.
    expect(evaluateConditions(conditions, row('2026-09-28T08:00:00.000Z'), env).matched).toBe(true);
    // Changed yesterday: not older.
    expect(evaluateConditions(conditions, row('2026-10-07T08:00:00.000Z'), env).matched).toBe(false);
    // Never changed (empty): not "older than".
    expect(evaluateConditions(conditions, row(null), env).matched).toBe(false);
  });

  it('every date operator works on the column (board filter and builder alike)', () => {
    const lastWeek = normalizeConditions([{ column: 'touched', operator: 'newer_than_days', values: [7] }], board);
    expect(evaluateConditions(lastWeek, row('2026-10-05T08:00:00.000Z'), env).matched).toBe(true);
    expect(evaluateConditions(lastWeek, row('2026-09-05T08:00:00.000Z'), env).matched).toBe(false);
    const empty = normalizeConditions([{ column: 'touched', operator: 'is_empty' }], board);
    expect(evaluateConditions(empty, row(null), env).matched).toBe(true);
  });

  it('the system "last updated" shorthand stays the item updated_at', () => {
    expect(JSON.stringify(normalizeConditions([{ column: '__last_updated__', operator: 'is_today' }]))).toContain(
      '__updated_at__',
    );
  });
});
