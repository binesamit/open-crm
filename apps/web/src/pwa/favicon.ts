// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The browser tab's icon (favicon). index.html links the static default (public/favicon-*.png, the built-in app
 * icon) so a tab has an icon before anyone signs in; inside an account the app points every `<link rel="icon">` at
 * the account's icon — the same drawing as its home-screen icon (its logo, or the mark in its colour) — and puts
 * the previous addresses back on leaving / switching accounts.
 *
 * Returns the undo. No icon link in the page = one is added (and removed by the undo).
 */
export const swapFavicon = (href: string, doc: Document = document): (() => void) => {
  const links = [...doc.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
  if (!links.length) {
    const link = doc.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = href;
    doc.head.appendChild(link);
    return () => link.remove();
  }
  const before = links.map((l) => [l.getAttribute('href'), l.getAttribute('type')] as const);
  links.forEach((l) => {
    l.setAttribute('href', href);
    l.setAttribute('type', 'image/png');
  });
  return () =>
    links.forEach((l, i) => {
      const [href0, type0] = before[i]!;
      if (href0 === null) l.removeAttribute('href');
      else l.setAttribute('href', href0);
      if (type0 === null) l.removeAttribute('type');
      else l.setAttribute('type', type0);
    });
};
