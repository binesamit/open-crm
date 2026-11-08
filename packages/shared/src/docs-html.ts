// SPDX-License-Identifier: AGPL-3.0-only
import { Marked, type Tokens } from 'marked';

/**
 * Markdown → HTML for documentation pages the platform serves itself (s37docs: the extension developer guide at
 * `/api/docs/extensions`). The source is the repository's own Markdown, bundled at build time — never user content —
 * but it is still rendered defensively: raw HTML in the Markdown is shown as text, and every link goes through
 * `linkFor` (http(s) / mailto / in-page anchors only; anything else becomes plain text).
 *
 * Headings get GitHub-style ids, so a table of contents written for GitHub (`[x](#7-the-page-sdk--binesext-sdk)`) works.
 */
export type DocHtmlOptions = {
  /** Maps a link's href to where it should point (or null = render the text without a link). Default: safe hrefs only. */
  linkFor?: (href: string) => string | null;
  /** Rewrites prose text (not code), e.g. a white-label product name. */
  text?: (s: string) => string;
};

export type DocHtml = { html: string; title: string; headings: { depth: number; id: string; text: string }[] };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** GitHub's heading anchor: lower case, punctuation dropped (letters, digits, `_`, `-` and spaces stay), spaces → `-`. */
export const headingSlug = (s: string) =>
  s
    .replace(/[`*~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');

/** A link target that is safe to put in an href as it is. */
export const isSafeDocHref = (href: string) => /^(https?:\/\/|mailto:|#)/i.test(href.trim());

export const markdownToDocHtml = (markdown: string, opts: DocHtmlOptions = {}): DocHtml => {
  const linkFor = opts.linkFor ?? ((h: string) => (isSafeDocHref(h) ? h : null));
  const headings: DocHtml['headings'] = [];
  const seen = new Map<string, number>();
  const md = new Marked({
    gfm: true,
    walkTokens: (tok) => {
      // Prose only: code spans and code blocks are other token types and stay exactly as written.
      if (opts.text && tok.type === 'text' && !(tok as Tokens.Text).tokens?.length) {
        const t = tok as Tokens.Text;
        t.text = opts.text(t.text);
      }
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const base = headingSlug(text) || 'section';
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        const inner = this.parser.parseInline(tokens);
        headings.push({ depth, id, text: inner.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>\n`;
      },
      // Raw HTML in the Markdown is shown as text, never parsed.
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = linkFor(href);
        const local = !!target && target.startsWith('/') && !target.startsWith('//');
        if (!target || !(local || isSafeDocHref(target))) return inner;
        const external = /^https?:\/\//i.test(target);
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}${
          external ? ' rel="noopener noreferrer"' : ''
        }>${inner}</a>`;
      },
      image({ text }) {
        return escapeHtml(text);
      },
    },
  });
  const html = md.parse(markdown, { async: false });
  const title = headings.find((h) => h.depth === 1)?.text ?? '';
  return { html, title, headings };
};
