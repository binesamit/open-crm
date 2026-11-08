// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
import { degrees, PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import {
  AppError,
  effectiveSelection,
  formatIdocMoney,
  idocInkOn,
  idocRowTotal,
  idocTotalLookup,
  isEmptyIdocSection,
  mergeIdocText,
  type ConsentEvidence,
  type IdocSectionOf,
  type IdocSectionKind,
  type IdocTheme,
  type IdocTotals,
  type PublicIdocQuestion,
  type PublicIdocSection,
} from '@bines/shared';

/**
 * The PDF of an interactive document (product owner: "allow downloading the document as PDF"). One file for
 * the client and the team alike: every section as the page shows it, the current choices and totals, the document's
 * look (its colours), and — once signed — the signature and a certificate page; until then every page says it is
 * not signed. Drawn here in pure JS (pdf-lib + an embedded OFL font, no browser, no system dependency):
 *  - Hebrew / mixed text: laid out in logical order, wrapped, then each line reordered with the Unicode bidi
 *    algorithm (bidi-js), brackets mirrored. Hebrew needs no shaping.
 *  - Page breaks never cut a row, a table row, a field or a question; long text breaks between lines.
 *  - Bounded: at most IDOC_PDF_MAX_PAGES pages and IDOC_PDF_DEADLINE_MS of work, a few at a time, each with a clear
 *    error — the layout is synchronous, so the bounds keep the event loop responsive.
 * Characters the font lacks (emoji, rare symbols) are left out rather than drawn as boxes.
 */

export const IDOC_PDF_MAX_PAGES = 60;
export const IDOC_PDF_DEADLINE_MS = 8000;
export const IDOC_PDF_MAX_BYTES = 12 * 1024 * 1024;
const MAX_PARALLEL = 3;

// ——— the font ———

/** Where the font is, from the sources (tsx) and from the bundle (dist/index.js) alike. */
export const idocFontCandidates = (base: string | URL = import.meta.url) =>
  [
    process.env.IDOC_FONT_PATH,
    // src/modules/idocs/idocs.pdf.ts → apps/api/assets
    fileURLToPath(new URL('../../../assets/fonts/Rubik-Regular.ttf', base)),
    // dist/index.js → apps/api/assets
    fileURLToPath(new URL('../assets/fonts/Rubik-Regular.ttf', base)),
    resolve(process.cwd(), 'assets/fonts/Rubik-Regular.ttf'),
    resolve(process.cwd(), 'apps/api/assets/fonts/Rubik-Regular.ttf'),
  ].filter((x): x is string => !!x);

export const idocFontPath = (base?: string | URL) => idocFontCandidates(base).find((p) => existsSync(p)) ?? null;

let fontBytes: Uint8Array | null = null;
const loadFont = () => {
  if (fontBytes) return fontBytes;
  const path = idocFontPath();
  if (!path) throw new AppError('unavailable', 'idoc_pdf_font_missing');
  fontBytes = readFileSync(path);
  return fontBytes;
};

// ——— text ———

const bidi = bidiFactory();
const RTL_CHARS = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;

/** One line in logical order → the order its characters are drawn left to right. */
export const visualLine = (s: string, rtl: boolean): string => {
  if (!s || (!rtl && !RTL_CHARS.test(s))) return s;
  const levels = bidi.getEmbeddingLevels(s, rtl ? 'rtl' : 'ltr');
  const out = s.split('').map((c, i) => ((levels.levels[i]! & 1) === 1 ? (bidi.getMirroredCharacter(c) ?? c) : c));
  for (const seg of bidi.getReorderSegments(s, levels)) {
    const [a, b] = seg as [number, number];
    out.splice(a, b - a + 1, ...out.slice(a, b + 1).reverse());
  }
  return out.join('');
};

/**
 * fontkit (inside pdf-lib) lays a string out right to left — reversing its glyphs — when the first letter it meets
 * belongs to a right-to-left script. The text here is already in visual order, so such a string is handed over
 * reversed and comes out as drawn. (Common characters — digits, spaces, punctuation, ₪ — decide nothing.)
 */
const FIRST_LETTER = /\p{L}/u;
const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
export const forFontkit = (vis: string) => {
  const first = FIRST_LETTER.exec(vis)?.[0];
  return first && RTL_SCRIPT.test(first) ? vis.split('').reverse().join('') : vis;
};

/** Markdown → plain blocks (headings, paragraphs, list items, quotes); inline marks dropped. */
type MdBlock = { kind: 'h' | 'p' | 'li' | 'quote' | 'hr'; text: string; marker?: string };
const inlineMd = (s: string) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

export const markdownBlocks = (md: string): MdBlock[] => {
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: inlineMd(para.join(' ')) });
    para = [];
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if (!line.trim()) flush();
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ kind: 'hr', text: '' });
    } else if ((m = /^\s*#{1,6}\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'h', text: inlineMd(m[1]!.replace(/\s#+\s*$/, '')) });
    } else if ((m = /^\s*[-*+•]\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'li', text: inlineMd(m[1]!), marker: '•' });
    } else if ((m = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'li', text: inlineMd(m[2]!), marker: `${m[1]}.` });
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flush();
      out.push({ kind: 'quote', text: inlineMd(m[1]!) });
    } else if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) {
      // a table's separator row
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      out.push({
        kind: 'p',
        text: inlineMd(
          line
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim())
            .join(' · '),
        ),
      });
    } else para.push(line.trim());
  }
  flush();
  return out;
};

