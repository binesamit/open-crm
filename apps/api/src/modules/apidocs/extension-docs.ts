// SPDX-License-Identifier: AGPL-3.0-only
import type { Hono } from 'hono';
import { markdownToDocHtml, type PlatformSettings, resolvePublicAddress } from '@bines/shared';
import type { AppDeps, AppEnv } from '../../types';
import { loadPlatformSettings } from '../platform/platform-settings';
import { EXTENSION_GUIDE_MD, EXTENSION_QUICKSTART_MD } from './extension-docs.generated';
import { F4 } from './theme';
import { EXT_DOCS_BASE, EXT_DOCS_CSS_PATH, EXT_QUICKSTART_PATH } from './extension-docs.csp';

export { EXT_DOCS_BASE, EXT_DOCS_CSP, EXT_DOCS_CSS_PATH, EXT_QUICKSTART_PATH } from './extension-docs.csp';

/**
 * The extension developer guide on the public docs site (s37docs): `docs/extensions/README.md` at
 * `/api/docs/extensions` and `QUICKSTART.md` at `/api/docs/extensions/quickstart`, so outside developers can read them
 * on any deployment without access to the repository. The Markdown is bundled into the build
 * (`extension-docs.generated.ts`), rendered on the server (no script on the page) and white-labelled like the API
 * reference: the product name and the deployment's origin replace the guide's own ("Bines OS",
 * `https://bines.example.com`).
 */
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Links between the two pages; anchors and web links stay; repository paths become plain text. */
export const extDocLink = (href: string): string | null => {
  const m = /^(?:\.\/)?(README|QUICKSTART)\.md(#.*)?$/.exec(href);
  if (m) return `${m[1] === 'README' ? EXT_DOCS_BASE : EXT_QUICKSTART_PATH}${m[2] ?? ''}`;
  if (/^(https?:\/\/|mailto:|#)/i.test(href)) return href;
  return null;
};

export type ExtDocsBrand = { productName: string; origin: string; logoUrl?: string };

/** The guide's sample names → this deployment's (code too: the examples are then copy-paste ready). */
const localize = (md: string, b: ExtDocsBrand) =>
  md.replace(/https:\/\/(your-)?bines\.example\.com/g, b.origin).replace(/<(your )?Bines origin>/g, b.origin);

export const proseName = (b: Pick<ExtDocsBrand, 'productName'>) => (s: string) =>
  // One pass: a second pass would rename the "Bines" inside a product name that contains it.
  s.replace(/Bines OS|(?<![-@\w/.])Bines(?![-\w.])/g, b.productName);

const PAGES = [
  { path: EXT_DOCS_BASE, label: 'Extensions developer guide', md: () => EXTENSION_GUIDE_MD },
  { path: EXT_QUICKSTART_PATH, label: 'Quickstart', md: () => EXTENSION_QUICKSTART_MD },
] as const;

export const renderExtDocPage = (path: string, b: ExtDocsBrand): string | null => {
  const page = PAGES.find((p) => p.path === path);
  if (!page) return null;
  const doc = markdownToDocHtml(localize(page.md(), b), { linkFor: extDocLink, text: proseName(b) });
  const toc = tocOf(doc.headings);
  const nav = [
    `<a href="/api/docs">API reference</a>`,
    ...PAGES.map(
      (p) => `<a href="${p.path}"${p.path === path ? ' aria-current="page"' : ''}>${escapeHtml(p.label)}</a>`,
    ),
  ].join('');
  const logo = b.logoUrl ? `<img src="${escapeHtml(b.logoUrl)}" alt="" class="logo" />` : '';
  return `<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(doc.title || page.label)} · ${escapeHtml(b.productName)}</title>
    <meta name="description" content="${escapeHtml(`How to build extensions for ${b.productName}.`)}" />
    ${b.logoUrl ? `<link rel="icon" href="${escapeHtml(b.logoUrl)}" />` : ''}
    <link rel="stylesheet" href="${EXT_DOCS_CSS_PATH}" />
  </head>
  <body>
    <header class="top">
      <span class="brand">${logo}${escapeHtml(b.productName)} developers</span>
      <nav>${nav}</nav>
    </header>
    <div class="wrap">
      ${toc}
      <main class="doc" data-testid="ext-docs">${doc.html}</main>
    </div>
  </body>
</html>`;
};

/**
 * s37market: the same page for the in-app developer area (GET /extensions/docs/{page}) — the rendered body, its title
 * and headings (the app draws its own table of contents, search and copy buttons). Links between the two pages keep
 * their public paths; the app maps them to its own route.
 */
export const renderExtDocBody = (page: 'guide' | 'quickstart', b: ExtDocsBrand) => {
  const p = PAGES[page === 'guide' ? 0 : 1];
  const doc = markdownToDocHtml(localize(p.md(), b), { linkFor: extDocLink, text: proseName(b) });
  return { page, title: doc.title || p.label, html: doc.html, headings: doc.headings, public_path: p.path };
};

/** The page's sections as a side list (hidden on narrow screens). */
export const tocOf = (headings: { depth: number; id: string; text: string }[]) => {
  const items = headings.filter((h) => h.depth === 2);
  if (!items.length) return '';
  return `<aside class="toc"><ol>${items
    .map((h) => `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`)
    .join('')}</ol></aside>`;
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export const extDocsCss = (brand?: string) => {
  const l = F4.light;
  const d = F4.dark;
  const shell = brand && HEX.test(brand) ? brand : l.shell;
  return `:root { color-scheme: light dark; --shell: ${shell}; --bg: ${l.surface}; --bg2: ${l.surface2}; --fg: ${l.fg};
  --fg2: ${l.fg2}; --muted: ${l.muted}; --line: ${l.line}; --heading: ${l.heading}; --link: ${l.info}; }
@media (prefers-color-scheme: dark) {
  :root { --shell: ${brand && HEX.test(brand) ? brand : d.shell}; --bg: ${d.surface}; --bg2: ${d.surface3}; --fg: ${d.fg};
    --fg2: ${d.fg2}; --muted: ${d.muted}; --line: ${d.line}; --heading: ${d.heading}; --link: ${d.infoFg}; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 ${F4.fontBody}; }
.top { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px;
  padding: 10px 24px; background: var(--shell); color: #fff; }
.brand { display: inline-flex; align-items: center; gap: 8px; font: 800 16px/1.2 ${F4.fontDisplay}; }
.logo { height: 22px; width: auto; }
.top nav { display: flex; flex-wrap: wrap; gap: 4px; }
.top nav a { color: ${l.shellFg}; text-decoration: none; padding: 4px 10px; border-radius: ${F4.radiusSm}; }
.top nav a:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.top nav a[aria-current='page'] { background: rgba(255, 255, 255, 0.16); color: #fff; }
.wrap { display: flex; gap: 32px; max-width: 1180px; margin: 0 auto; padding: 24px 16px 64px; }
.toc { flex: 0 0 220px; position: sticky; top: 64px; align-self: flex-start; font-size: 14px; }
.toc ol { margin: 0; padding-inline-start: 18px; }
.toc a { color: var(--fg2); text-decoration: none; }
.toc a:hover { color: var(--link); }
.doc { flex: 1; min-width: 0; max-width: 900px; }
.doc h1, .doc h2, .doc h3 { font-family: ${F4.fontDisplay}; color: var(--heading); line-height: 1.25; scroll-margin-top: 64px; }
.doc h1 { font-size: 30px; font-weight: 800; }
.doc h2 { font-size: 22px; font-weight: 800; margin-top: 2em; padding-top: 0.6em; border-top: 1px solid var(--line); }
.doc h3 { font-size: 17px; margin-top: 1.6em; }
.doc a { color: var(--link); }
.doc code { font-family: ${F4.fontMono}; font-size: 0.88em; background: var(--bg2); padding: 1px 5px; border-radius: 5px; }
.doc pre { background: var(--bg2); border: 1px solid var(--line); border-radius: ${F4.radius}; padding: 12px 14px; overflow-x: auto; }
.doc pre code { background: none; padding: 0; font-size: 13px; line-height: 1.5; }
.doc table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 14px; margin: 1em 0; }
.doc th, .doc td { border: 1px solid var(--line); padding: 6px 10px; text-align: start; vertical-align: top; }
.doc th { background: var(--bg2); }
.doc blockquote { margin: 1em 0; padding: 4px 16px; border-inline-start: 3px solid var(--shell); color: var(--fg2); }
/* A right-to-left page (the Hebrew installation guide): code still reads left to right. */
.doc pre { direction: ltr; text-align: left; }
.doc hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
@media (max-width: 860px) { .toc { display: none; } .top { padding: 10px 16px; } }
`;
};

export const mountExtensionDocs = (
  app: Hono<AppEnv>,
  deps: Pick<AppDeps, 'db' | 'env'>,
  brandOf: (settings: PlatformSettings) => { productName: string; logoUrl?: string; brandColor?: string },
) => {
  const { env } = deps;
  const cache = env.NODE_ENV === 'production' ? 'public, max-age=300' : 'no-cache';
  // Rendered once per brand (Platform settings are cached ~30 s in this process).
  const pages = new Map<string, string>();
  for (const page of PAGES)
    app.get(page.path, async (c) => {
      const settings = await loadPlatformSettings(deps.db);
      const brand = brandOf(settings);
      // The API's public address (owner console, M11; else WEB_ORIGIN) — part of the cache key below.
      const origin = resolvePublicAddress(settings.public_address, env).api;
      const b: ExtDocsBrand = { productName: brand.productName, origin, logoUrl: brand.logoUrl };
      const key = JSON.stringify([page.path, b]);
      let html = pages.get(key);
      if (html === undefined) {
        html = renderExtDocPage(page.path, b)!;
        if (pages.size > 20) pages.clear();
        pages.set(key, html);
      }
      c.header('Cache-Control', cache);
      return c.html(html);
    });
  app.get(EXT_DOCS_CSS_PATH, async (c) => {
    const brand = brandOf(await loadPlatformSettings(deps.db));
    c.header('Cache-Control', cache);
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(extDocsCss(brand.brandColor));
  });
};
