// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { t } from '@bines/shared';
import { Button, Input, scrollBehavior } from '@bines/ui';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { splitDocHtml, tocOf } from '../extensions/dev-docs';

/**
 * A rendered documentation page inside the app — the extension developer guide (s37market), the installation guide
 * and the owner's guides: search within the page (every match highlighted, Enter / Shift+Enter to
 * step), a table of contents of its sections, copy buttons on code, and in-page links that scroll. The HTML is the
 * shared Markdown renderer's (`markdownToDocHtml`: raw HTML escaped, links allowlisted).
 *
 * `testId` prefixes the parts' test ids (`<testId>-search`, `-toc`, `-body` …); `anchor` scrolls to a section once the
 * page is shown; `onLink` may take over a link that is not an in-page anchor (return true when it did).
 */
export type DocHeading = { depth: number; id: string; text: string };

/** A code block with a copy button; the code itself is the server's escaped HTML (no markup inside). */
const CodeBlock = ({ html, lang, testId }: { html: string; lang: string | null; testId: string }) => {
  const ref = useRef<HTMLElement>(null);
  return (
    // Code reads left to right in a right-to-left page too (the copy button at its end).
    <div className="dev-doc-code group relative" dir="ltr" data-testid={`${testId}-code`}>
      <button
        type="button"
        className="press absolute end-2 top-2 inline-flex h-7 items-center gap-1 rounded-[8px] border border-line-strong bg-surface px-2 text-xs text-fg-2 hover:bg-surface-2 hover:text-fg"
        data-tip={t('s37market.docs.copyCode')}
        aria-label={t('s37market.docs.copyCode')}
        data-testid={`${testId}-copy`}
        onClick={() => copyText(ref.current?.textContent ?? '')}
      >
        <Icon name="copy" size={13} />
        {t('s37market.docs.copy')}
      </button>
      <pre>
        <code ref={ref} className={lang ? `language-${lang}` : undefined} dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
};

/** The page's body: prose as rendered (safe HTML), code blocks as CodeBlock. Rendered once per page. */
const DocBody = memo(function DocBody({ html, testId }: { html: string; testId: string }) {
  const segments = useMemo(() => splitDocHtml(html), [html]);
  return (
    <>
      {segments.map((s, i) =>
        s.kind === 'code' ? (
          <CodeBlock key={i} html={s.html} lang={s.lang} testId={testId} />
        ) : (
          // Rendered from Markdown by the shared renderer: raw HTML escaped, links allowlisted.
          <div key={i} className="contents" dangerouslySetInnerHTML={{ __html: s.html }} />
        ),
      )}
    </>
  );
});

const MARK = 'mark[data-doc-hit]';

/** Removes the previous search highlights (the text nodes are joined back). */
const clearHits = (root: HTMLElement) => {
  for (const m of Array.from(root.querySelectorAll(MARK))) {
    const parent = m.parentNode!;
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parent.normalize();
  }
};

/** Wraps every occurrence of `query` in the page's text (not in the copy buttons) in a <mark>. */
const markHits = (root: HTMLElement, query: string): HTMLElement[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const hits: HTMLElement[] = [];
  for (const node of nodes) {
    let rest: Text = node;
    for (let i = rest.data.toLowerCase().indexOf(q); i !== -1; i = rest.data.toLowerCase().indexOf(q)) {
      const hit = rest.splitText(i);
      rest = hit.splitText(q.length);
      const mark = document.createElement('mark');
      mark.dataset.docHit = '';
      hit.parentNode!.replaceChild(mark, hit);
      mark.appendChild(hit);
      hits.push(mark);
    }
  }
  return hits;
};

const scrollToId = (root: HTMLElement | null, id: string) => {
  const el = root?.querySelector(`[id="${CSS.escape(id)}"]`);
  el?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  return !!el;
};

export const DocReader = ({
  html,
  headings,
  testId,
  dir = 'ltr',
  lang,
  anchor,
  onLink,
}: {
  html: string;
  headings: DocHeading[];
  testId: string;
  dir?: 'ltr' | 'rtl';
  lang?: string;
  anchor?: string | null;
  onLink?: (href: string) => boolean;
}) => {
  const bodyRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<HTMLElement[]>([]);
  const [current, setCurrent] = useState(0);
  const toc = useMemo(() => tocOf(headings), [headings]);

  // Search: highlight every match, then go to the first.
  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    clearHits(root);
    const found = markHits(root, query);
    setHits(found);
    setCurrent(0);
    return () => clearHits(root);
  }, [query, html]);

  useEffect(() => {
    hits.forEach((h, i) => h.toggleAttribute('data-current', i === current));
    hits[current]?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  }, [hits, current]);

  // A link to a section (another screen, a shared address): scroll there once the page is shown.
  useEffect(() => {
    if (anchor) scrollToId(bodyRef.current, anchor);
  }, [html, anchor]);

  const go = (id: string) => {
    // The address keeps the section (shareable), without a navigation.
    if (scrollToId(bodyRef.current, id)) window.history.replaceState(window.history.state, '', `#${id}`);
  };

  const onBodyClick = (e: MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const href = a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#')) {
      e.preventDefault();
      if (href.length > 1) go(decodeURIComponent(href.slice(1)));
    } else if (onLink?.(href)) e.preventDefault();
    else if (/^(https?:\/\/|mailto:)/i.test(href)) {
      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };

  const step = (d: number) => hits.length && setCurrent((c) => (c + d + hits.length) % hits.length);

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-[1] flex flex-wrap items-center gap-2 bg-bg py-1" role="search">
        <div className="relative min-w-0 flex-1 basis-60">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') setQuery('');
            }}
            placeholder={t('s37market.docs.search')}
            aria-label={t('s37market.docs.search')}
            data-testid={`${testId}-search`}
          />
        </div>
        {query.trim() ? (
          <>
            <span className="text-sm text-muted tabular-nums" data-testid={`${testId}-hits`} data-count={hits.length}>
              {hits.length
                ? t('s37market.docs.matches', { current: current + 1, total: hits.length })
                : t('s37market.docs.noMatches')}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!hits.length}
              onClick={() => step(-1)}
              aria-label={t('s37market.docs.prev')}
              data-tip={t('s37market.docs.prev')}
              data-testid={`${testId}-prev`}
            >
              <Icon name="chevronDown" size={14} className="rotate-180" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!hits.length}
              onClick={() => step(1)}
              aria-label={t('s37market.docs.next')}
              data-tip={t('s37market.docs.next')}
              data-testid={`${testId}-next`}
            >
              <Icon name="chevronDown" size={14} />
            </Button>
          </>
        ) : null}
      </div>

      {/* The page's own direction: an English guide reads left to right in a Hebrew app, and the other way round. */}
      <div dir={dir} lang={lang} className="flex gap-8 text-start">
        {toc.length ? (
          <aside
            className="sticky top-14 max-h-[calc(100dvh-8rem)] w-[230px] shrink-0 self-start overflow-y-auto max-lg:hidden"
            data-testid={`${testId}-toc`}
          >
            <div className="mb-2 text-[0.6875rem] font-semibold text-muted" dir="auto">
              {t('s37market.docs.toc')}
            </div>
            <ol className="space-y-1 text-[0.8125rem]">
              {toc.map((h) => (
                <li key={h.id}>
                  <a
                    href={`#${h.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      go(h.id);
                    }}
                    className="block text-fg-2 hover:text-primary"
                  >
                    {h.text}
                  </a>
                  {h.children.length ? (
                    <ol className="mt-1 space-y-1 ps-3 text-xs">
                      {h.children.map((c) => (
                        <li key={c.id}>
                          <a
                            href={`#${c.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              go(c.id);
                            }}
                            className="block text-muted hover:text-primary"
                          >
                            {c.text}
                          </a>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ol>
          </aside>
        ) : null}
        <article
          ref={bodyRef}
          className="dev-doc min-w-0 max-w-[900px] flex-1"
          data-testid={`${testId}-body`}
          onClick={onBodyClick}
        >
          <DocBody html={html} testId={testId} />
        </article>
      </div>
    </div>
  );
};
