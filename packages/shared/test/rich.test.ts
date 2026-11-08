// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isRichDocEmpty, renderRichDoc, richDocSchema, type RichNode } from '../src';

const doc = (...content: RichNode[]): RichNode => ({ type: 'doc', content });
const p = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content });
const text = (t: string, marks?: RichNode['marks']): RichNode => ({ type: 'text', text: t, marks });
const ID = '01J0000000000000000000000A';

describe('rich text (M1.1 #7)', () => {
  it('renders the allowed structure', () => {
    const r = renderRichDoc(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('כותרת')] },
        p(
          text('חזק', [{ type: 'bold' }]),
          text(' ו'),
          text('קישור', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        ),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('א'))] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(text('בוצע'))] }] },
      ),
    );
    expect(r.html).toBe(
      '<h2>כותרת</h2><p><strong>חזק</strong> ו<a href="https://example.com" target="_blank" rel="noopener noreferrer">קישור</a></p>' +
        '<ul><li><p>א</p></li></ul>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><input type="checkbox" disabled checked><div><p>בוצע</p></div></li></ul>',
    );
    expect(r.text).toContain('כותרת');
    expect(r.text).toContain('[x] בוצע');
  });

  it('escapes text and never emits markup from input', () => {
    const r = renderRichDoc(doc(p(text('<script>alert(1)</script>"\'&'))));
    expect(r.html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;</p>');
  });

  it('drops unsafe links and unknown marks, keeps text of unknown nodes', () => {
    const r = renderRichDoc(
      doc(
        p(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'onclick' }])),
        { type: 'iframe', attrs: { src: 'https://evil' }, content: [text('inside')] },
        p(text('y', [{ type: 'link', attrs: { href: 'https://a.b/"onmouseover="x' } }])),
      ),
    );
    expect(r.html).not.toContain('javascript');
    expect(r.html).not.toContain('iframe');
    expect(r.html).toContain('<p>x</p>inside');
    expect(r.html).toContain('href="https://a.b/&quot;onmouseover=&quot;x"');
  });

  it('collects valid mentions only', () => {
    const r = renderRichDoc(
      doc(
        p(
          { type: 'mention', attrs: { id: ID, label: 'דנה' } },
          { type: 'mention', attrs: { id: '"><img src=x>', label: 'x' } },
        ),
      ),
    );
    expect(r.mentions).toEqual([ID]);
    expect(r.html).toBe(`<p><span class="mention" data-user-id="${ID}">@דנה</span>@x</p>`);
  });

  it('validates the envelope and detects empty documents', () => {
    expect(richDocSchema.safeParse({ type: 'paragraph' }).success).toBe(false);
    expect(richDocSchema.safeParse(doc(p(text('a')))).success).toBe(true);
    expect(isRichDocEmpty(doc(p()))).toBe(true);
    expect(isRichDocEmpty(doc(p(text('  '))))).toBe(true);
    expect(isRichDocEmpty(doc({ type: 'horizontalRule' }))).toBe(false);
  });
});

describe('line breaks and paragraphs (Fix: )', () => {
  it('keeps every Enter as a paragraph, Shift+Enter as <br>, and an empty paragraph (a blank line)', () => {
    const r = renderRichDoc(
      doc(
        p(text('ראשון')),
        p(text('שני'), { type: 'hardBreak' }, text('שלישי')),
        { type: 'paragraph' },
        p(text('אחרי')),
      ),
    );
    expect(r.html).toBe('<p>ראשון</p><p>שני<br>שלישי</p><p></p><p>אחרי</p>');
    expect(r.text).toBe('ראשון\nשני\nשלישי\n\nאחרי');
  });
});
