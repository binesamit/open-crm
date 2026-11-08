// SPDX-License-Identifier: AGPL-3.0-only
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeIdocTotals,
  emptyIdocTheme,
  idocSectionSchema,
  type IdocSection,
  type IdocSummarySection,
  type PublicIdocData,
  type PublicIdocRow,
  type PublicIdocSection,
} from '@bines/shared';
import type * as PdfModule from '../src/modules/idocs/idocs.pdf';
import {
  idocFontPath,
  idocPdfFileName,
  markdownBlocks,
  renderIdocPdf,
  visualLine,
  type IdocPdfInput,
} from '../src/modules/idocs/idocs.pdf';

/** Interactive documents as PDF: the renderer alone — no database. */

const pdfText = async (bytes: Uint8Array) => {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { pages: totalPages, text: text.replace(/\s+/g, ' ') };
};

const sec = (raw: Record<string, unknown>, data: PublicIdocData = {}): PublicIdocSection =>
  ({ ...idocSectionSchema.parse(raw), data }) as IdocSection & { data: PublicIdocData };

const row = (key: string, name: string, price: number, selected: boolean): PublicIdocRow => ({
  key,
  name,
  description: '',
  price,
  unit_price: null,
  recurring_price: null,
  recurring_unit_price: null,
  qty: null,
  selected,
  requires: [],
  requires_names: [],
  unit: '',
});

const sample = (over: Partial<IdocPdfInput> = {}): IdocPdfInput => {
  const lines = sec(
    { kind: 'lines', id: 'add', title: 'Add-ons', mode: 'multi' },
    { rows: [row('a', 'Website', 1000, true), row('b', 'Hosting (yearly)', 500, false)] },
  );
  const summary = sec({ kind: 'summary', id: 'sum', title: 'Summary' });
  const totals = computeIdocTotals(
    [{ section: lines as never, rows: lines.data.rows! }],
    summary as unknown as IdocSummarySection,
    { vat_percent: 18, prices_include_vat: false, currency: 'ILS' },
  );
  return {
    docName: 'Quote 1027',
    version: 2,
    accountName: 'Acme',
    language: 'en',
    timezone: 'Asia/Jerusalem',
    theme: emptyIdocTheme(),
    totals,
    sections: [
      sec({ kind: 'header', id: 'h', title: 'Quote for Acme' }, { fields: [{ label: 'Date', value: '2026-10-18' }] }),
      sec({ kind: 'text', id: 't', title: 'Scope', body: '**Bold** intro\n\n- first item\n- second item' }),
      lines,
      summary,
      sec({ kind: 'signature', id: 's', title: 'Approval', consents: [{ key: 'c1', text: 'I agree to the terms' }] }),
    ],
    ...over,
  };
};

