// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLocale, t, type AuthConfig, type Locale, type MessageKey } from '@bines/shared';
import { api, queryKeys } from './api';
import { useLocale } from './locale';

/**
 * The platform's branding (white-label, owner console → Platform settings): the product name and the sign-in
 * screen's tagline, per UI language. Read from the public GET /auth/config — before anyone signs in — and shared
 * with the sign-in screen (same query).
 */
/** The last branding read (kept by the query itself), for texts rendered outside a hook — see `brandText`. */
let lastConfig: AuthConfig | undefined;

export const useAuthConfig = () =>
  useQuery({
    queryKey: queryKeys.authConfig,
    queryFn: async () => (lastConfig = await api().get<AuthConfig>('/auth/config')),
    staleTime: 5 * 60_000,
  });

export type Branding = { productName: string; loginSubtitle: string | null };

/** The branding in a language; until it loaded, the catalog's product name and no tagline. */
export const brandingFor = (config: AuthConfig | undefined, locale: Locale): Branding => ({
  productName: config?.branding?.product_name[locale] || t('app.name', undefined, locale),
  loginSubtitle: config?.branding?.login_subtitle[locale] ?? null,
});

/** The running code's source (AGPL section 13): link, version, commit — for the sign-in footer and "About". */
export const useSourceInfo = () => useAuthConfig().data?.source ?? null;

export const useBranding = (): Branding => {
  const locale = useLocale();
  return brandingFor(useAuthConfig().data, locale);
};

/** The product name in the UI language now (loaded at start by `BrandTitleHost`; until then, the catalog's). */
export const productNameNow = (): string => brandingFor(lastConfig, getLocale()).productName;

/**
 * A message that names the product (`{product}` — invitation texts, connection steps): the owner's product name is
 * filled in, never a fixed brand.
 */
export const brandText = (key: string, vars?: Record<string, string | number>): string =>
  t(key as MessageKey, { product: productNameNow(), ...vars });

/**
 * A title a page set for itself (a public form's) is kept: only an empty title, or the product name this code (or
 * the server, in the served page) put there, is replaced.
 */
let lastBrandTitle = typeof document === 'undefined' ? '' : document.title.trim();
export const applyBrandTitle = (title: string, doc: Pick<Document, 'title'> = document) => {
  const current = doc.title.trim();
  if (current && current !== lastBrandTitle) return;
  doc.title = title;
  lastBrandTitle = title;
};

/**
 * A signed-in screen's own title (WCAG 2.4.2): "<what is on screen> · <product>". It is recorded as
 * the brand title too, so `applyBrandTitle` keeps updating it (a language switch) instead of treating it as a title a
 * page set for itself.
 */
export const applyPageTitle = (page: string, product: string, doc: Pick<Document, 'title'> = document) => {
  const title = page.trim() ? `${page.trim()} · ${product}` : product;
  if (doc.title === title) return;
  doc.title = title;
  lastBrandTitle = title;
};

/**
 * Keeps the tab title on what the screen shows: the open item card's name, else the content's main heading (h1),
 * re-read when the screen changes (a route, a heading that loads later, a rename). Mounted in the app shell.
 */
export const PageTitleHost = ({ root }: { root: () => HTMLElement | null }) => {
  const config = useAuthConfig().data;
  const locale = useLocale();
  useEffect(() => {
    if (!config) return;
    const product = brandingFor(config, locale).productName;
    let frame = 0;
    const read = () => {
      frame = 0;
      const card = document.querySelector<HTMLElement>('[data-testid="item-card"][aria-label]');
      const heading = root()?.querySelector('h1')?.textContent ?? '';
      applyPageTitle(card?.getAttribute('aria-label') || heading, product);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [config, locale, root]);
  return null;
};

/**
 * The browser tab's title = the product name (index.html ships an empty one; the API fills it when it serves the
 * page). Mounted once at the root, so it runs as soon as the app starts and follows a language switch.
 */
export const BrandTitleHost = () => {
  const config = useAuthConfig().data;
  const locale = useLocale();
  useEffect(() => {
    if (config) applyBrandTitle(brandingFor(config, locale).productName);
  }, [config, locale]);
  return null;
};
