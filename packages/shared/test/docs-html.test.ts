// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { headingSlug, markdownToDocHtml } from '../src/docs-html';

describe('markdownToDocHtml (s37docs)', () => {
  it('gives headings GitHub-style ids, so a GitHub table of contents works', () => {
    expect(headingSlug('7. The page SDK — `@bines/ext-sdk`')).toBe('7-the-page-sdk--binesext-sdk');
    expect(headingSlug('2. How it fits together')).toBe('2-how-it-fits-together');
    const r = markdownToDocHtml('# Title\n\n## 7. The page SDK — `@bines/ext-sdk`\n\n## Same\n\n## Same\n');
    expect(r.title).toBe('Title');
    expect(r.html).toContain('<h2 id="7-the-page-sdk--binesext-sdk">');
    expect(r.headings.map((h) => h.id)).toEqual(['title', '7-the-page-sdk--binesext-sdk', 'same', 'same-1']);
  });

  it('never passes raw HTML or unsafe links through', () => {
    const r = markdownToDocHtml(
      'Text <b onclick="x()">bold</b> and a < b.\n\n<script>alert(1)</script>\n\n[js](javascript:alert(1)) [repo](../plans/X.md) [web](https://example.com) [anchor](#top)\n\n![img](https://x.example/a.png)\n',
    );
    expect(r.html).not.toMatch(/<script|<b |onclick="/);
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).not.toContain('javascript:');
    expect(r.html).not.toContain('X.md"');
    expect(r.html).toContain('<a href="https://example.com" rel="noopener noreferrer">web</a>');
    expect(r.html).toContain('<a href="#top">anchor</a>');
    expect(r.html).not.toContain('<img');
  });

  it('maps links and rewrites prose but not code', () => {
    const r = markdownToDocHtml(
      'Bines OS & Bines: `Bines` and `x-bines-signature`, see [the tutorial](QUICKSTART.md#4-write-the-page).\n\n```\ncreateBinesSdk() // Bines\n```\n\n| a | b |\n|---|---|\n| `x \\| y` | Bines |\n',
      {
        text: (s) => s.replace(/Bines OS/g, 'Acme <Work>').replace(/(?<![-@\w])Bines(?![-\w])/g, 'Acme'),
        linkFor: (h) => (h.startsWith('QUICKSTART.md') ? `/api/docs/extensions/quickstart${h.slice(13)}` : null),
      },
    );
    expect(r.html).toContain('Acme &lt;Work&gt; &amp; Acme');
    expect(r.html).toContain('<code>Bines</code>');
    expect(r.html).toContain('createBinesSdk() // Bines');
    expect(r.html).toContain('<a href="/api/docs/extensions/quickstart#4-write-the-page">the tutorial</a>');
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<td>Acme</td>');
  });

  it('refuses protocol-relative links from the mapper', () => {
    const r = markdownToDocHtml('[x](a.md)', { linkFor: () => '//evil.example' });
    expect(r.html).not.toContain('href');
  });
});
