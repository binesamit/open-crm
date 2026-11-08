// SPDX-License-Identifier: AGPL-3.0-only
import { type GuideLocale, t } from '@bines/shared';
import { InstallGuideView, uiGuideLocale } from './InstallGuide';

/**
 * The installation and licensing guide in the account's shell: help menu → "Installation & licensing
 * guide". `/a/<account>/guide?locale=en&section=activate` — the language and the section are in the address.
 */
export const GuidePage = ({
  locale,
  section,
  onChange,
}: {
  locale?: GuideLocale;
  section?: string;
  onChange: (next: { locale: GuideLocale; section?: string }) => void;
}) => (
  <main className="w-full px-4 py-5 md:px-6" data-testid="guide-page">
    <div className="mx-auto max-w-[1180px] space-y-4">
      <header className="space-y-1">
        <h1 className="font-display text-[1.625rem] leading-tight font-extrabold text-heading">
          {t('guides.install.title')}
        </h1>
        <p className="max-w-[640px] text-sm text-muted">{t('guides.install.subtitle')}</p>
      </header>
      <InstallGuideView
        locale={locale ?? uiGuideLocale()}
        section={section}
        onLocale={(l, s) => onChange({ locale: l, section: s })}
      />
    </div>
  </main>
);
