// SPDX-License-Identifier: AGPL-3.0-only
import type { Hono } from 'hono';
import {
  type GuideLocale,
  INSTALL_GUIDE_SECTIONS,
  type InstallGuide,
  markdownToDocHtml,
  type PlatformSettings,
} from '@bines/shared';
import type { AppDeps, AppEnv } from '../../types';
import { loadPlatformSettings } from '../platform/platform-settings';
import { escapeHtml, extDocsCss, proseName, tocOf } from './extension-docs';
import { GUIDE_DOCS_BASE, GUIDE_DOCS_CSS_PATH, GUIDE_DOCS_HE_PATH } from './extension-docs.csp';
import { INSTALL_GUIDE_EN_MD, INSTALL_GUIDE_HE_MD } from './install-guide.generated';

/**
 * The installation and licensing guide: `docs/GUIDE.md` at `/api/docs/guide` and `docs/GUIDE.he.md`
 * at `/api/docs/guide/he` — public (no sign-in), so whoever installs the platform can read it on any deployment —
 * and the same text in the app (GET /guides/install, rendered in the app's shell). Bundled into the build
 * (`install-guide.generated.ts`), rendered on the server with no script on the page, white-labelled like the
 * extension docs (the owner's product name in prose).
 */
export type GuideBrand = { productName: string; logoUrl?: string };

export const guidePublicPath = (locale: GuideLocale) => (locale === 'he' ? GUIDE_DOCS_HE_PATH : GUIDE_DOCS_BASE);

/** Links between the two languages; anchors and web links stay; other repository files become plain text. */
export const guideDocLink = (href: string): string | null => {
  const m = /^(?:\.\/)?GUIDE(\.he)?\.md(#.*)?$/.exec(href);
  if (m) return `${guidePublicPath(m[1] ? 'he' : 'en')}${m[2] ?? ''}`;
  if (/^(https?:\/\/|mailto:|#)/i.test(href)) return href;
  return null;
};

const markdownOf = (locale: GuideLocale) => (locale === 'he' ? INSTALL_GUIDE_HE_MD : INSTALL_GUIDE_EN_MD);

const render = (locale: GuideLocale, b: GuideBrand) =>
  markdownToDocHtml(markdownOf(locale), { linkFor: guideDocLink, text: proseName(b) });

/** Section key → the id of the section heading in this language (the one that starts with the section's number). */
export const guideSections = (headings: { depth: number; id: string }[]) => {
  const out: Record<string, string> = {};
  for (const [key, n] of Object.entries(INSTALL_GUIDE_SECTIONS)) {
    const h = headings.find((x) => x.depth === 2 && x.id.startsWith(`${n}-`));
    if (h) out[key] = h.id;
  }
  return out;
};

/** The guide's body for the app: the rendered HTML, its title, headings, sections and public address. */
export const renderInstallGuideBody = (locale: GuideLocale, b: GuideBrand): Omit<InstallGuide, 'product_name'> => {
  const doc = render(locale, b);
  return {
    locale,
    title: doc.title,
    html: doc.html,
    headings: doc.headings,
    sections: guideSections(doc.headings),
    public_path: guidePublicPath(locale),
  };
};

const LANGS: { locale: GuideLocale; label: string }[] = [
  { locale: 'he', label: 'עברית' },
  { locale: 'en', label: 'English' },
];

export const renderGuidePage = (locale: GuideLocale, b: GuideBrand): string => {
  const doc = render(locale, b);
  const nav = LANGS.map(
    (l) =>
      `<a href="${guidePublicPath(l.locale)}" hreflang="${l.locale}"${
        l.locale === locale ? ' aria-current="page"' : ''
      }>${escapeHtml(l.label)}</a>`,
  ).join('');
  const logo = b.logoUrl ? `<img src="${escapeHtml(b.logoUrl)}" alt="" class="logo" />` : '';
  const description =
    locale === 'he'
      ? `התקנה, רישוי ושאלות נפוצות של ${b.productName}.`
      : `Installing and licensing ${b.productName}, and the usual questions.`;
  return `<!doctype html>
<html lang="${locale}" dir="${locale === 'he' ? 'rtl' : 'ltr'}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(doc.title)} · ${escapeHtml(b.productName)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    ${b.logoUrl ? `<link rel="icon" href="${escapeHtml(b.logoUrl)}" />` : ''}
    <link rel="alternate" hreflang="${locale === 'he' ? 'en' : 'he'}" href="${guidePublicPath(locale === 'he' ? 'en' : 'he')}" />
    <link rel="stylesheet" href="${GUIDE_DOCS_CSS_PATH}" />
  </head>
  <body>
    <header class="top">
      <span class="brand">${logo}${escapeHtml(b.productName)}</span>
      <nav>${nav}</nav>
    </header>
    <div class="wrap">
      ${tocOf(doc.headings)}
      <main class="doc" data-testid="install-guide">${doc.html}</main>
    </div>
  </body>
</html>`;
};

export const mountInstallGuide = (
  app: Hono<AppEnv>,
  deps: Pick<AppDeps, 'db' | 'env'>,
  brandOf: (settings: PlatformSettings) => { productName: string; logoUrl?: string; brandColor?: string },
) => {
  const cache = deps.env.NODE_ENV === 'production' ? 'public, max-age=300' : 'no-cache';
  // Rendered once per language and brand (Platform settings are cached ~30 s in this process).
  const pages = new Map<string, string>();
  for (const locale of ['en', 'he'] as const)
    app.get(guidePublicPath(locale), async (c) => {
      const brand = brandOf(await loadPlatformSettings(deps.db));
      const b: GuideBrand = { productName: brand.productName, logoUrl: brand.logoUrl };
      const key = JSON.stringify([locale, b]);
      let html = pages.get(key);
      if (html === undefined) {
        html = renderGuidePage(locale, b);
        if (pages.size > 20) pages.clear();
        pages.set(key, html);
      }
      c.header('Cache-Control', cache);
      return c.html(html);
    });
  app.get(GUIDE_DOCS_CSS_PATH, async (c) => {
    const brand = brandOf(await loadPlatformSettings(deps.db));
    c.header('Cache-Control', cache);
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(extDocsCss(brand.brandColor));
  });
};
