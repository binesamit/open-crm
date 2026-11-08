// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { helpRouteOf, type MyAccount, t } from '@bines/shared';
import { autoFocusSearch, Button, Dialog, EmptyState, Input, SkeletonRows } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { useHelpOptions, useHelpSearch } from './help-api';
import { ArticleView, AssistantStep, HitList } from './HelpPieces';
import { useDebounced } from '../../lib/use-debounced';

/**
 * The "?" menu's help center (stage 2): "articles for this page" (the owner's screen → tags mapping)
 * a search (Hebrew-aware), an article with "did this help?", the help assistant (when the plan includes AI and a
 * connection is available), "still need help" → the ticket form with what was typed, and a link to the knowledge
 * center's full page.
 */
export const HelpPanel = ({
  account,
  onClose,
  onTicket,
  mayOpenTicket,
}: {
  account: MyAccount;
  onClose: () => void;
  /** "Still need help": the ticket form, filled with the question. */
  onTicket: (subject: string, description: string) => void;
  mayOpenTicket: boolean;
}) => {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const route = helpRouteOf(pathname);
  const options = useHelpOptions(account.id);
  const [q, setQ] = useState('');
  const query = useDebounced(q, 300);
  const [open, setOpen] = useState<string | null>(null);
  const forPage = useHelpSearch(account.id, '', { route, enabled: !query.trim() });
  const results = useHelpSearch(account.id, query, { mode: 'search' });
  const searching = query.trim().length >= 2;
  const list = searching ? results : forPage;
  const hits = list.data?.data ?? [];
  const o = options.data;
  /** The knowledge center's full page — at the open article, if one is open. */
  const openPage = () => {
    onClose();
    void navigate({
      to: '/a/$accountSlug/help',
      params: { accountSlug: account.slug },
      search: open ? { article: open } : {},
    } as never);
  };

  return (
    <Dialog open onClose={onClose} title={t('help.title')} subtitle={account.name} className="max-w-xl!">
      <div className="space-y-3" data-testid="help-panel" data-route={route}>
        {open ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)} data-testid="help-back">
              <Icon name="back" size={14} />
              {t('help.back')}
            </Button>
            <ArticleView
              accountId={account.id}
              id={open}
              onOpen={setOpen}
              onHelpful={() => undefined}
              onNotHelpful={() => setOpen(null)}
              onTour={onClose}
            />
          </>
        ) : (
          <>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('help.search')}
              aria-label={t('help.search')}
              autoFocus={autoFocusSearch()}
              data-testid="help-search"
            />
            <p className="text-xs font-semibold text-fg-2">{searching ? t('help.results') : t('help.forThisPage')}</p>
            {list.isPending && (searching || list.fetchStatus !== 'idle') ? (
              <SkeletonRows rows={3} label={t('app.loading')} />
            ) : hits.length ? (
              <HitList hits={hits} onOpen={(h) => setOpen(h.id)} />
            ) : (
              <EmptyState
                className="py-6"
                testId="help-empty"
                title={searching ? t('help.noResults') : t('help.noPageArticles')}
              >
                {searching ? t('help.noResultsHint') : null}
              </EmptyState>
            )}
            {searching ? (
              <AssistantStep accountId={account.id} options={o} question={query} onOpenArticle={setOpen} />
            ) : null}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
          <Button size="sm" variant="ghost" onClick={openPage} data-testid="help-open-kb-page">
            <Icon name="book" size={14} />
            {t('kb.panel.openPage')}
          </Button>
          {mayOpenTicket ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted">{t('help.stillNeed')}</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onTicket(q.trim().slice(0, 200), q.trim())}
                data-testid="help-open-ticket-from-panel"
              >
                <Icon name="chat" size={14} />
                {t('tickets.menu.open')}
              </Button>
            </span>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
};
