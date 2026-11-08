// SPDX-License-Identifier: AGPL-3.0-only
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { RichMark, RichNode } from '@bines/shared';

/**
 * an incoming message's HTML → the update's document (the editor's JSON). Nothing of the sender's markup
 * is kept: only nodes the update renderer knows come out (paragraphs, headings, lists, quotes, code, data tables,
 * images, links and the text marks), so the stored HTML is the shared allowlist's (rich.ts) as for any update.
 * Scripts, styles, forms, hidden text (a newsletter's preview line) and, in a reply, the quoted earlier message go;
 * layout tables (most newsletters) become plain blocks; a long bare link shows as a short label.
 */
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export type MailImage = { src: string; alt: string; width: number | null; height: number | null };
export type MailHtmlOptions = {
  /** An `<img>` → the image node's attributes (its `src` is what the update stores), or null to leave it out. */
  image: (img: MailImage) => { src: string; alt: string; width?: number | null } | null;
  /** The text a long bare link shows instead of its address ("link"). */
  linkLabel: string;
  /** A reply: drop the quoted earlier message (Gmail, Outlook, Apple Mail, Thunderbird, Yahoo markup). */
  stripQuotes: boolean;
  /** Visible characters kept; past them the rest is left out and `cut` is set. */
  maxChars: number;
};

/** Bare links longer than this show as the label. */
const LONG_LINK = 40;
const MAX_NEST = 8;
const MAX_TABLE_COLS = 20;
const MAX_TABLE_ROWS = 300;

const DROP = new Set([
  'head',
  'script',
  'style',
  'title',
  'meta',
  'link',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'source',
  'track',
  'map',
  'area',
  'base',
  'dialog',
]);
const INLINE_MARK: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
  tt: 'code',
  kbd: 'code',
  samp: 'code',
  mark: 'highlight',
};
const BLOCK = new Set([
  'html',
  'body',
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'center',
  'address',
  'figure',
  'figcaption',
  'dl',
  'dd',
  'dt',
  'details',
  'summary',
  'fieldset',
  'legend',
  'caption',
]);

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;
const styleOf = (el: Element) => (attr(el, 'style') ?? '').toLowerCase().replace(/\s+/g, '');
const classOf = (el: Element) => ` ${(attr(el, 'class') ?? '').toLowerCase()} `;
const isElement = (n: Node): n is Element => 'tagName' in n;
const childrenOf = (n: Node): Node[] => ('childNodes' in n ? n.childNodes : []);
/** <template> keeps its children apart. */
const contentOf = (el: Element): Node[] => el.childNodes;

/** Hidden in the mail client: a preview line, a spacer, an Outlook-only part. */
const hidden = (el: Element) => {
  if (el.attrs.some((a) => a.name === 'hidden')) return true;
  const s = styleOf(el);
  return (
    /(^|;)display:none/.test(s) ||
    /(^|;)visibility:hidden/.test(s) ||
    /(^|;)mso-hide:all/.test(s) ||
    /(^|;)opacity:0(;|$)/.test(s) ||
    (/(^|;)max-height:0(px)?(;|$)/.test(s) && /overflow:hidden/.test(s))
  );
};

/** The quoted earlier message of a reply: dropped (`stop`: everything after it is the quote too). */
const quote = (el: Element): 'drop' | 'stop' | null => {
  const id = (attr(el, 'id') ?? '').toLowerCase();
  if (id === 'divrplyfwdmsg' || id === 'appendonsend' || id.startsWith('mail-editor-reference-message-container'))
    return 'stop';
  if (el.tagName === 'blockquote' && (attr(el, 'type') ?? '').toLowerCase() === 'cite') return 'drop';
  const c = classOf(el);
  if (/ (gmail_quote|gmail_extra|yahoo_quoted|moz-cite-prefix|protonmail_quote) /.test(c)) return 'drop';
  return null;
};

/** Marks a style attribute adds (bold / italic / underline written as CSS). */
const styleMarks = (el: Element): string[] => {
  const s = styleOf(el);
  if (!s) return [];
  const out: string[] = [];
  if (/(^|;)font-weight:(bold|bolder|[6-9]00)/.test(s)) out.push('bold');
  if (/(^|;)font-style:italic/.test(s)) out.push('italic');
  if (/(^|;)text-decoration(-line)?:[^;]*underline/.test(s)) out.push('underline');
  return out;
};

