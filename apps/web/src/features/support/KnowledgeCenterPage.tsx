// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { HelpCategory, HelpHit, HelpLocale, MyAccount } from '@bines/shared';
import { Button, EmptyState, Input, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { useHelpArticle, useHelpCategory, useHelpGuides, useHelpOptions, useHelpSearch } from './help-api';
import { clock } from './GuideView';
import { ArticleView, AssistantStep, HitList } from './HelpPieces';
import { categoryIcon, categoryLabel, relatedOf, useHelpAccess, visibleCategories, type KbSearch } from './kb-page';
import { NewTicketDialog } from './NewTicketDialog';
import { t } from '@bines/shared';
import { useDebounced } from '../../lib/use-debounced';

/**
 * The knowledge center inside the app (`/a/<slug>/help`): a page of its own — not only the "?"
 * panel before a ticket. A search (with the help assistant when it is available), the categories as cards with how
 * many articles each holds, a category's articles, an article with "did this help?" and "see also", and "open a
 * ticket" at the bottom for whoever may open one. The account's endpoints, so a member also reads the articles for
 * signed-in users. When the platform turned the help center off, it says so (and still offers the ticket).
 */
export const KnowledgeCenterPage = ({
  account,
  search,
  onNavigate,
}: {
  account: MyAccount;
  search: KbSearch;
  /** Another view of the page (the route keeps it in the URL); `{}` = the index. */
  onNavigate: (next: KbSearch) => void;
}) => {
  const access = useHelpAccess(account);
  // The "?" menu keeps the categories for a minute; opening the page itself fetches them again, so an article
  // published since then (and its category's card) is there.
  const options = useHelpOptions(account.id, !access.hidden, 0);
  const o = options.data;
  const locale: HelpLocale | undefined = o?.locale;
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const searching = query.length >= 2;
  const [ticket, setTicket] = useState<false | { subject: string; description: string }>(false);
  const [notHelpful, setNotHelpful] = useState(false);
  const go = (next: KbSearch) => {
    setQ('');
    setNotHelpful(false);
    onNavigate(next);
  };

  const categories = o?.categories ?? [];
  const categoryOf = (id: string | null | undefined) => categories.find((c) => c.id === id);
  const subject = searching ? query : '';

  let body: ReactNode;
  if (options.isPending) body = <SkeletonRows rows={5} label={t('app.loading')} />;
  else if (options.isError) body = <Notice tone="error">{errorMessage(options.error)}</Notice>;
  else if (!o?.enabled)
    body = (
      <EmptyState icon={<Icon name="book" size={28} />} title={t('kb.off.title')} testId="kb-off">
        {t('kb.off.text')}
      </EmptyState>
    );
  else if (searching)
    body = (
      <SearchResults
        account={account}
        query={query}
        onOpen={(id) => go({ article: id })}
        assistant={
          <AssistantStep
            accountId={account.id}
            options={o}
            question={query}
            onOpenArticle={(id) => go({ article: id })}
          />
        }
      />
    );
  else if (search.article)
    body = (
      <ArticlePane
        key={search.article}
        account={account}
        article={search.article}
        category={categoryOf(search.category)?.id}
        categoryOf={categoryOf}
        locale={locale}
        onNavigate={go}
        onNotHelpful={() => setNotHelpful(true)}
      />
    );
  else if (search.category && categoryOf(search.category))
    body = (
      <CategoryPane
        account={account}
        category={categoryOf(search.category)!}
        count={o.category_counts?.[search.category] ?? 0}
        locale={locale}
        onNavigate={go}
      />
    );
  else
    body = (
      <>
        <GuideRow account={account} onOpen={(slug) => go({ article: slug })} />
        <CategoryGrid
          categories={visibleCategories(categories, o.category_counts)}
          counts={o.category_counts ?? {}}
          locale={locale}
          onOpen={(id) => go({ category: id })}
        />
      </>
    );

  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="kb-page" data-view={pageView(search, searching)}>
      <div className="mx-auto max-w-4xl space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="font-display text-[1.625rem] leading-tight font-extrabold text-heading">{t('kb.title')}</h1>
            <p className="text-sm text-muted">{t('kb.subtitle')}</p>
          </div>
          {access.tickets.data?.enabled ? (
            <Link
              to={'/a/$accountSlug/support' as never}
              params={{ accountSlug: account.slug } as never}
              data-testid="kb-my-tickets"
              className="inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[0.8125rem] text-fg-2 hover:bg-surface-2"
            >
              <Icon name="inbox" size={15} />
              {t('tickets.menu.mine')}
            </Link>
          ) : null}
        </header>

        {o?.enabled ? (
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-muted">
              <Icon name="search" size={17} />
            </span>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('help.search')}
              aria-label={t('help.search')}
              className="h-11 ps-10 text-[0.9375rem]"
              data-testid="kb-search"
            />
          </div>
        ) : null}

        {body}

        {access.mayOpen ? (
          <section
            data-testid="kb-cta"
            className="flex flex-col gap-3 rounded-[16px] border border-line bg-surface-2 p-4 sm:flex-row sm:items-center"
          >
            <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-surface text-heading">
              <Icon name="chat" size={20} />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-display font-bold text-heading">
                {notHelpful ? t('kb.cta.sorry') : t('kb.cta.title')}
              </p>
              <p className="text-sm text-muted">{t('kb.cta.text')}</p>
            </div>
            <Button
              variant="accent"
              className="w-full sm:w-auto"
              onClick={() => setTicket({ subject: subject.slice(0, 200), description: subject })}
              data-testid="kb-open-ticket"
            >
              <Icon name="chat" size={14} />
              {t('kb.cta.open')}
            </Button>
          </section>
        ) : null}
      </div>
      {ticket ? (
        <NewTicketDialog
          account={account}
          initialSubject={ticket.subject}
          initialDescription={ticket.description}
          onClose={() => setTicket(false)}
        />
      ) : null}
    </main>
  );
};

