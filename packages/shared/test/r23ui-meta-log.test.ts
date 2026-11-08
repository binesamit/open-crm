// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { columnTypes, DEFAULT_REGION, lastUpdatedValue, metaLogText } from '../src';

/** r23ui: what "last updated" / "created" show, and the last change of chosen columns. */
const AT = '2026-10-05T22:30:00Z';
const names = { userName: (id: string) => (id === 'u1' ? 'Dana' : undefined) };
const jerusalem = { ...DEFAULT_REGION, timezone: 'Asia/Jerusalem', time_format: '24h' as const };

describe('metaLogText', () => {
  it('shows who and when (default), only when, only who', () => {
    expect(metaLogText({ at: AT, by: 'u1' }, {}, names)).toBe('Dana · 05/10/2026');
    expect(metaLogText({ at: AT, by: 'u1' }, { mode: 'date' }, names)).toBe('05/10/2026');
    expect(metaLogText({ at: AT, by: 'u1' }, { mode: 'person' }, names)).toBe('Dana');
    // Nobody known: just the date.
    expect(metaLogText({ at: AT, by: null }, { mode: 'both' }, names)).toBe('05/10/2026');
  });

  it('adds the time of day when asked — in the reader region', () => {
    expect(metaLogText({ at: AT, by: 'u1' }, { show_time: true }, names)).toBe('Dana · 05/10/2026 22:30');
    expect(metaLogText({ at: AT, by: null }, { mode: 'date', show_time: true }, { region: jerusalem })).toBe(
      '06/10/2026 01:30',
    );
  });

  it('keeps old last-updated columns ("ago") showing the date', () => {
    expect(metaLogText({ at: AT, by: 'u1' }, { mode: 'ago' }, names)).toBe('05/10/2026');
  });
});

describe('lastUpdatedValue', () => {
  const item = { lastChangeAt: AT, lastChangeBy: 'u1' };
  const changes: Record<string, { at: string; by: string | null }> = {
    stage: { at: '2026-10-01T08:00:00Z', by: 'u2' },
    owner: { at: '2026-10-03T08:00:00Z', by: 'u3' },
  };
  const changeOf = (key: string) => changes[key];

  it('any column (default): the item last change', () => {
    expect(lastUpdatedValue({}, item, changeOf)).toEqual({ at: AT, by: 'u1' });
    expect(lastUpdatedValue({ columns: [] }, item, changeOf)).toEqual({ at: AT, by: 'u1' });
  });

  it('chosen columns: the latest change among them; none changed = empty', () => {
    expect(lastUpdatedValue({ columns: ['stage'] }, item, changeOf)).toEqual(changes.stage);
    expect(lastUpdatedValue({ columns: ['stage', 'owner'] }, item, changeOf)).toEqual(changes.owner);
    expect(lastUpdatedValue({ columns: ['nothing'] }, item, changeOf)).toBeNull();
    expect(lastUpdatedValue({ columns: ['stage'] }, item)).toBeNull();
  });

  it('the column type reads it through fromItem and validates its settings', () => {
    const def = columnTypes.get('last_updated')!;
    const meta = { id: 'i', key: null, createdAt: AT, createdBy: null, ...item, columnChange: changeOf };
    expect(def.fromItem!(meta, { columns: ['owner'] })).toEqual(changes.owner);
    expect(def.settingsSchema.safeParse({ mode: 'person', show_time: true, columns: ['a', 'b'] }).success).toBe(true);
    expect(def.settingsSchema.safeParse({ mode: 'ago' }).success).toBe(true);
    expect(def.settingsSchema.safeParse({ mode: 'later' }).success).toBe(false);
    expect(columnTypes.get('creation_log')!.settingsSchema.safeParse({ show_time: true }).success).toBe(true);
  });
});
