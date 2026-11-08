// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { setLocale } from '@bines/shared';
import {
  APP_PAGE_ITEM_PATH,
  APP_PAGE_PATH,
  appPageCardRoutes,
  appPageIcon,
  appPageKey,
  appPageLabel,
  badgeIncreases,
  badgeText,
} from './app-pages';

/** the sidebar entry of an extension's page — its count, its accessible name, its announcements. */
const page = (badge: number | null, feature = 'inbox') => ({
  extension_key: 'msg',
  feature,
  name: 'שיחות',
  name_en: 'Conversations',
  badge,
  page_icon: 'chat',
});

describe('app page entry', () => {
  it('shows nothing for none or zero, the number up to 99, then "99+"', () => {
    expect(badgeText(null)).toBeNull();
    expect(badgeText(0)).toBeNull();
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });

  it('puts the count in the link name (never the colour alone) — the exact count, not the capped one', () => {
    setLocale('he');
    expect(appPageLabel(page(null))).toBe('שיחות');
    expect(appPageLabel(page(0))).toBe('שיחות');
    expect(appPageLabel(page(3))).toBe('שיחות, 3 לא נקראו');
    expect(appPageLabel(page(250))).toBe('שיחות, 250 לא נקראו');
    setLocale('en');
    expect(appPageLabel(page(3))).toBe('Conversations, 3 unread');
    setLocale('he');
  });

  it('draws a known icon, else the generic extension one', () => {
    expect(appPageIcon({ page_icon: 'chat' })).toBe('chat');
    expect(appPageIcon({ page_icon: 'noSuchIcon' })).toBe('ext');
    expect(appPageIcon({ page_icon: null })).toBe('ext');
    expect(appPageKey(page(1))).toBe('msg.inbox');
  });

  it('announces only increases, never on the first answer', () => {
    const first = badgeIncreases(null, [page(3)]);
    expect(first.message).toBe('');
    const up = badgeIncreases(first.counts, [page(5), page(null, 'other')]);
    expect(up.message).toBe('שיחות, 5 לא נקראו');
    expect(badgeIncreases(up.counts, [page(2)]).message).toBe('');
    expect(badgeIncreases(up.counts, [page(null)]).message).toBe('');
    // A new page that arrives with a count is news too.
    expect(badgeIncreases(new Map(), [page(1)]).message).toBe('שיחות, 1 לא נקראו');
  });
});

describe('an item opened from the page (openItemCard)', () => {
  it('opens over the page — another item or a subitem at the same place — and closing goes back to the page', () => {
    const routes = appPageCardRoutes({ accountSlug: 'acme', extensionKey: 'msg', featureKey: 'inbox', boardId: 'B1' });
    expect(routes.card('I1')).toEqual({
      to: APP_PAGE_ITEM_PATH,
      params: { accountSlug: 'acme', extensionKey: 'msg', featureKey: 'inbox', boardId: 'B1', itemId: 'I1' },
    });
    expect(APP_PAGE_ITEM_PATH.startsWith(`${APP_PAGE_PATH}/`)).toBe(true);
    expect(routes.back).toEqual({
      to: APP_PAGE_PATH,
      params: { accountSlug: 'acme', extensionKey: 'msg', featureKey: 'inbox' },
    });
  });
});