const safeHref = (href: string | null) => {
  const h = (href ?? '').trim();
  return /^(https?:\/\/|mailto:)/i.test(h) && h.length <= 2000 ? h : null;
};

const withMark = (marks: RichMark[], type: string, attrs?: Record<string, unknown>): RichMark[] =>
  marks.some((m) => m.type === type) ? marks : [...marks, attrs ? { type, attrs } : { type }];

/** Invisible characters newsletters pad their preview line with, and non-breaking spaces. */
const clean = (s: string) => s.replace(/[\u200b-\u200d\u2060\ufeff\u00ad]|\u034f/g, '').replace(/\u00a0/g, ' ');

type Ctx = { blocks: RichNode[]; inline: RichNode[] };
type State = { chars: number; cut: boolean; stopped: boolean; opts: MailHtmlOptions };

const fresh = (): Ctx => ({ blocks: [], inline: [] });

/** Text with its bare links as links (a long one as the label). */
const textNodes = (text: string, marks: RichMark[], st: State): RichNode[] => {
  const out: RichNode[] = [];
  const push = (t: string, m: RichMark[]) => {
    if (!t) return;
    const room = st.opts.maxChars - st.chars;
    if (room <= 0) {
      st.cut = true;
      st.stopped = true;
      return;
    }
    const kept = t.length > room ? t.slice(0, room) : t;
    if (kept.length < t.length) {
      st.cut = true;
      st.stopped = true;
    }
    st.chars += kept.length;
    out.push(m.length ? { type: 'text', text: kept, marks: m } : { type: 'text', text: kept });
  };
  if (marks.some((m) => m.type === 'link')) {
    push(text, marks);
    return out;
  }
  let at = 0;
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    push(text.slice(at, m.index), marks);
    push(url.length > LONG_LINK ? st.opts.linkLabel : url, withMark(marks, 'link', { href: url }));
    at = m.index + url.length;
  }
  push(text.slice(at), marks);
  return out;
};