// ——— colours ———

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const mix = (a: string, b: string, t: number): RGB => {
  const x = hexRgb(a);
  const y = hexRgb(b);
  return rgb(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
};
const color = (hex: string) => {
  const [r, g, b] = hexRgb(hex);
  return rgb(r, g, b);
};

type Palette = {
  paper: string;
  text: string;
  muted: string;
  accent: string;
  header: string;
  headerInk: string;
  accentInk: string;
};
/** The document's colours as the page applies them (theme.ts layers, already merged), with the built-in look below. */
export const pdfPalette = (t: IdocTheme): Palette => {
  const paper = t.paper || '#ffffff';
  const text = t.text || '#13221f';
  const accent = t.accent || '#0d3b35';
  const header = t.header || t.accent || '#0d3b35';
  return {
    paper,
    text,
    muted: t.muted || '#5d756f',
    accent,
    header,
    headerInk: idocInkOn(header),
    accentInk: idocInkOn(accent),
  };
};

// ——— the input ———

export type IdocPdfSigned = {
  evidence: ConsentEvidence;
  sha256: string;
  /** SVG path data (viewBox 0 0 400 120), or null for a typed signature / an approval. */
  drawing: string | null;
  typed: boolean;
  summary: string[];
};

export type IdocPdfInput = {
  docName: string;
  version: number;
  accountName: string;
  language: 'he' | 'en';
  timezone: string;
  theme: IdocTheme;
  sections: PublicIdocSection[];
  totals: IdocTotals;
  questions?: PublicIdocQuestion[];
  logo?: { bytes: Uint8Array; mime: string } | null;
  signed?: IdocPdfSigned | null;
  /** Tests: smaller bounds. */
  maxPages?: number;
  deadlineMs?: number;
};

const LABELS = {
  he: {
    unsigned: 'טיוטה · לא נחתם',
    draft: 'טיוטה',
    page: (n: number, of: number) => `עמוד ${n} מתוך ${of}`,
    cert: 'תעודת חתימה',
    signer: 'חותם',
    verified: 'זהות אומתה',
    by: { session: 'משתמש מחובר', email_code: 'קוד חד-פעמי למייל', sms_code: 'קוד חד-פעמי ב-SMS', none: 'ללא אימות' },
    at: 'מועד (שעון שרת)',
    source: 'מקור',
    what: 'מה נחתם',
    consents: 'הסכמות',
    hash: 'טביעת מסמך',
    name: 'שם',
    signature: 'חתימה',
    date: 'תאריך',
    signedBy: 'נחתם על ידי',
    typed: 'חתימה בהקלדת השם',
    discount: 'הנחה',
    beforeVat: 'לפני מע"מ',
    vat: 'מע"מ',
    total: 'סה"כ',
    recurring: 'חוזר',
    thirdParty: 'צד שלישי',
    month: 'חודש',
    year: 'שנה',
    requires: 'דורש',
    reply: 'תשובה',
    toc: 'תוכן עניינים',
  },
  en: {
    unsigned: 'Draft · not signed',
    draft: 'Draft',
    page: (n: number, of: number) => `Page ${n} of ${of}`,
    cert: 'Signature certificate',
    signer: 'Signer',
    verified: 'Identity check',
    by: {
      session: 'Signed-in user',
      email_code: 'One-time code by email',
      sms_code: 'One-time code by SMS',
      none: 'None',
    },
    at: 'Time (server)',
    source: 'Source',
    what: 'What was signed',
    consents: 'Consents',
    hash: 'Document fingerprint',
    name: 'Name',
    signature: 'Signature',
    date: 'Date',
    signedBy: 'Signed by',
    typed: 'Signed by typing the name',
    discount: 'Discount',
    beforeVat: 'Before VAT',
    vat: 'VAT',
    total: 'Total',
    recurring: 'Recurring',
    thirdParty: 'Third party',
    month: 'mo',
    year: 'yr',
    requires: 'Needs',
    reply: 'Reply',
    toc: 'Contents',
  },
};

// ——— the layout ———

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const TOP = 54;
const BOTTOM = 58;

type Align = 'start' | 'end' | 'center';
type TextOpts = { size?: number; color?: RGB; x0?: number; w?: number; align?: Align; dir?: 'auto' | 'ltr' };

class Layout {
  readonly doc: PDFDocument;
  readonly font: PDFFont;
  readonly pal: Palette;
  readonly rtl: boolean;
  readonly pages: PDFPage[] = [];
  readonly chars: Set<number>;
  page!: PDFPage;
  y = 0;
  readonly left = MARGIN;
  readonly right = PAGE_W - MARGIN;
  readonly width = PAGE_W - 2 * MARGIN;
  private readonly deadline: number;

  constructor(
    doc: PDFDocument,
    font: PDFFont,
    pal: Palette,
    rtl: boolean,
    private readonly maxPages: number,
    deadlineMs: number,
  ) {
    this.doc = doc;
    this.font = font;
    this.pal = pal;
    this.rtl = rtl;
    this.chars = new Set(font.getCharacterSet());
    this.deadline = Date.now() + deadlineMs;
  }

  check() {
    if (Date.now() > this.deadline) throw new AppError('payload_too_large', 'idoc_pdf_too_large', { reason: 'time' });
  }

  newPage() {
    this.check();
    if (this.pages.length >= this.maxPages)
      throw new AppError('payload_too_large', 'idoc_pdf_too_large', { reason: 'pages', max_pages: this.maxPages });
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    if (this.pal.paper.toLowerCase() !== '#ffffff')
      this.page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: color(this.pal.paper) });
    this.y = PAGE_H - TOP;
  }

  get top() {
    return PAGE_H - TOP;
  }
  get atTop() {
    return this.y >= this.top - 0.5;
  }
  /** Room left on this page. */
  get room() {
    return this.y - BOTTOM;
  }
  get usable() {
    return PAGE_H - TOP - BOTTOM;
  }
  /** Starts a new page unless `h` fits on this one. */
  ensure(h: number) {
    if (h > this.room && !this.atTop) this.newPage();
  }
  gap(h: number) {
    if (this.atTop) return;
    if (h >= this.room) this.newPage();
    else this.y -= h;
  }

  /** Keeps only what the font can draw. */
  clean(s: string) {
    let out = '';
    for (const ch of s.replace(/[\t\u00a0\u2028\u2029]/g, ' ')) {
      const cp = ch.codePointAt(0)!;
      if (this.chars.has(cp)) out += ch;
      else if (cp === 0x2010 || cp === 0x2011 || cp === 0x2212) out += '-';
      else if (cp === 0x2018 || cp === 0x2019) out += "'";
      else if (cp === 0x201c || cp === 0x201d || cp === 0x05f4) out += '"';
      else if (cp === 0x05f3) out += "'";
    }
    return out;
  }

  widthOf(s: string, size: number) {
    return this.font.widthOfTextAtSize(s, size);
  }

  /** Text (one paragraph, logical order) → its lines at a width. Words longer than a line are cut. */
  wrap(text: string, w: number, size: number): string[] {
    const out: string[] = [];
    for (const para of this.clean(text).split('\n')) {
      const words = para.split(/ +/).filter(Boolean);
      if (!words.length) {
        out.push('');
        continue;
      }
      let line = '';
      for (let word of words) {
        const next = line ? `${line} ${word}` : word;
        if (this.widthOf(next, size) <= w) {
          line = next;
          continue;
        }
        if (line) out.push(line);
        line = '';
        while (this.widthOf(word, size) > w) {
          let n = word.length - 1;
          while (n > 1 && this.widthOf(word.slice(0, n), size) > w) n--;
          out.push(word.slice(0, n));
          word = word.slice(n);
        }
        line = word;
      }
      if (line) out.push(line);
    }
    return out;
  }

  /** The physical left edge of a logical box (x0 from the start side). */
  boxLeft(x0: number, w: number) {
    return this.rtl ? this.right - x0 - w : this.left + x0;
  }

  /** Draws one line with its top at `top`. */
  drawLine(line: string, top: number, o: TextOpts = {}) {
    const size = o.size ?? 10.5;
    const x0 = o.x0 ?? 0;
    const w = o.w ?? this.width - x0;
    const vis = visualLine(line, o.dir === 'ltr' ? false : this.rtl);
    if (!vis.trim()) return;
    const tw = this.widthOf(vis, size);
    const bl = this.boxLeft(x0, w);
    const align = o.align ?? 'start';
    const startRight = this.rtl;
    const x = align === 'center' ? bl + (w - tw) / 2 : (align === 'start') === startRight ? bl + w - tw : bl;
    this.page.drawText(forFontkit(vis), {
      x,
      y: top - size * 0.95,
      size,
      font: this.font,
      color: o.color ?? color(this.pal.text),
    });
  }

  lineHeight(size: number) {
    return size * 1.5;
  }

  /** A paragraph that may break between pages, one line at a time. */
  para(text: string, o: TextOpts & { before?: (top: number, lh: number, first: boolean) => void } = {}) {
    const size = o.size ?? 10.5;
    const x0 = o.x0 ?? 0;
    const w = o.w ?? this.width - x0;
    const lh = this.lineHeight(size);
    this.wrap(text, w, size).forEach((line, i) => {
      this.ensure(lh);
      o.before?.(this.y, lh, i === 0);
      this.drawLine(line, this.y, { ...o, size, x0, w });
      this.y -= lh;
    });
  }

  rule(top: number, c: RGB, thickness = 0.6, x0 = 0, w = this.width) {
    const bl = this.boxLeft(x0, w);
    this.page.drawLine({ start: { x: bl, y: top }, end: { x: bl + w, y: top }, thickness, color: c });
  }

  /** A tick box (or a round one) at a logical x, its top at `top`. */
  box(x0: number, top: number, on: boolean, round = false) {
    const s = 9;
    const bl = this.boxLeft(x0, s);
    const accent = color(this.pal.accent);
    if (round) {
      this.page.drawCircle({ x: bl + s / 2, y: top - s / 2, size: s / 2, borderColor: accent, borderWidth: 1 });
      if (on) this.page.drawCircle({ x: bl + s / 2, y: top - s / 2, size: s / 4, color: accent });
      return;
    }
    this.page.drawRectangle({
      x: bl,
      y: top - s,
      width: s,
      height: s,
      borderColor: on ? accent : color(this.pal.muted),
      borderWidth: 0.9,
      color: on ? accent : undefined,
    });
    if (on) {
      const ink = color(this.pal.accentInk);
      this.page.drawLine({
        start: { x: bl + 2, y: top - 4.6 },
        end: { x: bl + 3.8, y: top - 6.8 },
        thickness: 1.2,
        color: ink,
      });
      this.page.drawLine({
        start: { x: bl + 3.8, y: top - 6.8 },
        end: { x: bl + 7.2, y: top - 2.4 },
        thickness: 1.2,
        color: ink,
      });
    }
  }
}

