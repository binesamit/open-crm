// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import type { MenuEntry } from '@bines/ui';
import { mobileViewMenuEntries } from './mobile-view-menu';
import type { View } from '../views/views-api';

/** Prod (f9 views): the phone's views dropdown lists every view, then the current view's actions. */
const view = (id: string, name: string, type: View['type']) => ({ id, name, type }) as unknown as View;
const views = [view('a', 'ראשית', 'table'), view('b', 'קנבן', 'kanban'), view('c', 'לוח שנה', 'calendar')];

const build = (over: Partial<Parameters<typeof mobileViewMenuEntries>[0]> = {}) => {
  const onSelect = vi.fn();
  const onManage = vi.fn();
  const entries = mobileViewMenuEntries({
    views,
    current: views[1]!,
    icon: (type) => `icon:${type}`,
    onSelect,
    currentActions: [{ label: 'rename', onSelect: () => undefined }],
    addEntries: [{ label: 'table', onSelect: () => undefined }],
    onManage,
    ...over,
  });
  return { entries, onSelect, onManage };
};
type Item = Extract<MenuEntry, { onSelect: () => void }>;
const items = (entries: MenuEntry[]) => entries.filter((e): e is Item => e.kind === undefined || e.kind === 'item');
const viewRows = (entries: MenuEntry[]) => items(entries).filter((e) => e.testId === 'mobile-view-item');

describe('mobileViewMenuEntries', () => {
  it('lists every view with its type icon, the current one marked', () => {
    const rows = viewRows(build().entries);
    expect(rows.map((r) => r.label)).toEqual(['ראשית', 'קנבן', 'לוח שנה']);
    expect(rows.map((r) => r.icon)).toEqual(['icon:table', 'icon:kanban', 'icon:calendar']);
    expect(rows.map((r) => !!r.current)).toEqual([false, true, false]);
    // Never the radio look (it hides the icon).
    expect(rows.every((r) => r.checked === undefined)).toBe(true);
  });

  it('switches to another view; the current one is a no-op', () => {
    const { entries, onSelect } = build();
    const rows = viewRows(entries);
    rows[1]!.onSelect();
    expect(onSelect).not.toHaveBeenCalled();
    rows[2]!.onSelect();
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('keeps the tab bar actions: the current view menu, new view, and all views', () => {
    const { entries, onManage } = build();
    const after = entries.slice(views.length);
    expect(after[0]).toEqual({ kind: 'separator' });
    const subs = after.filter((e) => e.kind === 'submenu');
    expect(subs.map((s) => s.testId)).toEqual(['mobile-view-actions', 'mobile-view-add-menu']);
    const actions = subs[0]!;
    expect(actions.kind === 'submenu' && actions.items.map((e) => ('label' in e ? e.label : ''))).toEqual(['rename']);
    items(after)
      .find((e) => e.testId === 'mobile-view-manage')!
      .onSelect();
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('drops an empty submenu', () => {
    const { entries } = build({ currentActions: [], addEntries: [] });
    expect(entries.some((e) => e.kind === 'submenu')).toBe(false);
    expect(items(entries).at(-1)!.testId).toBe('mobile-view-manage');
  });
});
