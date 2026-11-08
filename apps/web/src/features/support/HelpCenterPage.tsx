// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dirOf, type HelpArticleView, type HelpCenterInfo, type HelpHit, type HelpLocale, t } from '@bines/shared';
import { Button, EmptyState, Input, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { useDebounced } from '../../lib/use-debounced';
import { hasText, HitList } from './HelpPieces';
import { GuideView } from './GuideView';

/**
 * The public help center (stage 2): `/help` (and `/help?article=<slug>`), outside the app shell, no
 * sign-in. The platform's product name and the logo the owner set; categories, a Hebrew-aware search and the articles
 * marked "everyone" (a signed-in person also sees the ones for signed-in users).
 */
export const HelpCenterPage = ({
  article,
  locale = 'he',
  onArticle,
}: {
  article?: string;
  locale?: HelpLocale;
  /** Opens an article (or the index with null) — the route keeps it in the URL. */
  onArticle: (slug: string | null) => void;
}) => {
  const info = useQuery({
    queryKey: ['help-center', locale],
    queryFn: () => api().get<HelpCenterInfo>(`/help/center?locale=${locale}`),
  });
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const [category, setCategory] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['help-center', 'list', locale, query, category],
    queryFn: () => {
      const p = new URLSearchParams({ locale });
      if (query) p.set('q', query);
      else if (category) p.set('category_id', category);
      return api().get<{ data: HelpHit[] }>(`/help/articles?${p.toString()}`);
    },
    enabled: !article && (query.length >= 2 || !!category),
  });
  const view = useQuery({
    queryKey: ['help-center', 'article', locale, article],
    queryFn: () => api().get<HelpArticleView>(`/help/articles/${encodeURIComponent(article!)}?locale=${locale}`),
    enabled: !!article,
  });

  if (info.isError) return <Notice tone="error">{errorMessage(info.error)}</Notice>;
  const c = info.data;
  return (
    <div
      dir={dirOf(locale)}
      lang={locale}
      className="min-h-dvh bg-[var(--shell)] px-4 py-6 sm:py-12"
      data-testid="help-center-page"
    >
      <div className="mx-auto max-w-3xl space-y-4 rounded-[var(--radius-lg)] bg-surface p-5 shadow-sm">
        <header className="flex items-center gap-3">
          {c?.logo_url ? <img src={c.logo_url} alt="" className="h-8 w-auto" /> : null}
          <h1 className="font-display text-xl font-bold text-heading">
            {c ? t('help.center.title', { product: c.product_name }) : ''}
          </h1>
        </header>
        {article ? (
          <div className="space-y-3">
            <Button size="sm" variant="ghost" onClick={() => onArticle(null)} data-testid="help-center-back">
              <Icon name="back" size={14} />
              {t('help.back')}
            </Button>
            {view.isPending ? (
              <SkeletonRows rows={6} label={t('app.loading')} />
            ) : view.isError ? (
              <Notice tone="error">{errorMessage(view.error)}</Notice>
            ) : (
              <article className="space-y-3" data-testid="help-center-article">
                <h2 className="text-lg font-semibold text-fg" dir="auto">
                  {view.data.title}
                </h2>
                {/* A practical guide: its video and steps. */}
                {view.data.guide ? <GuideView guide={view.data.guide} /> : null}
                {view.data.guide && !hasText(view.data.html) ? null : (
                  <div
                    className="rich-content text-sm leading-relaxed text-fg"
                    dir="auto"
                    // Rendered on the server through the shared rich-text allowlist.
                    dangerouslySetInnerHTML={{ __html: view.data.html }}
                  />
                )}
                {view.data.translations.map((x) => (
                  <button
                    key={x.slug}
                    type="button"
                    className="text-sm text-link hover:underline"
                    onClick={() => onArticle(x.slug)}
                  >
                    {x.locale.toUpperCase()} · {x.title}
                  </button>
                ))}
              </article>
            )}
          </div>
        ) : (
          <>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('help.search')}
              aria-label={t('help.search')}
              data-testid="help-center-search"
            />
            {!query ? (
              <div className="flex flex-wrap gap-2" data-testid="help-center-categories">
                {(c?.categories ?? []).map((cat) => (
                  <Button
                    key={cat.id}
                    size="sm"
                    variant={category === cat.id ? 'accent' : 'secondary'}
                    onClick={() => setCategory(category === cat.id ? null : cat.id)}
                    data-testid="help-center-category"
                  >
                    {locale === 'en' && cat.name_en ? cat.name_en : cat.name}
                  </Button>
                ))}
              </div>
            ) : null}
            {list.isFetching ? (
              <SkeletonRows rows={3} label={t('app.loading')} />
            ) : list.data?.data.length ? (
              <HitList hits={list.data.data} onOpen={(h) => onArticle(h.slug)} testId="help-center-result" />
            ) : query.length >= 2 ? (
              <EmptyState className="py-6" title={t('help.noResults')} testId="help-center-empty" />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
};