// ——— sections ———

type Of<K extends IdocSectionKind> = IdocSectionOf<K> & { data: PublicIdocSection['data'] };

type Ctx = {
  L: Layout;
  input: IdocPdfInput;
  T: (typeof LABELS)['he'];
  money: (n: number | null) => string;
  muted: RGB;
  text: RGB;
  accent: RGB;
  line: RGB;
  soft: RGB;
  logo: PDFImage | null;
};

const sectionTitle = (c: Ctx, title: string) => {
  if (!title.trim()) return;
  const size = 14;
  const lines = c.L.wrap(title, c.L.width, size);
  // Kept with what follows: a title never ends a page alone.
  c.L.gap(14);
  c.L.ensure(lines.length * c.L.lineHeight(size) + 40);
  for (const line of lines) {
    c.L.drawLine(line, c.L.y, { size, color: c.accent });
    c.L.y -= c.L.lineHeight(size);
  }
  c.L.y -= 2;
};

const markdown = (c: Ctx, md: string, o: { numbered?: boolean; style?: string; x0?: number; w?: number } = {}) => {
  const merged = mergeIdocText(md, idocTotalLookup(c.input.totals, c.input.language));
  const x0 = o.x0 ?? 0;
  const w = o.w ?? c.L.width - x0;
  const quiet = o.style === 'muted';
  const bar = o.style === 'callout' || o.style === 'quote';
  const inset = bar ? 12 : 0;
  const size = quiet ? 9.5 : 10.5;
  const ink = quiet ? c.muted : c.text;
  const drawBar = (top: number, lh: number) => {
    if (!bar) return;
    const bl = c.L.boxLeft(x0, 2.5);
    c.L.page.drawRectangle({ x: bl, y: top - lh, width: 2.5, height: lh, color: c.accent, opacity: 0.7 });
  };
  let n = 0;
  for (const b of markdownBlocks(merged)) {
    if (b.kind === 'hr') {
      c.L.gap(6);
      c.L.ensure(8);
      c.L.rule(c.L.y, c.line, 0.6, x0, w);
      c.L.y -= 8;
      continue;
    }
    if (b.kind === 'h') {
      c.L.gap(4);
      c.L.ensure(40);
      c.L.para(b.text, { size: 12, color: c.text, x0: x0 + inset, w: w - inset, before: drawBar });
      continue;
    }
    if (b.kind === 'li') {
      const ind = inset + 14;
      c.L.para(b.text, {
        size,
        color: ink,
        x0: x0 + ind,
        w: w - ind,
        before: (top, lh, first) => {
          drawBar(top, lh);
          if (first) c.L.drawLine(b.marker ?? '•', top, { size, color: c.muted, x0: x0 + inset, w: 12 });
        },
      });
      continue;
    }
    const text = b.kind === 'p' && o.numbered ? `${++n}. ${b.text}` : b.text;
    c.L.para(text, { size, color: b.kind === 'quote' ? c.muted : ink, x0: x0 + inset, w: w - inset, before: drawBar });
    c.L.y -= size * 0.5;
  }
};

