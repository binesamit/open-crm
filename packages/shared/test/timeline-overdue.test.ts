// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { columnTypes, getRegion, timelineDoneLabels, timelineOverdue, todayIn, type TimelineSettings } from '../src';

const status = {
  id: 'status',
  type: 'status',
  settings: {
    labels: [
      { id: 0, label: 'Working', color: 'yellow', index: 0 },
      { id: 1, label: 'Done', color: 'forest', index: 1, is_done: true },
      { id: 2, label: 'Blocked', color: 'crimson', index: 2 },
      { id: 3, label: 'Cancelled', color: 'gray', index: 3 },
    ],
  },
};
const columns = [status];
const v = { from: '2026-10-01', to: '2026-10-05' };

describe('timelineOverdue (r26)', () => {
  it('is overdue once the end date is before today; the end day itself is not', () => {
    expect(timelineOverdue(v, {}, { today: '2026-10-06' })).toBe(true);
    expect(timelineOverdue(v, {}, { today: '2026-10-05' })).toBe(false);
    expect(timelineOverdue(v, {}, { today: '2026-10-03' })).toBe(false);
    expect(timelineOverdue(null, {}, { today: '2026-10-06' })).toBe(false);
  });

  it('overdue_red false turns the red off', () => {
    expect(timelineOverdue(v, { overdue_red: false }, { today: '2026-10-09' })).toBe(false);
    expect(timelineOverdue(v, null, { today: '2026-10-09' })).toBe(true);
  });

  it('a linked status: its done labels (is_done by default) stop the red', () => {
    const s: TimelineSettings = { status_column_id: 'status' };
    const today = '2026-10-09';
    expect(timelineOverdue(v, s, { today, columns, cells: { status: { value: { index: 1 }, text: 'Done' } } })).toBe(
      false,
    );
    expect(timelineOverdue(v, s, { today, columns, cells: { status: { value: { index: 0 }, text: 'Working' } } })).toBe(
      true,
    );
    // An empty status is not done.
    expect(timelineOverdue(v, s, { today, columns, cells: {} })).toBe(true);
    // Raw stored values work too.
    expect(timelineOverdue(v, s, { today, columns, cells: { status: { index: 1 } } })).toBe(false);
  });

  it('chosen done labels replace the is_done ones', () => {
    const s: TimelineSettings = { status_column_id: 'status', done_label_ids: [1, 3] };
    const today = '2026-10-09';
    expect(timelineOverdue(v, s, { today, columns, cells: { status: { value: { index: 3 } } } })).toBe(false);
    expect(timelineOverdue(v, s, { today, columns, cells: { status: { value: { index: 2 } } } })).toBe(true);
    expect(timelineDoneLabels({ done_label_ids: [] }, status)).toEqual([1]);
    expect(timelineDoneLabels(s, status)).toEqual([1, 3]);
  });

  it('a linked status column that was deleted: by the date alone', () => {
    const s: TimelineSettings = { status_column_id: 'gone' };
    expect(timelineOverdue(v, s, { today: '2026-10-09', columns, cells: { gone: { value: { index: 1 } } } })).toBe(
      true,
    );
  });

  it("'today' is the account timezone's calendar day", () => {
    // 2026-10-05 22:30 UTC = already 2026-10-06 in Jerusalem (UTC+3), still the 5th in New York.
    const now = new Date('2026-10-05T22:30:00Z');
    const jerusalem = todayIn({ ...getRegion(), timezone: 'Asia/Jerusalem' }, now);
    const newYork = todayIn({ ...getRegion(), timezone: 'America/New_York' }, now);
    expect(jerusalem).toBe('2026-10-06');
    expect(newYork).toBe('2026-10-05');
    expect(timelineOverdue(v, {}, { today: jerusalem })).toBe(true);
    expect(timelineOverdue(v, {}, { today: newYork })).toBe(false);
  });

  it('the timeline settings schema keeps the new keys', () => {
    const def = columnTypes.get('timeline')!;
    const parsed = def.settingsSchema.parse({ overdue_red: false, status_column_id: 'status', done_label_ids: [1] });
    expect(parsed).toEqual({ overdue_red: false, status_column_id: 'status', done_label_ids: [1] });
  });
});
