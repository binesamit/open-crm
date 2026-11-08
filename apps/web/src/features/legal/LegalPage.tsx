// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { dirOf, LANGUAGE_NAMES, type LegalDocView, type LegalLocale, type SubProcessorsList, t } from '@bines/shared';
import { EmptyState, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { useBranding } from '../../lib/branding';
import { legalHref, useLegalDocs, useLegalList } from './legal-links';

/** The page that lists the sub-processors (privacy) — not a document, a table from the owner's list. */
export const SUB_PROCESSORS_SLUG = 'sub-processors';

/**
 * The public legal pages: `/legal` (the list) and `/legal/<slug>`, outside the app shell, no sign-in.
 * The text is rendered on the server (raw HTML escaped, safe links only, the operator's details filled in).
 */
export const LegalPage = ({
  slug,
  locale = 'he',
  onLocale,
}: {
  slug?: string;
  locale?: LegalLocale;
  onLocale: (l: LegalLocale) => void;
}) => {
  const { productName } = useBranding();
  const list = useLegalDocs();
  const meta = useLegalList();
  const subs = slug === SUB_PROCESSORS_SLUG;
  const processors = useQuery({
    queryKey: ['legal', 'sub-processors'],
    queryFn: () => api().get<SubProcessorsList>('/legal/sub-processors'),
    enabled: subs,
    retry: false,
  });
  const view = useQuery({
    queryKey: ['legal', 'doc', slug, locale],
    queryFn: () => api().get<LegalDocView>(`/legal/${encodeURIComponent(slug!)}?locale=${locale}`),
    enabled: !!slug && !subs,
    retry: false,
  });
  const docs = view.data?.documents ?? list.data ?? [];
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'long' }).format(new Date(iso));

  return (
    <div
      dir={dirOf(locale)}
      lang={locale}
      className="min-h-dvh bg-[var(--shell)] px-4 py-6 sm:py-12"
      data-testid="legal-page"
    >
      <div className="mx-auto flex max-w-5xl gap-6 max-md:flex-col">
        <nav className="shrink-0 md:w-60" aria-label={t('legal.nav', undefined, locale)}>
          <div className="rounded-[var(--radius-lg)] bg-surface p-4 shadow-sm md:sticky md:top-6">
            <a href="/legal" className="mb-3 block font-display text-lg font-extrabold text-heading">
              {productName} · {t('legal.title', undefined, locale)}
            </a>
            <ul className="space-y-1 text-sm" data-testid="legal-nav">
              {docs.map((d) => (
                <li key={d.slug}>
                  <a
                    href={legalHref(d.slug, locale)}
                    aria-current={d.slug === slug ? 'page' : undefined}
                    className={`block rounded-md px-2 py-1.5 hover:bg-surface-3 ${
                      d.slug === slug ? 'bg-primary-soft font-bold text-primary' : 'text-fg-2'
                    }`}
                  >
                    {d.title[locale]}
                  </a>
                </li>
              ))}
            </ul>
            {meta.data?.sub_processors ? (
              <a
                href={legalHref(SUB_PROCESSORS_SLUG, locale)}
                aria-current={subs ? 'page' : undefined}
                className={`mt-1 block rounded-md px-2 py-1.5 text-sm hover:bg-surface-3 ${
                  subs ? 'bg-primary-soft font-bold text-primary' : 'text-fg-2'
                }`}
                data-testid="legal-nav-sub-processors"
              >
                {t('legal.subProcessors', undefined, locale)}
              </a>
            ) : null}
            {meta.data?.dpo ? (
              <p className="mt-3 border-t border-line pt-3 text-xs text-muted" data-testid="legal-dpo">
                {t('legal.dpo', { name: meta.data.dpo.name }, locale)}
                {meta.data.dpo.email ? (
                  <>
                    {' · '}
                    <a href={`mailto:${meta.data.dpo.email}`} dir="ltr" className="text-primary hover:underline">
                      {meta.data.dpo.email}
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2 border-t border-line pt-3 text-xs" data-testid="legal-locale">
              {(['he', 'en'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => onLocale(l)}
                  aria-pressed={l === locale}
                  className={`rounded-full px-2.5 py-1 ${l === locale ? 'bg-primary text-on-primary' : 'text-muted hover:bg-surface-3'}`}
                >
                  {l === 'he' ? LANGUAGE_NAMES.he : LANGUAGE_NAMES.en}
                </button>
              ))}
            </div>
          </div>
        </nav>
        <main className="min-w-0 flex-1 rounded-[var(--radius-lg)] bg-surface p-6 shadow-sm sm:p-10">
          {!slug ? (
            <>
              <h1 className="mb-4 font-display text-3xl font-extrabold text-heading">
                {t('legal.title', undefined, locale)}
              </h1>
              {list.isLoading ? (
                <SkeletonRows rows={4} label={t('legal.loading', undefined, locale)} />
              ) : docs.length ? (
                <ul className="grid gap-3 sm:grid-cols-2" data-testid="legal-index">
                  {docs.map((d) => (
                    <li key={d.slug}>
                      <a
                        href={legalHref(d.slug, locale)}
                        className="block rounded-[var(--radius)] border border-line p-4 hover:border-primary"
                      >
                        <span className="block font-bold text-heading">{d.title[locale]}</span>
                        <span className="text-xs text-muted">
                          {t('legal.updated', { date: date(d.published_at) }, locale)}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title={t('legal.none', undefined, locale)} />
              )}
            </>
          ) : subs ? (
            <article data-testid="legal-sub-processors">
              <h1 className="font-display text-3xl font-extrabold text-heading">
                {t('legal.subProcessors', undefined, locale)}
              </h1>
              <p className="mt-2 text-sm text-muted">{t('legal.subProcessors.intro', undefined, locale)}</p>
              {processors.isLoading ? (
                <SkeletonRows rows={4} label={t('legal.loading', undefined, locale)} />
              ) : processors.data?.data.length ? (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-start text-xs text-muted">
                        <th className="py-2 pe-3 text-start font-normal">
                          {t('legal.subProcessors.name', undefined, locale)}
                        </th>
                        <th className="py-2 pe-3 text-start font-normal">
                          {t('legal.subProcessors.purpose', undefined, locale)}
                        </th>
                        <th className="py-2 pe-3 text-start font-normal">
                          {t('legal.subProcessors.location', undefined, locale)}
                        </th>
                        <th className="py-2 text-start font-normal">
                          {t('legal.subProcessors.dpa', undefined, locale)}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {processors.data.data.map((p) => (
                        <tr key={p.name} className="border-b border-line-soft align-top">
                          <td className="py-2 pe-3" dir="auto">
                            {p.name}
                          </td>
                          <td className="py-2 pe-3">{p.purpose[locale]}</td>
                          <td className="py-2 pe-3" dir="auto">
                            {p.location}
                          </td>
                          <td className="py-2">
                            {p.dpa_url && /^https:\/\//.test(p.dpa_url) ? (
                              <a
                                href={p.dpa_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                              >
                                {t('legal.subProcessors.dpa', undefined, locale)}
                              </a>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title={t('legal.none', undefined, locale)} />
              )}
            </article>
          ) : view.isLoading ? (
            <SkeletonRows rows={8} label={t('legal.loading', undefined, locale)} />
          ) : view.isError ? (
            <Notice tone="error">{errorMessage(view.error)}</Notice>
          ) : view.data ? (
            <article data-testid="legal-doc">
              <h1 className="font-display text-3xl font-extrabold text-heading" data-testid="legal-doc-title">
                {view.data.title}
              </h1>
              <p className="mt-1 text-sm text-muted" data-testid="legal-doc-meta">
                {t('legal.updated', { date: date(view.data.published_at) }, locale)} ·{' '}
                {t('legal.version', { n: view.data.version }, locale)}
              </p>
              {view.data.headings.filter((h) => h.depth === 2).length > 3 ? (
                <ol
                  className="mt-5 list-inside list-decimal rounded-[var(--radius)] bg-surface-3 p-4 text-sm"
                  data-testid="legal-toc"
                >
                  {view.data.headings
                    .filter((h) => h.depth === 2)
                    .map((h) => (
                      <li key={h.id} className="list-none">
                        <a href={`#${h.id}`} className="text-primary hover:underline">
                          {h.text}
                        </a>
                      </li>
                    ))}
                </ol>
              ) : null}
              <div
                className="rich-content legal-content mt-6"
                // Rendered on the server: raw HTML escaped, links limited to safe targets.
                dangerouslySetInnerHTML={{ __html: view.data.html }}
              />
            </article>
          ) : null}
        </main>
      </div>
    </div>
  );
};