/** Label / value pairs, a few per row; each row kept whole. */
const fieldGrid = (c: Ctx, fields: { label: string; value: string }[], cols: number) => {
  const gap = 16;
  const cw = (c.L.width - gap * (cols - 1)) / cols;
  for (let i = 0; i < fields.length; i += cols) {
    const row = fields.slice(i, i + cols).map((f) => ({
      label: c.L.wrap(f.label, cw, 8.5),
      value: c.L.wrap(f.value || '—', cw, 10.5),
    }));
    const h = Math.max(...row.map((r) => r.label.length * 12.75 + r.value.length * 15.75)) + 8;
    c.L.ensure(h);
    const top = c.L.y;
    row.forEach((r, j) => {
      let y = top;
      const x0 = j * (cw + gap);
      for (const l of r.label) {
        c.L.drawLine(l, y, { size: 8.5, color: c.muted, x0, w: cw });
        y -= 12.75;
      }
      for (const l of r.value) {
        c.L.drawLine(l, y, { size: 10.5, x0, w: cw });
        y -= 15.75;
      }
    });
    c.L.y = top - h;
  }
};

const header = (c: Ctx, s: Of<'header'>) => {
  const { L } = c;
  const fullBleed = L.pages.length === 1 && L.atTop;
  const pad = 22;
  const logoH = c.logo && s.show_logo ? 40 : 0;
  const logoW = c.logo && logoH ? Math.min(140, (c.logo.width / c.logo.height) * logoH) : 0;
  const textW = L.width - (logoW ? logoW + 16 : 0);
  const title = L.wrap(s.title, textW, 22);
  const sub = s.subtitle ? L.wrap(s.subtitle, textW, 11) : [];
  const h = pad * 2 + Math.max(title.length * 30 + sub.length * 16.5, logoH);
  const top = fullBleed ? PAGE_H : L.y;
  if (!fullBleed) L.ensure(h);
  const ink = color(L.pal.headerInk);
  L.page.drawRectangle({
    x: fullBleed ? 0 : L.left,
    y: (fullBleed ? PAGE_H : L.y) - h,
    width: fullBleed ? PAGE_W : L.width,
    height: h,
    color: color(L.pal.header),
  });
  let y = (fullBleed ? PAGE_H : L.y) - pad;
  for (const l of title) {
    L.drawLine(l, y, { size: 22, color: ink, w: textW });
    y -= 30;
  }
  for (const l of sub) {
    L.drawLine(l, y, { size: 11, color: ink, w: textW });
    y -= 16.5;
  }
  if (c.logo && logoH) {
    const bl = L.boxLeft(L.width - logoW, logoW);
    L.page.drawImage(c.logo, { x: bl, y: (fullBleed ? PAGE_H : L.y) - pad - logoH, width: logoW, height: logoH });
  }
  L.y = top - h - 18;
  const fields = (s.data.fields ?? s.fields).filter((f) => f.label || f.value);
  if (fields.length) fieldGrid(c, fields, 3);
};