describe('interactive document PDF', () => {
  it('finds the font from the sources', () => {
    expect(idocFontPath()).toBeTruthy();
  });

  // The build bundles src into apps/api/dist/*.js (tsup): the font must resolve from there, not only from tsx.
  // Bundled the same way into a folder at the same depth as dist, with no help from the working directory.
  it('generates a PDF from the built bundle', async () => {
    const out = resolve(__dirname, '../.pdf-bundle-test');
    rmSync(out, { recursive: true, force: true });
    const { build } = await import('tsup');
    await build({
      entry: { pdf: resolve(__dirname, '../src/modules/idocs/idocs.pdf.ts') },
      outDir: out,
      format: ['esm'],
      target: 'node22',
      platform: 'node',
      noExternal: [/^@bines\//],
      silent: true,
      config: false,
    });
    const cwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const built = (await import(pathToFileURL(resolve(out, 'pdf.js')).href)) as typeof PdfModule;
      const path = built.idocFontPath();
      expect(path && resolve(path)).toBe(resolve(__dirname, '../assets/fonts/Rubik-Regular.ttf'));
      const { text } = await pdfText(await built.renderIdocPdf(sample()));
      expect(text).toContain('Quote for Acme');
    } finally {
      process.chdir(cwd);
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('draws every section, the choices and totals, marked unsigned', async () => {
    const bytes = await renderIdocPdf(sample());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const { text, pages } = await pdfText(bytes);
    expect(pages).toBe(1);
    for (const s of ['Quote for Acme', 'Scope', 'Bold intro', 'first item', 'Website', 'Hosting (yearly)', 'Total'])
      expect(text).toContain(s);
    expect(text).not.toContain('**');
    expect(text).toMatch(/1,180/); // 1000 + 18% VAT
    expect(text).toContain('Draft · not signed');
    expect(text).toContain('Page 1 of 1');
  });

  it('adds the signature and a certificate page once signed', async () => {
    const bytes = await renderIdocPdf(
      sample({
        signed: {
          sha256: 'a'.repeat(64),
          drawing: 'M10 60 C 60 10, 120 110, 200 60 S 320 20, 380 70',
          typed: false,
          summary: ['✓ Website — ₪1,000'],
          evidence: {
            at: '2026-10-18T10:00:00.000Z',
            ip: '203.0.113.9',
            user_agent: 'test',
            signer: { name: 'Dana Levi', email: 'dana@example.com', role: 'CEO' },
            verified_by: 'email_code',
            document: { kind: 'idoc', id: 'd', version: 2, sha256: 'a'.repeat(64) },
            consents: [{ key: 'c1', text: 'I agree to the terms', checked: true }],
          },
        },
      }),
    );
    const { text, pages } = await pdfText(bytes);
    expect(pages).toBe(2);
    expect(text).toContain('Signature certificate');
    expect(text).toContain('Dana Levi');
    expect(text).toContain('203.0.113.9');
    expect(text).toContain('a'.repeat(40));
    expect(text).not.toContain('not signed');
  });

  it('lays Hebrew out right to left, with mixed numbers and brackets in order', async () => {
    expect(visualLine('סה"כ (₪ 5,900)', true)).toBe('(5,900 ₪) כ"הס');
    expect(visualLine('Hello', false)).toBe('Hello');
    const bytes = await renderIdocPdf(
      sample({
        language: 'he',
        sections: [sec({ kind: 'text', id: 't', title: 'היקף העבודה', body: 'בניית אתר עבור Acme בעלות 1,000 ש"ח' })],
      }),
    );
    const { text } = await pdfText(bytes);
    // Drawn in visual order (checked above); pdf.js reads a right-to-left line back as its characters reversed.
    const ok = (s: string) => text.includes(s) || text.includes([...s].reverse().join(''));
    expect(ok('היקף העבודה')).toBe(true);
    expect(ok('בניית אתר עבור Acme בעלות 1,000 ש"ח')).toBe(true);
    expect(ok('טיוטה · לא נחתם')).toBe(true);
  });

  it('never cuts a row between pages, and stops at the page cap with a clear error', async () => {
    const many = Array.from({ length: 120 }, (_, i) => row(`r${i}`, `Row ${i} ${'word '.repeat(12)}`, 10, true));
    const lines = sec({ kind: 'lines', id: 'l', title: 'Rows', mode: 'fixed' }, { rows: many });
    const bytes = await renderIdocPdf(sample({ sections: [lines] }));
    const { pages, text } = await pdfText(bytes);
    expect(pages).toBeGreaterThan(2);
    for (let i = 0; i < 120; i += 17) expect(text).toContain(`Row ${i} word`);
    await expect(renderIdocPdf(sample({ sections: [lines], maxPages: 2 }))).rejects.toMatchObject({
      code: 'payload_too_large',
      message: 'idoc_pdf_too_large',
    });
  });

  it('leaves out characters the font cannot draw and applies the theme', async () => {
    const theme = { ...emptyIdocTheme(), paper: '#162026', text: '#f2f5f4', header: '#3a1f5d' };
    const bytes = await renderIdocPdf(
      sample({ theme, sections: [sec({ kind: 'text', id: 't', body: 'Party 🎉 time ✨ now' })] }),
    );
    const { text } = await pdfText(bytes);
    expect(text).toContain('Party time now');
  });

  it('reads Markdown into plain blocks', () => {
    expect(
      markdownBlocks('# Title\nline one\nline two\n\n1. first\n- [link](https://x.y) **b**\n---\n> quote'),
    ).toEqual([
      { kind: 'h', text: 'Title' },
      { kind: 'p', text: 'line one line two' },
      { kind: 'li', text: 'first', marker: '1.' },
      { kind: 'li', text: 'link b', marker: '•' },
      { kind: 'hr', text: '' },
      { kind: 'quote', text: 'quote' },
    ]);
  });

  it('names the file safely', () => {
    expect(idocPdfFileName('Quote: Acme / 2026', 3, true)).toBe('Quote Acme 2026-v3-signed.pdf');
  });
});
