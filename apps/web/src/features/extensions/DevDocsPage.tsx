// SPDX-License-Identifier: AGPL-3.0-only
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { t, type ExtensionDocPage, type ExtensionDocPageKey, type MyAccount, tDynamic } from '@bines/shared';
import { cn, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { DocReader } from '../docs/DocReader';
import { docLinkTarget } from './dev-docs';

const PAGES: { page: ExtensionDocPageKey; label: string; testId: string }[] = [
  { page: 'guide', label: 's37market.docs.guide', testId: 'dev-docs-tab-guide' },
  { page: 'quickstart', label: 's37market.docs.quickstart', testId: 'dev-docs-tab-quickstart' },
];

export const useExtensionDoc = (accountId: string, page: ExtensionDocPageKey) =>
  useQuery({
    queryKey: ['account', accountId, 'extensions', 'docs', page] as const,
    queryFn: () => api(accountId).get<ExtensionDocPage>(`/extensions/docs/${page}`),
    staleTime: 5 * 60_000,
  });

/**
 * s37market — the extension developer guide inside the app (Administration → Extensions → For developers): the same
 * guide and quickstart as the public pages at /api/docs/extensions, in the app shell, with a table of contents,
 * search within the page and copy buttons on code. The guide is English: its content is `dir="ltr"` in an RTL app.
 */
export const DevDocsPage = ({ account, page }: { account: MyAccount; page: ExtensionDocPageKey }) => {
  const doc = useExtensionDoc(account.id, page);
  const navigate = useNavigate();
  const location = useLocation();

  // A link to the other page keeps the reader in the app (a section of it in the address).
  const onLink = (href: string) => {
    const target = docLinkTarget(href);
    if (target.kind !== 'page') return false;
    void navigate({
      to: '/a/$accountSlug/admin/extensions/docs/$doc',
      params: { accountSlug: account.slug, doc: target.page },
      hash: target.id ?? undefined,
    });
    return true;
  };

  return (
    <div className="space-y-4" data-testid="dev-docs" data-page={page}>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/a/$accountSlug/admin/$section"
          params={{ accountSlug: account.slug, section: 'extensions' }}
          data-testid="dev-docs-back"
          className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2 text-[0.8125rem] text-fg-2 hover:bg-surface-2 hover:text-fg"
        >
          <Icon name="back" size={14} />
          {t('s37market.docs.back')}
        </Link>
        <nav className="flex gap-1" aria-label={t('s37market.docs.title')}>
          {PAGES.map((p) => (
            <Link
              key={p.page}
              to="/a/$accountSlug/admin/extensions/docs/$doc"
              params={{ accountSlug: account.slug, doc: p.page }}
              aria-current={p.page === page ? 'page' : undefined}
              data-testid={p.testId}
              className={cn(
                'press inline-flex h-8 items-center rounded-[10px] px-3 text-[0.8125rem] font-semibold text-fg-2 hover:bg-surface-2',
                p.page === page && 'bg-primary-soft text-heading hover:bg-primary-soft',
              )}
            >
              {tDynamic(p.label)}
            </Link>
          ))}
        </nav>
        <span className="flex-1" />
        {doc.data ? (
          <a
            href={doc.data.public_path}
            target="_blank"
            rel="noreferrer"
            data-tip={t('s37market.docs.publicHint')}
            data-testid="dev-docs-public"
            className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] text-heading hover:bg-surface-2"
          >
            {t('s37market.docs.public')}
            <Icon name="ext" size={14} />
          </a>
        ) : null}
      </div>

      {doc.isPending ? (
        <SkeletonRows rows={10} label={t('app.loading')} />
      ) : doc.isError ? (
        <Notice tone="error">{errorMessage(doc.error)}</Notice>
      ) : (
        // English content in a Hebrew app: the whole guide (and its contents list) reads left to right.
        <DocReader
          html={doc.data.html}
          headings={doc.data.headings}
          testId="dev-docs"
          dir="ltr"
          lang="en"
          anchor={location.hash ? decodeURIComponent(location.hash) : null}
          onLink={onLink}
        />
      )}
    </div>
  );
};