const rowsSection = (c: Ctx, s: Of<'lines'>) => {
  const { L, T } = c;
  sectionTitle(c, s.title);
  if (s.intro.trim()) markdown(c, s.intro);
  const rows = s.data.rows ?? [];
  const chosen = effectiveSelection(s.mode, rows);
  const priceW = s.show_prices ? 118 : 0;
  const boxW = 18;
  const nameW = L.width - boxW - (priceW ? priceW + 10 : 0);
  const per = s.recurring_period === 'year' ? T.year : T.month;
  for (const r of rows) {
    const on = chosen.has(r.key);
    if (!s.show_unselected && !on) continue;
    const t = idocRowTotal(r);
    const name = L.wrap(r.name, nameW, 11);
    const extra = [
      r.description,
      r.qty !== null ? `${s.unit_label || r.unit || ''} × ${r.qty}`.trim() : '',
      r.requires_names.length ? `${T.requires}: ${r.requires_names.join(', ')}` : '',
    ].filter(Boolean);
    const desc = extra.flatMap((e) => L.wrap(e, nameW, 9));
    const prices = s.show_prices
      ? [t.one_time ? c.money(t.one_time) : '', t.recurring ? `${c.money(t.recurring)}/${per}` : ''].filter(Boolean)
      : [];
    let descLines = desc;
    const pad = 8;
    const max = L.usable - 20;
    let h = pad * 2 + name.length * 16.5 + descLines.length * 13.5;
    if (h > max) {
      descLines = desc.slice(0, Math.max(0, Math.floor((max - pad * 2 - name.length * 16.5) / 13.5) - 1));
      descLines.push('…');
      h = pad * 2 + name.length * 16.5 + descLines.length * 13.5;
    }
    h = Math.max(h, pad * 2 + prices.length * 15);
    L.ensure(h);
    const top = L.y;
    const ink = on ? c.text : c.muted;
    if (s.mode === 'fixed') L.box(0, top - pad - 2, true);
    else L.box(0, top - pad - 2, on, s.mode === 'single');
    let y = top - pad;
    for (const l of name) {
      L.drawLine(l, y, { size: 11, color: ink, x0: boxW, w: nameW });
      y -= 16.5;
    }
    for (const l of descLines) {
      L.drawLine(l, y, { size: 9, color: c.muted, x0: boxW, w: nameW });
      y -= 13.5;
    }
    prices.forEach((p, i) => {
      L.drawLine(p, top - pad - i * 15, {
        size: i ? 9.5 : 11,
        color: i ? c.muted : ink,
        x0: L.width - priceW,
        w: priceW,
        align: 'end',
      });
    });
    L.y = top - h;
    L.rule(L.y, c.line);
  }
  L.y -= 6;
};

const tableSection = (c: Ctx, s: Of<'table'>) => {
  const { L } = c;
  sectionTitle(c, s.title);
  if (s.intro.trim()) markdown(c, s.intro);
  const n = Math.max(s.columns.length, ...s.rows.map((r) => r.length), 1);
  const gap = 8;
  const cw = (L.width - gap * (n - 1)) / n;
  const size = n > 6 ? 8.5 : 9.5;
  const lh = L.lineHeight(size);
  const drawRow = (cells: string[], head: boolean) => {
    const wrapped = Array.from({ length: n }, (_, i) => L.wrap(cells[i] ?? '', cw, size));
    const h = Math.max(1, ...wrapped.map((w) => w.length)) * lh + 10;
    L.ensure(h);
    const top = L.y;
    if (head) L.page.drawRectangle({ x: L.left, y: top - h, width: L.width, height: h, color: c.soft });
    wrapped.forEach((lines, i) => {
      let y = top - 5;
      for (const l of lines) {
        L.drawLine(l, y, {
          size,
          color: head || (s.header_column && i === 0) ? c.muted : c.text,
          x0: i * (cw + gap),
          w: cw,
        });
        y -= lh;
      }
    });
    L.y = top - h;
    L.rule(L.y, c.line);
  };
  if (s.columns.length) drawRow(s.columns, true);
  for (const r of s.rows) drawRow(r, false);
  L.y -= 6;
};

