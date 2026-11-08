// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APP_PAGE_LIVE_EVENTS, getLocale, t, type ExtensionAppPage } from '@bines/shared';
import { api } from '../../lib/api';
import { isIconName, type IconName } from '../../lib/icons';
import { useEventStream } from '../../lib/realtime';
import type { ItemCardRoutes } from '../item/ItemCard';
import { extKeys } from './extensions-api';

/**
 * the extensions' pages in the sidebar (`app_page`) — GET /extensions/app-pages, with the count beside
 * each. Under the extensions' key, so installing / removing / turning one off refreshes the sidebar too; a count the
 * extension changes reaches every open tab over `/me/events`. Nothing here is specific to any extension.
 */
export const appPagesKey = (accountId: string) => [...extKeys.list(accountId), 'app-pages'] as const;

export const useAppPages = (accountId: string, enabled = true) => {
  const qc = useQueryClient();
  const key = appPagesKey(accountId);
  useEventStream(enabled ? '/me/events' : null, accountId, (e) => {
    if (APP_PAGE_LIVE_EVENTS.has(e.type) || e.type === 'resync') void qc.invalidateQueries({ queryKey: key });
  });
  return useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<{ data: ExtensionAppPage[] }>('/extensions/app-pages'),
    staleTime: 60_000,
    enabled,
  });
};

/** A sidebar page and the item card open over it. */
export const APP_PAGE_PATH = '/a/$accountSlug/apps/$extensionKey/$featureKey';
export const APP_PAGE_ITEM_PATH = `${APP_PAGE_PATH}/i/$boardId/$itemId`;

/**
 * Where an item card opened from a sidebar page lives (`openItemCard`): over the page, as a dashboard's card does —
 * another item or a subitem opens at the same place, and closing the card goes back to the page, never to the board.
 */
export const appPageCardRoutes = (p: {
  accountSlug: string;
  extensionKey: string;
  featureKey: string;
  boardId: string;
}): ItemCardRoutes => {
  const page = { accountSlug: p.accountSlug, extensionKey: p.extensionKey, featureKey: p.featureKey };
  return {
    card: (itemId) => ({ to: APP_PAGE_ITEM_PATH, params: { ...page, boardId: p.boardId, itemId } }),
    back: { to: APP_PAGE_PATH, params: page },
  };
};

/** `<extension key>.<feature key>` — how the nav layout places a page. */
export const appPageKey = (p: Pick<ExtensionAppPage, 'extension_key' | 'feature'>) => `${p.extension_key}.${p.feature}`;

/** The page's name in the app's language. */
export const appPageName = (p: Pick<ExtensionAppPage, 'name' | 'name_en'>) =>
  (getLocale() === 'en' ? p.name_en : null) ?? p.name;

/** The drawing its entry names, if the app has it; else the generic extension icon. */
export const appPageIcon = (p: Pick<ExtensionAppPage, 'page_icon'>): IconName =>
  isIconName(p.page_icon) ? p.page_icon : 'ext';

/** The count as the chip shows it: nothing for none / zero, "99+" above 99. */
export const badgeText = (n: number | null | undefined): string | null =>
  !n || n < 0 ? null : n > 99 ? '99+' : String(n);

/** The link's accessible name: "<name>, <n> unread" while there is a count (never the colour alone). */
export const appPageLabel = (p: Pick<ExtensionAppPage, 'name' | 'name_en' | 'badge'>) => {
  const name = appPageName(p);
  return p.badge && p.badge > 0 ? t('appPage.badge', { name, count: String(p.badge) }) : name;
};

/**
 * What to announce (politely) after a refetch: the pages whose count went **up** since the last answer — never on the
 * first answer, never when a count went down or away. Returns the announcement (or '') and the counts to remember.
 */
export const badgeIncreases = (
  before: ReadonlyMap<string, number> | null,
  pages: Pick<ExtensionAppPage, 'extension_key' | 'feature' | 'name' | 'name_en' | 'badge'>[],
): { message: string; counts: Map<string, number> } => {
  const counts = new Map(pages.map((p) => [appPageKey(p), p.badge ?? 0]));
  if (!before) return { message: '', counts };
  const up = pages.filter((p) => (p.badge ?? 0) > (before.get(appPageKey(p)) ?? 0));
  return { message: up.map((p) => appPageLabel(p)).join('. '), counts };
};
