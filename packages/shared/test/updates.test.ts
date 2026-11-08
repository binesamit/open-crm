// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { displayUpdateHtml, mentionedUserIds, renderUpdateBody } from '../src';

const U = '01J9Z0000000000000000000AB';

describe('renderUpdateBody', () => {
  it('escapes HTML so users cannot inject markup', () => {
    const { html } = renderUpdateBody('<img src=x onerror=alert(1)> & "q"');
    expect(html).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
  });

  it('turns mentions into chips and keeps them out of the text', () => {
    const body = `היי [@דנה כהן](user:${U}) תסתכל`;
    const out = renderUpdateBody(body);
    expect(out.html).toContain(`<span class="mention" data-user-id="${U}">@דנה כהן</span>`);
    expect(out.text).toBe('היי @דנה כהן תסתכל');
    expect(mentionedUserIds(body)).toEqual([U]);
  });

  it('links http(s) URLs and keeps line breaks', () => {
    const { html } = renderUpdateBody('ראו https://example.com/x?a=1\nתודה');
    expect(html).toBe(
      'ראו <a href="https://example.com/x?a=1" target="_blank" rel="noopener noreferrer">https://example.com/x?a=1</a><br>תודה',
    );
    expect(renderUpdateBody('javascript:alert(1)').html).toBe('javascript:alert(1)');
  });

  it('escapes mention names', () => {
    const { html } = renderUpdateBody(`[@<b>x</b>](user:${U})`);
    expect(html).toContain('@&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('displayUpdateHtml (Fix: line breaks at read time)', () => {
  it('keeps rich and already-broken bodies as they are', () => {
    expect(displayUpdateHtml('<p>א</p><p>ב</p>', 'א\nב')).toBe('<p>א</p><p>ב</p>');
    expect(displayUpdateHtml('א<br>ב', 'א\nב')).toBe('א<br>ב');
    expect(displayUpdateHtml('שורה אחת', 'שורה אחת')).toBe('שורה אחת');
  });

  it('turns raw newlines in a stored body into <br>', () => {
    expect(displayUpdateHtml('א\nב\r\n\nג', 'א\nב\n\nג')).toBe('א<br>ב<br><br>ג');
  });

  it('renders the plain text when the stored HTML lost its newlines (no mention chips to lose)', () => {
    expect(displayUpdateHtml('אב https://x.co', 'א\nב https://x.co')).toBe(
      'א<br>ב <a href="https://x.co" target="_blank" rel="noopener noreferrer">https://x.co</a>',
    );
    const chip = `<span class="mention" data-user-id="${U}">@x</span>`;
    expect(displayUpdateHtml(`${chip} y`, '@x\ny')).toBe(`${chip} y`);
  });

  it('renders plain-text bodies with their line breaks and blank lines', () => {
    expect(renderUpdateBody('א\nב\n\nג').html).toBe('א<br>ב<br><br>ג');
  });
});
