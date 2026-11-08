// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  docBlocks,
  docEntityRefs,
  docExportDirection,
  docExportDocument,
  docPlainText,
  docToHtml,
  docToMarkdown,
  type RichNode,
} from '../src';

const t = (text: string, marks?: RichNode['marks']): RichNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content });
const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

const sample: RichNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1, id: 'h' }, content: [t('Plan')] },
    p(t('bold', [{ type: 'bold' }]), t(' & '), t('link', [{ type: 'link', attrs: { href: 'https://x.test/a b' } }])),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [p(t('one')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('nested'))] }] }],
        },
      ],
    },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('three'))] }] },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] },
      ],
    },
    { type: 'blockquote', content: [p(t('quote'))] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = `x`;')] },
    { type: 'horizontalRule' },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p(t('A'))] },
            { type: 'tableHeader', content: [p(t('B'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(t('1'))] },
            { type: 'tableCell', content: [p(t('2|3'))] },
          ],
        },
      ],
    },
    { type: 'callout', attrs: { tone: 'warn', emoji: '⚠️', id: 'c' }, content: [p(t('careful'))] },
    { type: 'image', attrs: { asset_id: ID, alt: 'Chart' } },
    { type: 'fileBlock', attrs: { asset_id: ID, name: 'brief.pdf' } },
    p({ type: 'mention', attrs: { id: ID, label: 'Dana' } }, t(' see '), {
      type: 'entityLink',
      attrs: { kind: 'item', id: ID, board_id: ID, label: 'Lead' },
    }),
    { type: 'boardEmbed', attrs: { board_id: ID, label: 'Leads' } },
  ],
};
const links = {
  assetUrl: (id: string) => `https://files.test/${id}`,
  entityUrl: (kind: string, id: string, board?: string) => `https://app.test/${kind}/${board ?? '-'}/${id}`,
};

describe('doc export — Markdown', () => {
  it('writes GitHub-flavoured Markdown for every block', () => {
    const md = docToMarkdown(sample, links, 'My doc');
    expect(md).toBe(
      [
        '# My doc',
        '',
        '# Plan',
        '',
        '**bold** & [link](https://x.test/a%20b)',
        '',
        '- one\n  - nested',
        '',
        '3. three',
        '',
        '- [x] done\n- [ ] todo',
        '',
        '> quote',
        '',
        '```ts\nconst a = `x`;\n```',
        '',
        '---',
        '',
        '| A | B |\n| --- | --- |\n| 1 | 2\\|3 |',
        '',
        '> ⚠️ careful',
        '',
        `![Chart](https://files.test/${ID})`,
        '',
        `📎 [brief.pdf](https://files.test/${ID})`,
        '',
        `@Dana see [Lead](https://app.test/item/${ID}/${ID})`,
        '',
        `📋 [Leads](https://app.test/board/-/${ID})`,
        '',
      ].join('\n'),
    );
  });

  it('escapes Markdown in text and keeps names without links when there is no URL', () => {
    expect(docToMarkdown({ type: 'doc', content: [p(t('*not bold* [x](y) <b>'))] })).toBe(
      '\\*not bold\\* \\[x\\](y) \\<b\\>\n',
    );
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'image', attrs: { asset_id: ID, alt: 'pic' } }] })).toBe(
      '[pic]\n',
    );
    expect(docToMarkdown(null)).toBe('\n');
  });
});

