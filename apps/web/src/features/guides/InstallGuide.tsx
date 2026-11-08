// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import {
  getLocale,
  type GuideLocale,
  type InstallGuide,
  type InstallGuideSection,
  isInstallGuideSection,
  t,
  LANGUAGE_NAMES,
} from '@bines/shared';
import { Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { DocReader } from '../docs/DocReader';

/**
 * The installation and licensing guide inside the app — the same text as the public pages at
 * /api/docs/guide[/he]: in the person's interface language with a switch to the other, a table of contents, search
 * and copy buttons on code. Shown from the help menu (`/a/<account>/guide`) and in the owner console (Guides), where
 * the license card links straight to a section (`section`, a key of INSTALL_GUIDE_SECTIONS, or a heading id).
 */
export const installGuideKey = (locale: GuideLocale) => ['guides', 'install', locale] as const;

export const useInstallGuide = (locale: GuideLocale) =>
  useQuery({
    queryKey: installGuideKey(locale),
    queryFn: () => api().get<InstallGuide>(`/guides/install?locale=${locale}`),
    staleTime: 5 * 60_000,
  });

/** The interface language, as a guide language. */
export const uiGuideLocale = (): GuideLocale => (getLocale() === 'en' ? 'en' : 'he');

/** The guide's public pages (apps/api install-guide.ts) → the language they are in. */
const PUBLIC_LOCALE: [string, GuideLocale][] = [
  ['/api/docs/guide/he', 'he'],
  ['/api/docs/guide', 'en'],
];

/** Where a link to the guide's public page points (its language and section), or null for any other link. */
export const guideLinkTarget = (href: string): { locale: GuideLocale; id: string | null } | null => {
  const [path, hash] = href.split('#', 2) as [string, string | undefined];
  const hit = PUBLIC_LOCALE.find(([p]) => p === path);
  return hit ? { locale: hit[1], id: hash ? decodeURIComponent(hash) : null } : null;
};

export const InstallGuideView = ({
  locale,
  onLocale,
  section,
  testId = 'install-guide',
}: {
  locale: GuideLocale;
  onLocale: (l: GuideLocale, section?: string) => void;
  /** A section key (`activate`, `renewal` …) or a heading id to scroll to. */
  section?: string | null;
  testId?: string;
}) => {
  const doc = useInstallGuide(locale);
  const anchor = section
    ? isInstallGuideSection(section)
      ? (doc.data?.sections[section as InstallGuideSection] ?? null)
      : section
    : null;
  return (
    <div className="space-y-4" data-testid={testId} data-locale={locale}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={t('guides.language')}
          value={locale}
          onChange={(l) => onLocale(l)}
          testId={`${testId}-lang`}
          options={[
            { value: 'he', label: LANGUAGE_NAMES.he, testId: `${testId}-lang-he` },
            { value: 'en', label: LANGUAGE_NAMES.en, testId: `${testId}-lang-en` },
          ]}
        />
        <span className="flex-1" />
        {doc.data ? (
          <a
            href={doc.data.public_path}
            target="_blank"
            rel="noreferrer"
            data-tip={t('guides.publicHint')}
            data-testid={`${testId}-public`}
            className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] text-heading hover:bg-surface-2"
          >
            {t('guides.public')}
            <Icon name="ext" size={14} />
          </a>
        ) : null}
      </div>
      {doc.isPending ? (
        <SkeletonRows rows={10} label={t('app.loading')} />
      ) : doc.isError ? (
        <Notice tone="error">{errorMessage(doc.error)}</Notice>
      ) : (
        <DocReader
          html={doc.data.html}
          headings={doc.data.headings}
          testId={testId}
          dir={locale === 'he' ? 'rtl' : 'ltr'}
          lang={locale}
          anchor={anchor}
          onLink={(href) => {
            // "Hebrew version" / "English version": the same reader in the other language.
            const target = guideLinkTarget(href);
            if (!target) return false;
            onLocale(target.locale, target.id ?? undefined);
            return true;
          }}
        />
      )}
    </div>
  );
};
