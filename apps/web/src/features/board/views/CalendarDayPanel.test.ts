// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Column } from '../board-api';
import { calendarValueFor } from './CalendarDayPanel';

/** what an empty day (or a run of days) writes, by the view's column type. */
const col = (type: string) => ({ id: 'c', type, title: 'C', settings: {} }) as unknown as Column;

describe('calendarValueFor', () => {
  it('a date takes the first day; a timeline the run; a week the week it falls in', () => {
    expect(calendarValueFor(col('date'), '2026-10-27', '2026-10-29', 0)).toEqual({ date: '2026-10-27' });
    expect(calendarValueFor(col('timeline'), '2026-10-27', '2026-10-29', 0)).toEqual({
      from: '2026-10-27',
      to: '2026-10-29',
    });
    // Tuesday 27 Oct 2026, weeks from Sunday.
    expect(calendarValueFor(col('week'), '2026-10-27', '2026-10-27', 0)).toEqual({
      start: '2026-10-25',
      end: '2026-10-31',
    });
  });
});
