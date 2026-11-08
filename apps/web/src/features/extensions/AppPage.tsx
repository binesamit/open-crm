// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { t, type MyAccount } from '@bines/shared';
import { Notice, SkeletonRows } from '@bines/ui';
import { api } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { useHeightAboveKeyboard } from '../../lib/use-keyboard';
import { AppFrame } from './AppFrame';
import { APP_PAGE_ITEM_PATH, appPageName, badgeIncreases, useAppPages } from './app-pages';
import { useMe } from './ExtensionSlots';

/**
 * an extension's page in the sidebar (`/a/<account>/apps/<extension>/<page>`) — its frame fills the
 * panel. Any member the installation reaches may open it (guests only where the admin allowed them); its token works
 * on the installation's boards this member reads, with the member's own rights (as a panel's). `openItemCard` opens
 * the app's own item card over the page (a child route, `cardOpen`), so the member stays on the page; closing it
 * gives the focus back to the frame. Gone (turned off, removed, not for me): a notice.
 */
export const AppPageView = ({
  account,
  extensionKey,
  featureKey,
  cardOpen = false,
}: {
  account: Pick<MyAccount, 'id' | 'slug'>;
  extensionKey: string;
  featureKey: string;
  /** An item card is open over the page. */
  cardOpen?: boolean;
}) => {
  const pages = useAppPages(account.id);
  const user = useMe(account.id);
  const navigate = useNavigate();
  const page = pages.data?.data.find((p) => p.extension_key === extensionKey && p.feature === featureKey);
  // The page passes only an id; the card's board comes from the item (read with the member's own rights).
  const openItem = useCallback(
    (itemId: string) =>
      void api(account.id)
        .get<{ board_id: string }>(`/items/${itemId}`)
        .then(
          (item) =>
            navigate({
              to: APP_PAGE_ITEM_PATH,
              params: { accountSlug: account.slug, extensionKey, featureKey, boardId: item.board_id, itemId },
            } as never),
          () => showToast({ message: t('error.not_found'), tone: 'error' }),
        ),
    [account.id, account.slug, extensionKey, featureKey, navigate],
  );
  // Closing the card gives the focus back to the page's frame (where the member was).
  const frameBox = useRef<HTMLDivElement>(null);
  // iOS: the keyboard shrinks only the visual viewport (the shell stays h-dvh) — the frame ends above it, so a
  // composer at the bottom of the page stays in sight.
  const aboveKeyboard = useHeightAboveKeyboard(frameBox);
  const wasOpen = useRef(cardOpen);
  useEffect(() => {
    if (wasOpen.current && !cardOpen) frameBox.current?.querySelector('iframe')?.focus();
    wasOpen.current = cardOpen;
  }, [cardOpen]);
  if (pages.isPending) return <SkeletonRows rows={6} label={t('app.loading')} />;
  if (!page)
    return (
      <div className="p-4" data-testid="ext-app-page-missing">
        <h1 className="sr-only">{t('appPage.unavailable')}</h1>
        <Notice tone="warn">{t('appPage.unavailable')}</Notice>
      </div>
    );
  return (
    // Edge to edge on phones (the page draws its own margins); a frame of space on larger screens.
    <section className="flex min-h-0 flex-1 flex-col p-0 md:p-3" data-testid="ext-app-page">
      {/* The tab title and screen readers name the screen by its heading (WCAG 2.4.2); the frame has its own. */}
      <h1 className="sr-only">{appPageName(page)}</h1>
      <div
        ref={frameBox}
        className="min-h-0 flex-1"
        style={aboveKeyboard !== null ? { flex: 'none', height: aboveKeyboard } : undefined}
      >
        <AppFrame
          key={`${page.installation_id}:${page.feature}`}
          accountId={account.id}
          view={page}
          place={{}}
          context={{ surface: 'app_page', board_id: '' }}
          user={user}
          onOpenItem={openItem}
          fill
        />
      </div>
    </section>
  );
};

/**
 * One polite announcement when a page's count goes up ("Conversations, 3 unread") — never when it goes down, never
 * on the first load, never twice for the same count. Mounted once by the shell.
 */
export const AppPageAnnouncer = ({ accountId }: { accountId: string }) => {
  const pages = useAppPages(accountId).data?.data;
  const counts = useRef<Map<string, number> | null>(null);
  const [said, setSaid] = useState({ text: '', n: 0 });
  useEffect(() => {
    if (!pages) return;
    const next = badgeIncreases(counts.current, pages);
    counts.current = next.counts;
    if (next.message) setSaid((s) => ({ text: next.message, n: s.n + 1 }));
  }, [pages]);
  return (
    <div role="status" aria-live="polite" className="sr-only" data-testid="app-page-announcer">
      {/* The same words again (3 → 2 → 3) are still news: a new node makes the reader say them. */}
      <span key={said.n}>{said.text}</span>
    </div>
  );
};
