// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { markdownToDocHtml } from '@bines/shared';
import { DocReader } from '../docs/DocReader';
import { guideLinkTarget } from './InstallGuide';
import { guideShownLocale, guideTitle, moveGuide } from './OwnerGuides';

/**
 * Guides: the reader's links between the guide's two languages, the owner guides' language fallback
 * and reordering, and the reader itself (contents list, search, an in-page link).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('installation guide links', () => {
  it('maps the public pages to a language and a section; anything else is not the guide', () => {
    expect(guideLinkTarget('/api/docs/guide/he')).toEqual({ locale: 'he', id: null });
    expect(guideLinkTarget('/api/docs/guide#7-activating-a-license-key')).toEqual({
      locale: 'en',
      id: '7-activating-a-license-key',
    });
    expect(guideLinkTarget('/api/docs/guide/he#9-%D7%97')).toEqual({ locale: 'he', id: '9-ח' });
    expect(guideLinkTarget('/api/docs/extensions')).toBeNull();
    expect(guideLinkTarget('https://example.com')).toBeNull();
  });
});

describe('owner guides', () => {
  const g = { title: { he: '', en: 'Runbook' }, body: { he: '', en: '# Hi' } };
  it('falls back to the other language when the chosen one is empty', () => {
    expect(guideTitle(g, 'he')).toBe('Runbook');
    expect(guideShownLocale(g, 'he')).toBe('en');
    expect(guideShownLocale(g, 'en')).toBe('en');
    // Nothing written at all: the chosen language.
    expect(guideShownLocale({ body: { he: '', en: ' ' } }, 'he')).toBe('he');
  });

  it('moves a guide one step, not past the ends', () => {
    expect(moveGuide(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveGuide(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveGuide(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(moveGuide(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(moveGuide(['a'], 'x', 1)).toBeNull();
  });
});

describe('DocReader', () => {
  it('shows the contents list, highlights search matches and hands other links to the page', async () => {
    const doc = markdownToDocHtml(
      '# Guide\n\n## 1. First\n\nalpha beta\n\n## 2. Second\n\nbeta [other](/api/docs/guide/he)\n\n```sh\necho beta\n```\n',
      { linkFor: (href) => href },
    );
    const onLink = vi.fn(() => true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    Element.prototype.scrollIntoView = vi.fn();
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(DocReader, {
          html: doc.html,
          headings: doc.headings,
          testId: 'g',
          dir: 'rtl',
          lang: 'he',
          onLink,
        }),
      ),
    );
    const toc = host.querySelector('[data-testid="g-toc"]')!;
    expect(Array.from(toc.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['1. First', '2. Second']);
    expect(host.querySelector('[data-testid="g-code"]')?.getAttribute('dir')).toBe('ltr');

    const input = host.querySelector<HTMLInputElement>('[data-testid="g-search"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'beta');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('[data-testid="g-hits"]')?.getAttribute('data-count')).toBe('3');

    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/api/docs/guide/he"]')!.click());
    expect(onLink).toHaveBeenCalledWith('/api/docs/guide/he');
    await act(async () => root.unmount());
    host.remove();
  });
});