const pageView = (s: KbSearch, searching: boolean) =>
  searching ? 'search' : s.article ? 'article' : s.category ? 'category' : 'index';

/** A category's mark: the app's icon by name, the writer's emoji / letter, else a book. */
const CategoryMark = ({ icon, size = 44 }: { icon: string | null; size?: number }) => {
  const mark = categoryIcon(icon);
  return (
    <span
      aria-hidden
      style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }}
      className="grid shrink-0 place-items-center rounded-[12px] bg-[var(--accent-soft)] text-heading"
    >
      {mark?.kind === 'text' ? (
        <span className="text-lg leading-none">{mark.text}</span>
      ) : (
        <Icon name={mark?.kind === 'icon' ? mark.name : 'book'} size={Math.round(size * 0.45)} />
      )}
    </span>
  );
};

const countLabel = (n: number) => (n === 1 ? t('kb.articleCount.one') : t('kb.articleCount', { count: n }));

/**
 * "Practical guides" (canvas ב2): the published guides as video cards — the still, its length, the
 * title and how many steps — above the categories. Hidden while there are none.
 */
const GuideRow = ({ account, onOpen }: { account: MyAccount; onOpen: (slug: string) => void }) => {
  const guides = useHelpGuides(account.id);
  const list = guides.data?.data ?? [];
  if (!list.length) return null;
  return (
    <section className="space-y-2.5" data-testid="kb-guides" aria-labelledby="kb-guides-title">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 id="kb-guides-title" className="font-display text-lg font-extrabold text-heading">
          {t('guide.row.title')}
        </h2>
        <span className="text-[0.8125rem] text-muted">{t('guide.row.hint')}</span>
      </div>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {list.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => onOpen(g.slug)}
              data-testid="kb-guide"
              data-id={g.id}
              className="flex h-full w-full flex-col overflow-hidden rounded-[12px] border border-line bg-surface text-start hover:border-line-strong focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
            >
              <span className="relative block aspect-video bg-[var(--shell)]">
                {g.poster ? <img src={g.poster} alt="" className="size-full object-cover" loading="lazy" /> : null}
                <span
                  aria-hidden
                  className="absolute top-1/2 left-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--accent)] text-[#13221f]"
                >
                  <Icon name="play" size={14} />
                </span>
                {g.duration ? (
                  <span
                    className="absolute bottom-1.5 left-2 rounded-[4px] bg-[rgba(7,36,32,0.85)] px-1.5 py-0.5 text-[0.6875rem] text-white tabular-nums"
                    dir="ltr"
                  >
                    {clock(g.duration)}
                  </span>
                ) : null}
              </span>
              <span className="flex flex-col gap-0.5 px-3 pt-2.5 pb-3">
                <span className="text-sm leading-snug text-fg" dir="auto">
                  {g.title}
                </span>
                {g.step_count ? (
                  <span className="text-xs text-muted">
                    {g.step_count === 1 ? t('guide.meta.step') : t('guide.meta.steps', { n: g.step_count })}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};

const CategoryGrid = ({
  categories,
  counts,
  locale,
  onOpen,
}: {
  categories: HelpCategory[];
  counts: Record<string, number>;
  locale: HelpLocale | undefined;
  onOpen: (id: string) => void;
}) =>
  categories.length ? (
    <section className="space-y-2.5">
      <h2 className="text-xs font-semibold text-fg-2">{t('kb.categories')}</h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="kb-categories">
        {categories.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onOpen(c.id)}
              data-testid="kb-category"
              data-id={c.id}
              data-count={counts[c.id] ?? 0}
              className="flex h-full w-full items-center gap-3 rounded-[14px] border border-line bg-surface p-3.5 text-start hover:border-line-strong hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
            >
              <CategoryMark icon={c.icon} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-fg" dir="auto">
                  {categoryLabel(c, locale)}
                </span>
                <span className="block text-xs text-muted">{countLabel(counts[c.id] ?? 0)}</span>
              </span>
              <Icon name="chevronEnd" size={16} className="shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  ) : (
    <EmptyState icon={<Icon name="book" size={28} />} title={t('kb.empty')} testId="kb-empty">
      {t('kb.emptyHint')}
    </EmptyState>
  );

/** A list of articles on the page: the shared rows, in a card. */
const ArticleList = ({ hits, onOpen, testId }: { hits: HelpHit[]; onOpen: (hit: HelpHit) => void; testId: string }) => (
  <div className="rounded-[14px] border border-line bg-surface p-1.5">
    <HitList hits={hits} onOpen={onOpen} testId={testId} />
  </div>
);

/** "מרכז המידע › <category>": back to the index or to the category. */
const Crumbs = ({
  category,
  locale,
  onNavigate,
}: {
  category?: HelpCategory;
  locale: HelpLocale | undefined;
  onNavigate: (next: KbSearch) => void;
}) => (
  <nav aria-label={t('kb.title')} className="flex flex-wrap items-center gap-1 text-sm" data-testid="kb-crumbs">
    <button
      type="button"
      onClick={() => onNavigate({})}
      className="rounded-[8px] px-1.5 py-0.5 text-link hover:bg-surface-2"
      data-testid="kb-crumb-home"
    >
      {t('kb.title')}
    </button>
    {category ? (
      <>
        <Icon name="chevronEnd" size={14} className="shrink-0 text-muted" />
        <button
          type="button"
          onClick={() => onNavigate({ category: category.id })}
          className="rounded-[8px] px-1.5 py-0.5 text-link hover:bg-surface-2"
          data-testid="kb-crumb-category"
          dir="auto"
        >
          {categoryLabel(category, locale)}
        </button>
      </>
    ) : null}
  </nav>
);

const CategoryPane = ({
  account,
  category,
  count,
  locale,
  onNavigate,
}: {
  account: MyAccount;
  category: HelpCategory;
  count: number;
  locale: HelpLocale | undefined;
  onNavigate: (next: KbSearch) => void;
}) => {
  const list = useHelpCategory(account.id, category.id);
  const hits = list.data?.data ?? [];
  return (
    <section className="space-y-3" data-testid="kb-category-view" data-id={category.id}>
      <Crumbs locale={locale} onNavigate={onNavigate} />
      <div className="flex items-center gap-3">
        <CategoryMark icon={category.icon} size={40} />
        <div className="min-w-0">
          <h2 className="truncate font-display text-xl font-extrabold text-heading" dir="auto">
            {categoryLabel(category, locale)}
          </h2>
          <p className="text-xs text-muted">{countLabel(count)}</p>
        </div>
      </div>
      {list.isPending ? (
        <SkeletonRows rows={4} label={t('app.loading')} />
      ) : list.isError ? (
        <Notice tone="error">{errorMessage(list.error)}</Notice>
      ) : hits.length ? (
        <ArticleList
          hits={hits}
          testId="kb-article-row"
          onOpen={(h) => onNavigate({ article: h.slug, category: category.id })}
        />
      ) : (
        <EmptyState className="py-8" title={t('kb.categoryEmpty')} testId="kb-category-empty" />
      )}
    </section>
  );
};

const ArticlePane = ({
  account,
  article,
  category,
  categoryOf,
  locale,
  onNavigate,
  onNotHelpful,
}: {
  account: MyAccount;
  article: string;
  /** The category it was opened from (the URL), else the article's own. */
  category: string | undefined;
  categoryOf: (id: string | null | undefined) => HelpCategory | undefined;
  locale: HelpLocale | undefined;
  onNavigate: (next: KbSearch) => void;
  onNotHelpful: () => void;
}) => {
  // The same query as <ArticleView> (one request): the article's category for the crumbs and "see also".
  const view = useHelpArticle(account.id, article);
  const cat = categoryOf(category ?? view.data?.category_id);
  const siblings = useHelpCategory(account.id, cat?.id ?? null);
  const related = relatedOf(siblings.data?.data ?? [], { id: view.data?.id, slug: article });
  return (
    <div className="space-y-4" data-testid="kb-article-view">
      <Crumbs category={cat} locale={locale} onNavigate={onNavigate} />
      <div className="rounded-[16px] border border-line bg-surface p-4 md:p-6">
        <ArticleView
          accountId={account.id}
          id={article}
          variant="page"
          onOpen={(slug) => onNavigate({ article: slug, ...(cat ? { category: cat.id } : {}) })}
          onNotHelpful={onNotHelpful}
        />
      </div>
      {related.length ? (
        <section className="space-y-2" data-testid="kb-related">
          <h2 className="text-xs font-semibold text-fg-2">{t('kb.related')}</h2>
          <ArticleList
            hits={related}
            testId="kb-related-row"
            onOpen={(h) => onNavigate({ article: h.slug, ...(cat ? { category: cat.id } : {}) })}
          />
        </section>
      ) : null}
    </div>
  );
};

const SearchResults = ({
  account,
  query,
  onOpen,
  assistant,
}: {
  account: MyAccount;
  query: string;
  onOpen: (id: string) => void;
  assistant: ReactNode;
}) => {
  const results = useHelpSearch(account.id, query, { mode: 'search' });
  const hits = results.data?.data ?? [];
  return (
    <section className="space-y-3" data-testid="kb-results">
      <h2 className="text-xs font-semibold text-fg-2">{t('help.results')}</h2>
      {results.isPending ? (
        <SkeletonRows rows={3} label={t('app.loading')} />
      ) : results.isError ? (
        <Notice tone="error">{errorMessage(results.error)}</Notice>
      ) : hits.length ? (
        <ArticleList hits={hits} testId="kb-result" onOpen={(h) => onOpen(h.slug)} />
      ) : (
        <EmptyState className="py-8" testId="kb-no-results" title={t('help.noResults')}>
          {t('help.noResultsHint')}
        </EmptyState>
      )}
      {assistant}
    </section>
  );
};