const summarySection = (c: Ctx, s: Of<'summary'>) => {
  const { L, T } = c;
  const t = c.input.totals;
  sectionTitle(c, s.title);
  const rows: { label: string; value: string; total?: boolean }[] = [];
  if (s.show_totals) {
    if (t.discount) rows.push({ label: s.discount?.label || T.discount, value: `- ${c.money(t.discount)}` });
    if (s.show_vat) {
      rows.push({ label: T.beforeVat, value: c.money(t.subtotal) });
      rows.push({ label: `${T.vat} ${t.vat_percent}%`, value: c.money(t.vat) });
    }
    rows.push({ label: T.total, value: c.money(t.grand_total), total: true });
    if (s.show_recurring && t.recurring)
      rows.push({ label: T.recurring, value: `${c.money(t.recurring_total)}/${T.month}` });
    if (s.show_third_party && (t.third_party_one_time || t.third_party_recurring))
      rows.push({
        label: T.thirdParty,
        value: [
          t.third_party_one_time ? c.money(t.third_party_one_time) : '',
          t.third_party_recurring ? `${c.money(t.third_party_recurring)}/${T.month}` : '',
        ]
          .filter(Boolean)
          .join(' + '),
      });
  }
  for (const p of t.schedule) rows.push({ label: `${p.label} (${p.percent}%)`, value: c.money(p.amount) });
  // The totals stay together.
  L.ensure(rows.length * 22 + 10);
  for (const r of rows) {
    const size = r.total ? 13 : 10.5;
    const h = r.total ? 26 : 21;
    L.ensure(h);
    if (r.total) L.rule(L.y, c.accent, 1.4);
    const top = L.y - (r.total ? 6 : 3);
    L.drawLine(r.label, top, { size, color: r.total ? c.text : c.muted, w: L.width - 150 });
    L.drawLine(r.value, top, { size, color: r.total ? c.accent : c.text, x0: L.width - 150, w: 150, align: 'end' });
    L.y -= h;
  }
  L.y -= 6;
};

const inputsSection = (c: Ctx, s: Of<'inputs'>) => {
  sectionTitle(c, s.title);
  if (s.intro.trim()) markdown(c, s.intro);
  const inputs = s.data.inputs ?? [];
  const { L } = c;
  for (const i of inputs) {
    if (i.kind === 'checkbox') {
      const lines = L.wrap(i.label, L.width - 18, 10.5);
      L.ensure(lines.length * 15.75 + 6);
      L.box(0, L.y - 2, i.value === true);
      for (const l of lines) {
        L.drawLine(l, L.y, { x0: 18, w: L.width - 18 });
        L.y -= 15.75;
      }
      L.y -= 6;
    } else fieldGrid(c, [{ label: i.label, value: i.value === null ? '' : String(i.value) }], 1);
  }
};

const signatureSection = (c: Ctx, s: Of<'signature'>) => {
  const { L, T } = c;
  sectionTitle(c, s.title);
  if (s.intro.trim()) markdown(c, s.intro);
  const signed = c.input.signed ?? null;
  const ticked = new Set(signed?.evidence.consents.filter((x) => x.checked).map((x) => x.key) ?? []);
  const consents = signed
    ? signed.evidence.consents
    : s.consents.map((x) => ({ key: x.key, text: x.text, checked: false }));
  for (const x of consents) {
    const lines = L.wrap(mergeIdocText(x.text, idocTotalLookup(c.input.totals, c.input.language)), L.width - 18, 10);
    L.ensure(lines.length * 15 + 6);
    L.box(0, L.y - 2, ticked.has(x.key));
    for (const l of lines) {
      L.drawLine(l, L.y, { size: 10, x0: 18, w: L.width - 18 });
      L.y -= 15;
    }
    L.y -= 4;
  }
  L.gap(8);
  if (signed) {
    const e = signed.evidence;
    L.ensure(130);
    const top = L.y;
    const w = 220;
    if (signed.drawing) {
      const scale = w / 400;
      const bl = L.boxLeft(0, w);
      L.page.drawSvgPath(signed.drawing, {
        x: bl,
        y: top,
        scale,
        borderColor: color(L.pal.text),
        borderWidth: 2.2 / scale,
        borderLineCap: 1,
      });
      L.y = top - 120 * scale;
    } else {
      L.drawLine(e.signer.name, top - 10, { size: 20, color: c.accent, w });
      L.y = top - 44;
    }
    L.rule(L.y, c.line, 0.8, 0, w);
    L.y -= 6;
    L.drawLine(`${T.signedBy}: ${[e.signer.name, e.signer.role].filter(Boolean).join(' · ')}`, L.y, {
      size: 9.5,
      color: c.muted,
      w: L.width,
    });
    L.y -= 14;
    L.drawLine(`${T.date}: ${fmtTime(e.at, c.input)}${signed.typed ? ` · ${T.typed}` : ''}`, L.y, {
      size: 9.5,
      color: c.muted,
    });
    L.y -= 18;
    return;
  }
  // Not signed yet: the lines to sign on.
  const cols = [T.name, s.mode === 'sign' ? T.signature : '', T.date].filter(Boolean);
  const gap = 18;
  const cw = (L.width - gap * (cols.length - 1)) / cols.length;
  L.ensure(56);
  const top = L.y - 34;
  cols.forEach((label, i) => {
    L.rule(top, c.muted, 0.8, i * (cw + gap), cw);
    L.drawLine(label, top - 5, { size: 8.5, color: c.muted, x0: i * (cw + gap), w: cw });
  });
  L.y = top - 26;
};

