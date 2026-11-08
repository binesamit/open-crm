// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { relativeTime, resolveCardTabs } from '../src';

describe('resolveCardTabs (N19)', () => {
  it('a new board gets updates, fields, time, activity', () => {
    expect(resolveCardTabs(undefined).map((t) => t.id)).toEqual([
      'updates',
      'fields',
      'subitems',
      'time',
      'activity',
      'documents',
    ]);
  });
  it('keeps the saved order, updates always first; drops duplicates; adds unlisted single tabs', () => {
    const tabs = resolveCardTabs({
      tabs: [
        { id: 'activity', type: 'activity', hidden: true },
        { id: 'updates', type: 'updates', hidden: true },
        { id: 'money', type: 'fields', title: 'כספים', columns: ['sum'] },
        { id: 'fields', type: 'fields' },
        { id: 'act2', type: 'activity' },
      ],
    });
    expect(tabs.map((t) => t.id)).toEqual(['updates', 'activity', 'money', 'fields', 'subitems', 'time', 'documents']);
    expect(tabs[0]!.hidden).toBe(false);
    expect(tabs[1]!.hidden).toBe(true);
  });
  it('ignores invalid settings', () => {
    expect(resolveCardTabs({ tabs: 'x' }).length).toBe(6);
  });
});

describe('relativeTime (N17)', () => {
  const now = new Date(2026, 9, 4, 12, 0).getTime();
  const ago = (min: number) => relativeTime(new Date(now - min * 60_000).toISOString(), now);
  it('reads like the canvas', () => {
    expect(ago(0)).toBe('עכשיו');
    expect(ago(20)).toBe('לפני 20 דק׳');
    expect(ago(61)).toBe('לפני שעה');
    expect(ago(180)).toBe('לפני 3 שעות');
    expect(ago(60 * 24)).toMatch(/^אתמול • \d\d:\d\d$/);
    expect(ago(60 * 24 * 2)).toBe('לפני יומיים');
    expect(ago(60 * 24 * 3)).toBe('לפני 3 ימים');
    expect(ago(60 * 24 * 8)).toBe('לפני שבוע');
  });
});
