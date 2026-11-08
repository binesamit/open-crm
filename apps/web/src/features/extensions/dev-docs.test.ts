// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { docLinkTarget, matchOffsets, splitDocHtml, tocOf, unescapeHtml } from './dev-docs';

/** s37market: the in-app developer docs — code blocks, links between the pages, search and the contents list. */
describe('dev docs helpers', () => {
  it('splits code blocks out of the rendered guide, in order, with their language', () => {
    const html =
      '<h1 id="a">A</h1>\n<pre><code class="language-ts">const x = 1;\n</code></pre>\n<p>mid</p>\n<pre><code>npm i\n</code></pre>\n';
    expect(splitDocHtml(html)).toEqual([
      { kind: 'html', html: '<h1 id="a">A</h1>\n' },
      { kind: 'code', html: 'const x = 1;\n', lang: 'ts' },
      { kind: 'html', html: '\n<p>mid</p>\n' },
      { kind: 'code', html: 'npm i\n', lang: null },
      { kind: 'html', html: '\n' },
    ]);
    expect(splitDocHtml('<p>no code</p>')).toEqual([{ kind: 'html', html: '<p>no code</p>' }]);
  });

  it('maps links: anchors stay in the page, the public pages open in the app, web links open outside', () => {
    expect(docLinkTarget('#7-the-page-sdk')).toEqual({ kind: 'anchor', id: '7-the-page-sdk' });
    expect(docLinkTarget('/api/docs/extensions/quickstart')).toEqual({ kind: 'page', page: 'quickstart', id: null });
    expect(docLinkTarget('/api/docs/extensions#limits')).toEqual({ kind: 'page', page: 'guide', id: 'limits' });
    expect(docLinkTarget('https://example.com/x')).toEqual({ kind: 'external', href: 'https://example.com/x' });
    expect(docLinkTarget('/api/docs')).toEqual({ kind: 'none' });
    expect(docLinkTarget('javascript:alert(1)')).toEqual({ kind: 'none' });
    expect(docLinkTarget('#')).toEqual({ kind: 'none' });
    expect(docLinkTarget(null)).toEqual({ kind: 'none' });
  });

  it('finds a search term case-insensitively, ignoring a blank one', () => {
    expect(matchOffsets('Token tokens TOKEN', 'token')).toEqual([0, 6, 13]);
    expect(matchOffsets('aaa', 'aa')).toEqual([0]);
    expect(matchOffsets('abc', '  ')).toEqual([]);
  });

  it('builds the contents list: sections with their sub-sections, plain text', () => {
    expect(
      tocOf([
        { depth: 1, id: 't', text: 'Title' },
        { depth: 3, id: 'orphan', text: 'Before any section' },
        { depth: 2, id: 'a', text: 'Tokens &amp; scopes' },
        { depth: 3, id: 'a1', text: 'The &lt;iframe&gt;' },
        { depth: 2, id: 'b', text: 'B' },
      ]),
    ).toEqual([
      { id: 'a', text: 'Tokens & scopes', children: [{ id: 'a1', text: 'The <iframe>' }] },
      { id: 'b', text: 'B', children: [] },
    ]);
    expect(unescapeHtml('&quot;x&#39;')).toBe('"x\'');
  });
});