describe('doc export — HTML (allowlist)', () => {
  it('renders the blocks and escapes every text and attribute', () => {
    const html = docToHtml(sample, links);
    expect(html).toContain('<h1>Plan</h1>');
    expect(html).toContain(
      '<strong>bold</strong> &amp; <a href="https://x.test/a b" rel="noopener noreferrer">link</a>',
    );
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('<li class="task" data-checked="true"><input type="checkbox" disabled checked>');
    expect(html).toContain('<table><tbody><tr><th><p>A</p></th>');
    expect(html).toContain('<div class="callout callout-warn"><span class="callout-emoji">⚠️</span>');
    expect(html).toContain(`<img src="https://files.test/${ID}" alt="Chart">`);
    expect(html).toContain('<span class="mention">@Dana</span>');
  });

  it('drops scripts, unsafe links, unknown nodes, marks and attributes', () => {
    const evil: RichNode = {
      type: 'doc',
      content: [
        p(t('<img src=x onerror=alert(1)>')),
        p(t('js', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]), t('x', [{ type: 'evil' }])),
        { type: 'script', content: [t('kept text')] },
        { type: 'callout', attrs: { tone: '"><script>', emoji: '<b>' }, content: [p(t('c'))] },
        { type: 'heading', attrs: { level: 9, onclick: 'x' }, content: [t('h')] },
        { type: 'entityLink', attrs: { kind: 'doc', id: ID, label: '<i>x</i>' } },
      ],
    };
    const html = docToHtml(evil, { entityUrl: () => 'javascript:alert(1)' });
    expect(html).not.toMatch(/<script|<img|javascript:|onclick|<b>|<i>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<p>js');
    expect(html).toContain('kept text');
    expect(html).toContain('class="callout callout-info"');
    expect(html).toContain('<h2>h</h2>');
    expect(html).toContain('<span class="entity">&lt;i&gt;x&lt;/i&gt;</span>');
  });

  it('S-99: only well-formed ids reach the link builders', () => {
    const seen: string[] = [];
    const urls = {
      entityUrl: (_kind: string, id: string, board?: string) => {
        seen.push(id, board ?? '');
        return 'https://app.test/x';
      },
      assetUrl: (id: string) => {
        seen.push(id);
        return 'https://app.test/f';
      },
    };
    const doc: RichNode = {
      type: 'doc',
      content: [
        { type: 'entityLink', attrs: { kind: 'item', id: '../../admin', board_id: ID, label: 'a' } },
        { type: 'boardEmbed', attrs: { board_id: '..%2Fx', label: 'b' } },
        { type: 'fileBlock', attrs: { asset_id: '../secret', name: 'f' } },
        { type: 'entityLink', attrs: { kind: 'doc', id: ID, label: 'ok' } },
      ],
    };
    docToHtml(doc, urls);
    docToMarkdown(doc, urls);
    expect(seen.every((s) => s === '' || s === ID)).toBe(true);
    expect(seen).toContain(ID);
  });

  it('a whole page: title escaped, RTL, print styles, no script', () => {
    const page = docExportDocument({ title: 'A <b>', bodyHtml: '<p>x</p>' });
    expect(page).toContain('<html lang="he" dir="rtl">');
    expect(page).toContain('<title>A &lt;b&gt;</title>');
    expect(page).toContain('@media print');
    expect(page).not.toContain('<script');
  });
});

describe('doc content helpers', () => {
  it('blocks by id, references, plain text of the new blocks', () => {
    expect([...docBlocks(sample).entries()]).toEqual([
      ['h', 'Plan'],
      ['c', 'careful'],
    ]);
    expect(docEntityRefs(sample)).toEqual([
      { kind: 'item', id: ID },
      { kind: 'board', id: ID },
    ]);
    const text = docPlainText(sample);
    expect(text).toContain('careful');
    expect(text).toContain('brief.pdf');
    expect(text).toContain('@Dana see Lead');
  });
});

describe('docExportDirection (s37generic)', () => {
  const para = (text: string): RichNode => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  it("follows the doc's first strong letter, then its title, then the reader's language", () => {
    expect(docExportDirection(para('Hello'), 'תוכנית', 'he')).toEqual({ dir: 'ltr', lang: 'en' });
    expect(docExportDirection(para('  42 שלום'), 'Plan', 'en')).toEqual({ dir: 'rtl', lang: 'he' });
    expect(docExportDirection(null, 'Plan', 'he')).toEqual({ dir: 'ltr', lang: 'en' });
    expect(docExportDirection(para('123'), '2026', 'en')).toEqual({ dir: 'ltr', lang: 'en' });
    expect(docExportDirection(para('123'), '2026', 'he')).toEqual({ dir: 'rtl', lang: 'he' });
    // Same direction as the reader: the reader's language is kept.
    expect(docExportDirection(para('Hi'), '', 'en')).toEqual({ dir: 'ltr', lang: 'en' });
  });
});
