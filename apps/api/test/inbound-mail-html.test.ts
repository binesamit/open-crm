// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderRichDoc, type RichNode, updateImageOptions } from '@bines/shared';
import { mailHtmlToDoc, mailTextToDoc } from '../src/modules/inbound-email/mail-html';

/** an incoming message's HTML → the update's document (only the update renderer's nodes come out). */
const opts = {
  image: ({ src, alt }: { src: string; alt: string }) => (src.startsWith('cid:') ? { src: 'remote:0', alt } : null),
  linkLabel: 'link',
  stripQuotes: false,
  maxChars: 50_000,
};
const html = (body: string, o: Partial<typeof opts> = {}) => {
  const r = mailHtmlToDoc(body, { ...opts, ...o });
  return { ...r, out: renderRichDoc({ type: 'doc', content: r.blocks }, updateImageOptions) };
};
const types = (nodes: RichNode[]): string[] => nodes.flatMap((n) => [n.type, ...types(n.content ?? [])]);

describe('mail HTML → update document', () => {
  it('keeps formatting, headings, lists and links; drops scripts, styles, forms and event handlers', () => {
    const { out, blocks } = html(`<html><head><style>p{color:red}</style><script>alert(1)</script></head><body>
      <h1>Weekly <b>news</b></h1>
      <p onclick="steal()">Hello <strong>Dana</strong>, see <a href="https://example.com/a" onmouseover="x()">the plan</a>.</p>
      <ul><li>one</li><li><em>two</em></li></ul>
      <form action="https://evil.test"><input value="secret"><button>Send</button></form>
      <a href="javascript:alert(1)">bad link</a>
    </body></html>`);
    // The update's own heading scale (an h1 shows as its h2).
    expect(out.html).toContain('<h2>Weekly <strong>news</strong></h2>');
    expect(out.html).toContain('<strong>Dana</strong>');
    expect(out.html).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">the plan</a>',
    );
    expect(out.html).toContain('<ul');
    expect(out.html).toContain('<em>two</em>');
    for (const bad of ['script', 'alert', 'style', 'onclick', 'onmouseover', 'form', 'input', 'secret', 'javascript'])
      expect(out.html).not.toContain(bad);
    // The unsafe link keeps its text only.
    expect(out.text).toContain('bad link');
    expect(new Set(types(blocks))).toEqual(new Set(['heading', 'text', 'paragraph', 'bulletList', 'listItem']));
  });

  it('a long bare link shows as the label; a short one stays as it is; text links keep their words', () => {
    const long = 'https://links.email.example.com/CL0/https:%2F%2Fexample.com%2Fpost/1/0100019a2b3c4d5e-6f7a8b9c';
    const { out } = html(
      `<p><a href="${long}">${long}</a> and ${long} and https://ex.co/a and <a href="${long}">Read more</a></p>`,
    );
    expect(out.html).not.toContain(`>${long}<`);
    expect(out.text).toBe('link and link and https://ex.co/a and Read more');
    expect(out.html.match(/href="https:\/\/links\.email/g)).toHaveLength(3);
  });

  it('drops hidden text (a preview line) and invisible padding characters', () => {
    const { out } = html('<div style="display: none; max-height:0">Preview text‌ ͏</div><p>Body​ text</p>');
    expect(out.text).toBe('Body text');
  });

  it('a layout table becomes blocks; a data table stays a table', () => {
    const layout = html(
      '<table role="presentation"><tr><td><h2>Title</h2></td></tr><tr><td><p>First</p></td><td><p>Second</p></td></tr></table>',
    );
    expect(types(layout.blocks)).not.toContain('table');
    expect(layout.out.text).toBe('Title\nFirst\nSecond');
    const data = html('<table><tr><th>Item</th><th>Price</th></tr><tr><td>Desk</td><td>500</td></tr></table>');
    expect(types(data.blocks).filter((t) => t.startsWith('table'))).toEqual([
      'table',
      'tableRow',
      'tableHeader',
      'tableHeader',
      'tableRow',
      'tableCell',
      'tableCell',
    ]);
  });

  it('images go through the caller (an unknown one is left out) and render as a placeholder the app fills', () => {
    const { blocks, out } = html(
      '<p>Logo <img src="cid:logo@x" alt="Our logo"></p><img src="https://t.example/p.gif">',
    );
    expect(blocks.filter((b) => b.type === 'image')).toEqual([
      { type: 'image', attrs: { src: 'remote:0', alt: 'Our logo' } },
    ]);
    expect(out.html).toContain('data-image-ref="remote:0"');
    expect(out.html).toContain('src="data:image/gif;base64,');
    expect(out.html).not.toContain('t.example');
  });

  it('a reply loses the quoted earlier message; a forward keeps it', () => {
    const body =
      '<div>Approved, thanks</div><div class="gmail_quote"><div>On Mon, Dana wrote:</div><blockquote>old text</blockquote></div>';
    expect(html(body, { stripQuotes: true }).out.text).toBe('Approved, thanks');
    expect(html(body).out.text).toContain('old text');
    const outlook = '<p>Yes</p><div id="divRplyFwdMsg">From: Dana</div><p>old text</p>';
    expect(html(outlook, { stripQuotes: true }).out.text).toBe('Yes');
  });

  it('stops at the character limit and says it cut', () => {
    const r = html(`<p>${'a'.repeat(30)}</p><p>${'b'.repeat(30)}</p>`, { maxChars: 40 });
    expect(r.cut).toBe(true);
    expect(r.out.text.replace(/\s/g, '')).toHaveLength(40);
    expect(html('<p>short</p>', { maxChars: 40 }).cut).toBe(false);
  });

  it('plain text: paragraphs, line breaks and links', () => {
    const r = mailTextToDoc('Hi\nthere\n\nSee https://ex.co/x', { linkLabel: 'link', maxChars: 1000 });
    const out = renderRichDoc({ type: 'doc', content: r.blocks });
    expect(out.html).toBe(
      '<p>Hi<br>there</p><p>See <a href="https://ex.co/x" target="_blank" rel="noopener noreferrer">https://ex.co/x</a></p>',
    );
  });
});
