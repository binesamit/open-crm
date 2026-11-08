// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t } from '@bines/shared';
import { Button, Notice, SkeletonRows } from '@bines/ui';
import { api, type Me, type MyAccount } from '../../lib/api';
import { ItemCard } from '../item/ItemCard';
import { useBoardLive } from '../board/use-board-live';
import { AppFrame } from './AppFrame';
import { useExtensionFeatures } from './extensions-api';
import { jsonCopy } from './frame-protocol';

/** What a panel's host may hand the page (JSON, this big at most). */
const PARAMS_MAX = 16 * 1024;
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The message an embedding site sends to change what the panel was opened with. */
export const PANEL_CONTEXT_MESSAGE = 'bines-panel:context';

/**
 * The site that frames this page, when it is one: the browser names it (`ancestorOrigins`); the server only lets the
 * owner's allowed embedding origins frame a panel page at all (frame-ancestors), so this is one of them.
 */
const embedderOrigin = (): string | null => {
  if (window.parent === window) return null;
  const list = window.location.ancestorOrigins;
  return list && list.length ? list[0]! : null;
};

/** The search string as plain params (what the panel was opened with), minus the host's own keys. */
export const panelParamsFromSearch = (search: string): Record<string, string> => {
  const out: Record<string, string> = {};
  new URLSearchParams(search).forEach((v, k) => {
    if (k !== 'item' && Object.keys(out).length < 30) out[k.slice(0, 40)] = v.slice(0, 500);
  });
  return out;
};

/**
 * An extension's panel: a page of its own, without the app's chrome — the extension's page in a
 * strip on top and, under it, the app's own item card (the same one as everywhere) for the item the page opens
 * (`openItemCard`) or the one in `?item=`. Meant to be framed by a site the owner allowed (a browser side panel);
 * the card runs with this person's own session and rights. Messages from the embedding site (`bines-panel:context`)
 * reach the page as its `context.params`.
 */
export const PanelPage = ({ account, me, installationId }: { account: MyAccount; me: Me; installationId: string }) => {
  const features = useExtensionFeatures(account.id);
  const feature = (features.data?.data ?? []).find((f) => f.type === 'panel' && f.installation_id === installationId);
  const [params, setParams] = useState<Record<string, unknown>>(() => panelParamsFromSearch(window.location.search));
  const [itemId, setItemId] = useState<string | null>(() => {
    const id = new URLSearchParams(window.location.search).get('item');
    return id && ID_RE.test(id) ? id : null;
  });

  useEffect(() => {
    const origin = embedderOrigin();
    if (!origin) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== origin) return;
      const m = e.data as { type?: unknown; params?: unknown; item?: unknown } | null;
      if (!m || typeof m !== 'object' || m.type !== PANEL_CONTEXT_MESSAGE) return;
      const next = jsonCopy(m.params, PARAMS_MAX);
      if (next && typeof next === 'object' && !Array.isArray(next)) setParams(next as Record<string, unknown>);
      if (typeof m.item === 'string' && ID_RE.test(m.item)) setItemId(m.item);
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'bines-panel:ready' }, origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (features.isPending) return <SkeletonRows rows={4} label={t('common.loading')} />;
  if (!feature)
    return (
      <main className="p-4" data-testid="panel-missing">
        <Notice tone="error">{t('ext.panel.missing')}</Notice>
      </main>
    );
  return (
    <div className="flex h-dvh flex-col bg-surface" data-testid="ext-panel">
      <AppFrame
        accountId={account.id}
        view={feature}
        place={{}}
        context={{ surface: 'panel', board_id: '', item_id: itemId, params }}
        user={{ id: me.user.id, name: me.user.name }}
        onOpenItem={setItemId}
        initialHeight={120}
      />
      <div className="min-h-0 flex-1 overflow-auto border-t border-line">
        {itemId ? <PanelCard key={itemId} account={account} me={me} itemId={itemId} /> : null}
      </div>
    </div>
  );
};

/** The app's own card for one item; its board comes from the item (the page passes only an id). */
const PanelCard = ({ account, me, itemId }: { account: MyAccount; me: Me; itemId: string }) => {
  const item = useQuery({
    queryKey: ['panel-item-board', account.id, itemId],
    queryFn: () => api(account.id).get<{ board_id: string }>(`/items/${itemId}`),
  });
  if (item.isPending) return <SkeletonRows rows={6} label={t('common.loading')} />;
  if (!item.data) return <Notice tone="error">{t('error.not_found')}</Notice>;
  return <LiveCard account={account} me={me} boardId={item.data.board_id} itemId={itemId} />;
};

const LiveCard = ({
  account,
  me,
  boardId,
  itemId,
}: {
  account: MyAccount;
  me: Me;
  boardId: string;
  itemId: string;
}) => {
  // The board's live events keep the card current, as on the board page.
  useBoardLive(account.id, boardId);
  return <ItemCard account={account} me={me} boardId={boardId} itemId={itemId} />;
};

/** Signed out inside a panel: sign-in pages are never framed, so it opens in a tab; this page reloads after. */
export const PanelSignIn = () => (
  <main className="flex flex-col items-start gap-3 p-4" data-testid="panel-signin">
    <Notice>{t('ext.panel.signin')}</Notice>
    <div className="flex gap-2">
      <Button onClick={() => window.open(`${window.location.origin}/login`, '_blank', 'noopener')}>
        {t('ext.panel.signin_open')}
      </Button>
      <Button variant="ghost" onClick={() => window.location.reload()}>
        {t('ext.panel.retry')}
      </Button>
    </div>
  </main>
);