const fmtTime = (iso: string, input: Pick<IdocPdfInput, 'language' | 'timezone'>) => {
  try {
    return new Intl.DateTimeFormat(input.language === 'he' ? 'he-IL' : 'en-GB', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: input.timezone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
};

const section = (c: Ctx, s: PublicIdocSection) => {
  const { L } = c;
  L.check();
  switch (s.kind) {
    case 'header':
      return header(c, s as Of<'header'>);
    case 'text': {
      const x = s as Of<'text'>;
      sectionTitle(c, x.title);
      markdown(c, x.body, { numbered: x.numbered, style: x.style });
      if (x.body2.trim()) markdown(c, x.body2, { numbered: x.numbered, style: x.style });
      return;
    }
    case 'fields': {
      const x = s as Of<'fields'>;
      sectionTitle(c, x.title);
      return fieldGrid(
        c,
        (x.data.fields ?? x.fields).filter((f) => f.label || f.value),
        x.layout === 'list' ? 1 : 2,
      );
    }
    case 'people': {
      const x = s as Of<'people'>;
      sectionTitle(c, x.title);
      fieldGrid(
        c,
        (x.data.people ?? []).map((p) => ({
          label: p.name,
          value: [x.show_email ? p.email : null, x.show_phone ? p.phone : null].filter(Boolean).join(' · '),
        })),
        2,
      );
      if (x.note.trim()) L.para(x.note, { size: 9.5, color: c.muted });
      return;
    }
    case 'lines':
      return rowsSection(c, s as Of<'lines'>);
    case 'table':
      return tableSection(c, s as Of<'table'>);
    case 'summary':
      return summarySection(c, s as Of<'summary'>);
    case 'inputs':
      return inputsSection(c, s as Of<'inputs'>);
    case 'signature':
      return signatureSection(c, s as Of<'signature'>);
    case 'faq': {
      const x = s as Of<'faq'>;
      sectionTitle(c, x.title);
      for (const f of x.items) {
        const q = L.wrap(f.q, L.width, 11);
        const a = L.wrap(f.a, L.width, 10);
        const h = q.length * 16.5 + a.length * 15 + 8;
        if (h <= L.usable) L.ensure(h);
        L.para(f.q, { size: 11 });
        L.para(f.a, { size: 10, color: c.muted });
        L.y -= 8;
      }
      return;
    }
    case 'timeline': {
      const x = s as Of<'timeline'>;
      sectionTitle(c, x.title);
      for (const d of x.data.dated ?? []) {
        const dates = [d.start, d.end].filter(Boolean).join(' - ');
        const nameW = L.width - 140;
        const name = L.wrap(d.name, nameW, 10.5);
        const desc = d.description ? L.wrap(d.description, nameW, 9) : [];
        const h = name.length * 15.75 + desc.length * 13.5 + 8;
        L.ensure(h);
        const top = L.y;
        L.drawLine(dates, top, { size: 9.5, color: c.muted, x0: L.width - 130, w: 130, align: 'end', dir: 'ltr' });
        let y = top;
        for (const l of name) {
          L.drawLine(l, y, { w: nameW });
          y -= 15.75;
        }
        for (const l of desc) {
          L.drawLine(l, y, { size: 9, color: c.muted, w: nameW });
          y -= 13.5;
        }
        L.y = top - h;
        L.rule(L.y + 3, c.line);
      }
      return;
    }
    case 'media': {
      const x = s as Of<'media'>;
      const files = x.data.files ?? [];
      if (!files.length && !x.caption) return;
      sectionTitle(c, x.title);
      for (const f of files) L.para(`• ${f.name}`, { size: 10 });
      if (x.caption) L.para(x.caption, { size: 9.5, color: c.muted });
      return;
    }
    case 'questions': {
      const x = s as Of<'questions'>;
      const qs = c.input.questions ?? [];
      if (!qs.length) return;
      sectionTitle(c, x.title);
      for (const q of qs) {
        const head = [q.name, q.section_title].filter(Boolean).join(' · ');
        const est = (L.wrap(q.text, L.width, 10).length + q.replies.length * 2 + 1) * 15;
        if (est <= L.usable) L.ensure(est);
        L.para(head, { size: 8.5, color: c.muted });
        L.para(q.text, { size: 10 });
        for (const r of q.replies) {
          L.para(`${r.name || c.T.reply}:`, { size: 8.5, color: c.muted, x0: 16 });
          L.para(r.text, { size: 10, x0: 16 });
        }
        L.y -= 8;
      }
      return;
    }
    case 'toc': {
      const x = s as Of<'toc'>;
      sectionTitle(c, x.title || c.T.toc);
      for (const o of c.input.sections) {
        const title = 'title' in o && typeof o.title === 'string' && o.kind !== 'header' ? o.title.trim() : '';
        if (title) L.para(`• ${title}`, { size: 10 });
      }
      return;
    }
    case 'divider': {
      const x = s as Of<'divider'>;
      if (x.style === 'page_break') {
        if (!L.atTop) L.newPage();
      } else if (x.style === 'space') L.gap(24);
      else {
        L.gap(10);
        L.rule(L.y, c.line);
        L.y -= 10;
      }
      return;
    }
    default:
      // cta: an action on the page, nothing to print.
      return;
  }
};

const certificate = (c: Ctx, signed: IdocPdfSigned) => {
  const { L, T } = c;
  const e = signed.evidence;
  L.newPage();
  L.drawLine(T.cert, L.y, { size: 18, color: c.accent });
  L.y -= 34;
  const row = (label: string, value: string | string[], dir: 'auto' | 'ltr' = 'auto') => {
    const values = Array.isArray(value) ? value : [value];
    const lines = values.flatMap((v) => L.wrap(v || '—', L.width - 150, 10));
    L.ensure(lines.length * 15 + 10);
    const top = L.y;
    L.drawLine(label, top, { size: 9, color: c.muted, w: 140 });
    let y = top;
    for (const l of lines) {
      L.drawLine(l, y, { size: 10, x0: 150, w: L.width - 150, dir });
      y -= 15;
    }
    L.y = y - 8;
    L.rule(L.y + 4, c.line);
  };
  if (signed.drawing) {
    const w = 200;
    const scale = w / 400;
    L.page.drawSvgPath(signed.drawing, {
      x: L.boxLeft(150, w),
      y: L.y,
      scale,
      borderColor: color(L.pal.text),
      borderWidth: 2.2 / scale,
      borderLineCap: 1,
    });
    L.y -= 120 * scale + 10;
  }
  row(T.signer, [[e.signer.name, e.signer.role].filter(Boolean).join(' · '), e.signer.email ?? ''].filter(Boolean));
  row(T.verified, T.by[e.verified_by] ?? e.verified_by);
  row(T.at, [fmtTime(e.at, c.input), e.at], 'ltr');
  row(T.source, [e.ip ?? '', e.user_agent ?? ''].filter(Boolean), 'ltr');
  row(T.what, [`${c.input.docName} · v${c.input.version}`, ...signed.summary.map((x) => x.replace(/^✓\s*/, '+ '))]);
  row(
    T.consents,
    e.consents.map((x) => `${x.checked ? '+' : '-'} ${x.text}`),
  );
  row(T.hash, `SHA-256 ${signed.sha256}`, 'ltr');
};

/** Unsigned mark, page numbers, the document's name — on every page once the page count is known. */
const decorate = (c: Ctx) => {
  const { L, T } = c;
  const n = L.pages.length;
  const unsigned = !c.input.signed;
  L.pages.forEach((page, i) => {
    L.page = page;
    const foot = BOTTOM - 26;
    L.rule(foot + 14, c.line, 0.5);
    L.drawLine(`${c.input.docName} · v${c.input.version}${unsigned ? ` · ${T.unsigned}` : ''}`, foot + 8, {
      size: 8,
      color: c.muted,
      w: L.width - 90,
    });
    L.drawLine(T.page(i + 1, n), foot + 8, { size: 8, color: c.muted, x0: L.width - 90, w: 90, align: 'end' });
    if (unsigned) {
      const mark = visualLine(L.clean(T.draft), L.rtl);
      const size = 96;
      const w = L.widthOf(mark, size);
      const a = Math.PI / 6;
      page.drawText(forFontkit(mark), {
        x: PAGE_W / 2 - (Math.cos(a) * w) / 2,
        y: PAGE_H / 2 - (Math.sin(a) * w) / 2,
        size,
        font: L.font,
        color: c.muted,
        opacity: 0.08,
        rotate: degrees(30),
      });
    }
  });
};

let running = 0;

/** The document as a PDF (bytes). Throws payload_too_large past the page / time bounds, rate_limited when busy. */
export const renderIdocPdf = async (input: IdocPdfInput): Promise<Uint8Array> => {
  if (running >= MAX_PARALLEL) throw new AppError('rate_limited', 'idoc_pdf_busy');
  running++;
  try {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setTitle(input.docName || 'Document');
    doc.setAuthor(input.accountName);
    doc.setProducer('Bines OS');
    doc.setLanguage(input.language === 'he' ? 'he-IL' : 'en');
    // Mirroring is done by the bidi step (visualLine); the font's own right-to-left alternates would undo it.
    const font = await doc.embedFont(loadFont(), { subset: true, features: { rtlm: false, rtla: false } });
    const pal = pdfPalette(input.theme);
    const L = new Layout(
      doc,
      font,
      pal,
      input.language === 'he',
      input.maxPages ?? IDOC_PDF_MAX_PAGES,
      input.deadlineMs ?? IDOC_PDF_DEADLINE_MS,
    );
    let logo: PDFImage | null = null;
    if (input.logo) {
      try {
        if (/png/i.test(input.logo.mime)) logo = await doc.embedPng(input.logo.bytes);
        else if (/jpe?g/i.test(input.logo.mime)) logo = await doc.embedJpg(input.logo.bytes);
      } catch {
        logo = null;
      }
    }
    const c: Ctx = {
      L,
      input,
      T: LABELS[input.language],
      money: (n) => (n === null ? '' : formatIdocMoney(n, input.totals.currency, input.language)),
      text: color(pal.text),
      muted: color(pal.muted),
      accent: color(pal.accent),
      line: mix(pal.text, pal.paper, 0.85),
      soft: mix(pal.accent, pal.paper, 0.92),
      logo,
    };
    L.newPage();
    for (const s of input.sections) {
      if (isEmptyIdocSection(s)) continue;
      section(c, s);
      L.gap(10);
    }
    if (input.signed) certificate(c, input.signed);
    decorate(c);
    L.check();
    const bytes = await doc.save();
    if (bytes.length > IDOC_PDF_MAX_BYTES)
      throw new AppError('payload_too_large', 'idoc_pdf_too_large', { reason: 'size' });
    return bytes;
  } finally {
    running--;
  }
};

/** A file name for the PDF (the document's name, safe for a header). */
export const idocPdfFileName = (docName: string, version: number, signed: boolean) =>
  `${
    Array.from(docName || 'document', (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch))
      .join('')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim()
      .slice(0, 80) || 'document'
  }-v${version}${signed ? '-signed' : ''}.pdf`;