const sameMarks = (a?: RichMark[], b?: RichMark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** A run of inline nodes → a tidy paragraph's content: merged texts, single spaces, no edge spaces. */
const tidyInline = (nodes: RichNode[]): RichNode[] => {
  const merged: RichNode[] = [];
  for (const n of nodes) {
    const last = merged[merged.length - 1];
    if (n.type === 'text' && last?.type === 'text' && sameMarks(last.marks, n.marks))
      merged[merged.length - 1] = { ...last, text: `${last.text}${n.text}` };
    else merged.push(n);
  }
  const out = merged.map((n) => (n.type === 'text' ? { ...n, text: n.text!.replace(/ {2,}/g, ' ') } : n));
  // No space at the start, the end, or around a line break.
  for (let i = 0; i < out.length; i++) {
    const n = out[i]!;
    if (n.type !== 'text') continue;
    let text = n.text!;
    if (i === 0 || out[i - 1]!.type === 'hardBreak') text = text.replace(/^ +/, '');
    if (i === out.length - 1 || out[i + 1]!.type === 'hardBreak') text = text.replace(/ +$/, '');
    out[i] = { ...n, text };
  }
  const kept = out.filter((n) => n.type !== 'text' || n.text);
  // Leading / trailing / repeated line breaks are spacing, not content.
  while (kept[0]?.type === 'hardBreak') kept.shift();
  while (kept[kept.length - 1]?.type === 'hardBreak') kept.pop();
  return kept.filter(
    (n, i) => !(n.type === 'hardBreak' && kept[i - 1]?.type === 'hardBreak' && kept[i - 2]?.type === 'hardBreak'),
  );
};

const flush = (ctx: Ctx) => {
  const content = tidyInline(ctx.inline);
  ctx.inline = [];
  if (content.some((n) => n.type === 'text')) ctx.blocks.push({ type: 'paragraph', content });
};

/** A context's blocks, its open inline run as the last paragraph. */
const blocksOf = (ctx: Ctx) => {
  flush(ctx);
  return ctx.blocks;
};

const textOf = (nodes: Node[]): string =>
  nodes
    .map((n) => (n.nodeName === '#text' ? (n as { value: string }).value : isElement(n) ? textOf(contentOf(n)) : ''))
    .join('');

const num = (v: string | null) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The rows of a table (its own, not a nested table's) and their cells. */
const rowsOf = (table: Element): Element[][] => {
  const rows: Element[][] = [];
  const visit = (el: Element) => {
    for (const c of el.childNodes) {
      if (!isElement(c)) continue;
      if (c.tagName === 'tr')
        rows.push(c.childNodes.filter(isElement).filter((x) => x.tagName === 'td' || x.tagName === 'th'));
      else if (c.tagName === 'thead' || c.tagName === 'tbody' || c.tagName === 'tfoot') visit(c);
    }
  };
  visit(table);
  return rows;
};

const hasTag = (nodes: Node[], tags: Set<string>): boolean =>
  nodes.some((n) => isElement(n) && (tags.has(n.tagName) || hasTag(contentOf(n), tags)));
const LAYOUT_INSIDE = new Set(['table', 'img', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote']);

/**
 * A data table (rows of values) is kept as a table; a layout table — one column, one row, role="presentation", or
 * cells holding tables, images, headings or lists (a newsletter's grid) — is read as blocks, cell by cell.
 */
const isDataTable = (table: Element, rows: Element[][]) => {
  const role = (attr(table, 'role') ?? '').toLowerCase();
  if (role === 'presentation' || role === 'none') return false;
  const cols = Math.max(0, ...rows.map((r) => r.length));
  if (rows.length < 2 || cols < 2 || cols > MAX_TABLE_COLS || rows.length > MAX_TABLE_ROWS) return false;
  return !rows.some((r) => r.some((c) => hasTag(c.childNodes, LAYOUT_INSIDE)));
};

const walk = (nodes: Node[], marks: RichMark[], ctx: Ctx, st: State, depth: number) => {
  for (const n of nodes) {
    if (st.stopped) return;
    if (n.nodeName === '#text') {
      const raw = clean((n as { value: string }).value).replace(/[\t\n\r ]+/g, ' ');
      if (raw) ctx.inline.push(...textNodes(raw, marks, st));
      continue;
    }
    if (!isElement(n)) continue;
    element(n, marks, ctx, st, depth);
  }
};

const element = (el: Element, marks: RichMark[], ctx: Ctx, st: State, depth: number) => {
  const tag = el.tagName;
  if (DROP.has(tag) || hidden(el)) return;
  if (st.opts.stripQuotes) {
    const q = quote(el);
    if (q === 'stop') st.stopped = true;
    if (q) return;
  }
  let m = marks;
  for (const s of styleMarks(el)) m = withMark(m, s);
  const kids = contentOf(el);

  if (tag === 'br') {
    ctx.inline.push({ type: 'hardBreak' });
    return;
  }
  if (tag === 'img') {
    const node = st.opts.image({
      src: attr(el, 'src') ?? '',
      alt: clean(attr(el, 'alt') ?? '').trim(),
      width: num(attr(el, 'width')),
      height: num(attr(el, 'height')),
    });
    if (!node) return;
    flush(ctx);
    ctx.blocks.push({
      type: 'image',
      attrs: { src: node.src, alt: node.alt, ...(node.width ? { width: node.width } : {}) },
    });
    return;
  }
  if (tag === 'hr') {
    flush(ctx);
    ctx.blocks.push({ type: 'horizontalRule' });
    return;
  }
  if (tag === 'a' || INLINE_MARK[tag] || !(BLOCK.has(tag) || STRUCTURE.has(tag))) {
    // Inline (and any element we do not know): its content joins the current run.
    if (INLINE_MARK[tag]) m = withMark(m, INLINE_MARK[tag]);
    const href = tag === 'a' ? safeHref(attr(el, 'href')) : null;
    if (href) m = withMark(m, 'link', { href });
    const sub = fresh();
    walk(kids, m, sub, st, depth);
    if (href && !sub.blocks.length) {
      // A link written as its own long address shows as the label.
      const text = sub.inline
        .map((x) => x.text ?? '')
        .join('')
        .trim();
      if (/^(https?:\/\/|www\.)\S+$/i.test(text) && text.length > LONG_LINK)
        sub.inline = [{ type: 'text', text: st.opts.linkLabel, marks: m }];
    }
    if (sub.blocks.length) {
      flush(ctx);
      ctx.blocks.push(...sub.blocks);
    }
    ctx.inline.push(...sub.inline);
    return;
  }
  flush(ctx);
  structure(el, tag, kids, m, ctx, st, depth);
  flush(ctx);
};

/** Elements that make their own block structure. */
const STRUCTURE = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

const structure = (el: Element, tag: string, kids: Node[], m: RichMark[], ctx: Ctx, st: State, depth: number) => {
  const deep = depth >= MAX_NEST;
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const sub = fresh();
    walk(kids, m, sub, st, depth + 1);
    const parts = blocksOf(sub);
    const inline = parts.flatMap((b, i) =>
      b.type === 'paragraph' ? [...(i ? [{ type: 'hardBreak' }] : []), ...(b.content ?? [])] : [],
    );
    const content = tidyInline(inline);
    if (content.some((n) => n.type === 'text'))
      ctx.blocks.push({ type: 'heading', attrs: { level: Math.min(Number(heading[1]), 3) }, content });
    ctx.blocks.push(...parts.filter((b) => b.type !== 'paragraph'));
    return;
  }
  if ((tag === 'ul' || tag === 'ol') && !deep) {
    const items: RichNode[] = [];
    for (const c of kids) {
      if (st.stopped) break;
      if (!isElement(c) && !(c.nodeName === '#text' && (c as { value: string }).value.trim())) continue;
      const sub = fresh();
      walk(isElement(c) && c.tagName === 'li' ? contentOf(c) : [c], m, sub, st, depth + 1);
      const content = blocksOf(sub);
      if (content.length) items.push({ type: 'listItem', content });
    }
    if (items.length) ctx.blocks.push({ type: tag === 'ol' ? 'orderedList' : 'bulletList', content: items });
    return;
  }
  if (tag === 'blockquote' && !deep) {
    const sub = fresh();
    walk(kids, m, sub, st, depth + 1);
    const content = blocksOf(sub);
    if (content.length) ctx.blocks.push({ type: 'blockquote', content });
    return;
  }
  if (tag === 'pre') {
    const text = clean(textOf(kids))
      .replace(/\r\n?/g, '\n')
      .replace(/^\n|\n+$/g, '');
    const nodes = textNodes(text, [], st).map(({ marks: _drop, ...t }) => t);
    if (nodes.length) ctx.blocks.push({ type: 'codeBlock', content: nodes });
    return;
  }
  if (tag === 'table') {
    const rows = rowsOf(el);
    if (!deep && isDataTable(el, rows)) {
      const tableRows = rows.map((r) => ({
        type: 'tableRow',
        content: r.map((c) => {
          const sub = fresh();
          walk(c.childNodes, m, sub, st, depth + 1);
          const content = blocksOf(sub);
          return {
            type: c.tagName === 'th' ? 'tableHeader' : 'tableCell',
            content: content.length ? content : [{ type: 'paragraph' }],
          };
        }),
      }));
      ctx.blocks.push({ type: 'table', content: tableRows });
      return;
    }
    for (const r of rows)
      for (const c of r) {
        if (st.stopped) return;
        walk(c.childNodes, m, ctx, st, depth + 1);
        flush(ctx);
      }
    return;
  }
  // Everything else (a block, a list item outside a list, table parts outside a table): its content as blocks.
  walk(kids, m, ctx, st, depth + 1);
};

/** The message's HTML → the update's blocks, and whether text was left out (`maxChars`). */
export const mailHtmlToDoc = (html: string, opts: MailHtmlOptions): { blocks: RichNode[]; cut: boolean } => {
  const st: State = { chars: 0, cut: false, stopped: false, opts };
  const ctx = fresh();
  walk(childrenOf(parse(html)), [], ctx, st, 0);
  return { blocks: blocksOf(ctx), cut: st.cut };
};

/** A plain-text message → blocks: blank lines split paragraphs, single breaks stay, bare links become links. */
export const mailTextToDoc = (
  text: string,
  opts: Pick<MailHtmlOptions, 'linkLabel' | 'maxChars'>,
): { blocks: RichNode[]; cut: boolean } => {
  const st: State = { chars: 0, cut: false, stopped: false, opts: { ...opts, image: () => null, stripQuotes: false } };
  const blocks: RichNode[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    if (st.stopped) break;
    const content = para
      .trim()
      .split('\n')
      .flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...textNodes(line, [], st)]);
    if (content.some((n) => n.type === 'text')) blocks.push({ type: 'paragraph', content });
  }
  return { blocks, cut: st.cut };
};
