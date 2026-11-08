// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { markdownToRichDoc, renderRichDoc, richDocSchema } from '../src';

const html = (md: string) => renderRichDoc(markdownToRichDoc(md)).html;

describe('markdownToRichDoc (sync-ai)', () => {
  it('turns headings, emphasis, lists and code into the update document', () => {
    expect(html('# Title\n\n### Sub')).toBe('<h2>Title</h2><h3>Sub</h3>');
    expect(html('**bold** *it* ~~old~~ `x<1`')).toBe(
      '<p><strong>bold</strong> <em>it</em> <s>old</s> <code>x&lt;1</code></p>',
    );
    expect(html('- a\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    expect(html('3. c\n4. d')).toBe('<ol start="3"><li><p>c</p></li><li><p>d</p></li></ol>');
    expect(html('```js\nif (a < b) {}\n```')).toBe('<pre><code>if (a &lt; b) {}</code></pre>');
    expect(html('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(html('a\n\n---\n\nb')).toBe('<p>a</p><hr><p>b</p>');
  });

  it('keeps single line breaks (chat style) and task lists', () => {
    expect(html('one\ntwo')).toBe('<p>one<br>two</p>');
    expect(html('- [x] done\n- [ ] open')).toContain('data-type="taskList"');
    expect(html('- [x] done\n- [ ] open')).toContain('data-checked="true"');
  });

  it('renders GFM tables with alignment', () => {
    const out = html('| Name | Sum |\n|:--|--:|\n| Dana | 5 |');
    expect(out).toBe(
      '<div class="rich-table"><table><tr><th style="text-align:left">Name</th><th style="text-align:right">Sum</th></tr>' +
        '<tr><td style="text-align:left">Dana</td><td style="text-align:right">5</td></tr></table></div>',
    );
    expect(renderRichDoc(markdownToRichDoc('| a | b |\n|-|-|\n| 1 | 2 |')).text).toBe('a | b\n1 | 2');
  });

  it('never lets HTML or unsafe links through', () => {
    expect(html('<script>alert(1)</script>')).not.toContain('<script');
    expect(html('hi <b onclick="x">there</b>')).toBe('<p>hi &lt;b onclick=&quot;x&quot;&gt;there&lt;/b&gt;</p>');
    expect(html('[x](javascript:alert(1))')).toBe('<p>x</p>');
    expect(html('[site](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a></p>',
    );
    expect(html('![alt](https://example.com/a.png)')).not.toContain('<img');
  });

  it('decodes character references once and keeps mentions as chips', () => {
    expect(html('a &amp; b')).toBe('<p>a &amp; b</p>');
    const doc = markdownToRichDoc('hi [@Dana](user:01ARZ3NDEKTSV4RRFFQ69G5FAV)');
    const r = renderRichDoc(doc);
    expect(r.mentions).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
    expect(r.html).toContain('<span class="mention" data-user-id="01ARZ3NDEKTSV4RRFFQ69G5FAV">@Dana</span>');
  });

  it('always yields a valid document', () => {
    for (const md of ['', '   ', '# x', '- \n-', '|a|\n|-|\n'])
      expect(richDocSchema.safeParse(markdownToRichDoc(md)).success).toBe(true);
  });
});
