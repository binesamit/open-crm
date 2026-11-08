// SPDX-License-Identifier: AGPL-3.0-only
import type { ExtensionDocPageKey } from '@bines/shared';

/**
 * s37market — pure helpers of the in-app developer docs (DevDocsPage): the server sends the rendered guide as one HTML
 * string; the page splits out its code blocks (each gets a copy button), maps links between the two pages to the
 * app's own route, and finds a search term in the text.
 */

/** The public paths of the two pages (apps/api extension-docs.csp.ts) → the in-app page. */
const PUBLIC_PAGES: [string, ExtensionDocPageKey][] = [
  ['/api/docs/extensions/quickstart', 'quickstart'],
  ['/api/docs/extensions', 'guide'],
];

export type DocLinkTarget =
  | { kind: 'anchor'; id: string }
  | { kind: 'page'; page: ExtensionDocPageKey; id: string | null }
  | { kind: 'external'; href: string }
  | { kind: 'none' };

/** Where a link inside the rendered guide should go when clicked in the app. */
export const docLinkTarget = (href: string | null | undefined): DocLinkTarget => {
  if (!href) return { kind: 'none' };
  if (href.startsWith('#'))
    return href.length > 1 ? { kind: 'anchor', id: decodeURIComponent(href.slice(1)) } : { kind: 'none' };
  const [path, hash] = href.split('#', 2) as [string, string | undefined];
  for (const [publicPath, page] of PUBLIC_PAGES)
    if (path === publicPath) return { kind: 'page', page, id: hash ? decodeURIComponent(hash) : null };
  if (/^(https?:\/\/|mailto:)/i.test(href)) return { kind: 'external', href };
  return { kind: 'none' };
};

export type DocSegment = { kind: 'html'; html: string } | { kind: 'code'; html: string; lang: string | null };

const CODE_BLOCK = /<pre><code(?: class="language-([\w+#.-]+)")?>([\s\S]*?)<\/code><\/pre>/g;

/** The rendered HTML as prose and code-block segments, in order (a code block's html is its escaped content). */
export const splitDocHtml = (html: string): DocSegment[] => {
  const out: DocSegment[] = [];
  let last = 0;
  for (const m of html.matchAll(CODE_BLOCK)) {
    if (m.index > last) out.push({ kind: 'html', html: html.slice(last, m.index) });
    out.push({ kind: 'code', html: m[2] ?? '', lang: m[1] ?? null });
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push({ kind: 'html', html: html.slice(last) });
  return out;
};

/** The start offsets of every case-insensitive occurrence of `query` in `text` (none for a blank query). */
export const matchOffsets = (text: string, query: string): number[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hay = text.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) out.push(i);
  return out;
};

/** A heading's text arrives as HTML text (entities escaped) — plain text for the table of contents. */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
export const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]!);

/** The table of contents: the page's sections (h2) with their sub-sections (h3). */
export type TocEntry = { id: string; text: string; children: { id: string; text: string }[] };
export const tocOf = (headings: { depth: number; id: string; text: string }[]): TocEntry[] => {
  const out: TocEntry[] = [];
  for (const h of headings) {
    const text = unescapeHtml(h.text);
    if (h.depth === 2) out.push({ id: h.id, text, children: [] });
    else if (h.depth === 3 && out.length) out[out.length - 1]!.children.push({ id: h.id, text });
  }
  return out;
};
