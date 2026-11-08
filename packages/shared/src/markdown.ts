// SPDX-License-Identifier: AGPL-3.0-only
import { Lexer, type Token, type Tokens } from 'marked';
import type { RichMark, RichNode } from './rich';

/**
 * Markdown → the rich-text document of updates (sync-ai, product fix list: "AI answers show as raw Markdown").
 *
 * AI writers (agents, the assistant, MCP apps) answer in Markdown. Instead of a second HTML path, Markdown is turned
 * into the same ProseMirror JSON the update editor writes, and that JSON goes through the one allowlist renderer
 * (`renderRichDoc`, rich.ts). So:
 * - nothing from the text ever becomes raw HTML (HTML in the Markdown stays visible text);
 * - links pass `safeHref` (http(s) / mailto only) and open with rel="noopener noreferrer";
 * - an agent's reply is stored as a normal formatted update (body_json), editable and searchable like any other.
 *
 * `marked` (MIT, no dependencies, actively maintained, GFM tables / task lists built in) is used only as a lexer —
 * its HTML renderer is never called, which is why no HTML sanitizer (DOMPurify) is needed.
 * A mention keeps the API's plain-text form `[@Name](user:<ULID>)` and becomes a mention chip.
 */

const MAX_MARKDOWN = 40_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** marked keeps character references as written; the document holds the characters themselves. */
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ref.toLowerCase()] ?? m;
  });

/**
 * Opt-in (kb-import): the knowledge center's importer resolves `![alt](path)` to one of its image nodes
 * (`{type: 'image', attrs: {src, alt}}`), or null to keep the old behaviour (the alt text linked to the address).
 * Images are blocks: one inside a paragraph splits it; inside a heading or a table cell it stays text.
 */
export type MarkdownOptions = {
  /** `title`: the image's Markdown title (`![alt](src "title")`), e.g. its width. */
  image?: (href: string, alt: string, title: string | null) => RichNode | null;
  /** Most characters read (default 40,000 — chat answers; articles may be longer). */
  maxLength?: number;
};

const text = (value: string, marks: RichMark[]): RichNode | null =>
  value ? { type: 'text', text: value, ...(marks.length ? { marks: [...marks] } : {}) } : null;

const inline = (tokens: Token[] | undefined, marks: RichMark[] = [], o: MarkdownOptions = {}): RichNode[] => {
  const out: RichNode[] = [];
  const push = (n: RichNode | null) => {
    if (n) out.push(n);
  };
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case 'text': {
        const t = tok as Tokens.Text;
        if (t.tokens?.length) out.push(...inline(t.tokens, marks, o));
        else push(text(decode(t.text), marks));
        break;
      }
      case 'escape':
        push(text(decode((tok as Tokens.Escape).text), marks));
        break;
      case 'strong':
        out.push(...inline((tok as Tokens.Strong).tokens, [...marks, { type: 'bold' }], o));
        break;
      case 'em':
        out.push(...inline((tok as Tokens.Em).tokens, [...marks, { type: 'italic' }], o));
        break;
      case 'del':
        out.push(...inline((tok as Tokens.Del).tokens, [...marks, { type: 'strike' }], o));
        break;
      case 'codespan':
        push(text(decode((tok as Tokens.Codespan).text), [...marks, { type: 'code' }]));
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'link': {
        const l = tok as Tokens.Link;
        const mention = /^user:(.+)$/.exec(l.href);
        if (mention && ULID.test(mention[1]!)) {
          out.push({ type: 'mention', attrs: { id: mention[1], label: l.text.replace(/^@/, '').slice(0, 120) } });
          break;
        }
        // The renderer drops a link mark whose address is not http(s) / mailto — its text stays.
        out.push(...inline(l.tokens, [...marks, { type: 'link', attrs: { href: decode(l.href) } }], o));
        break;
      }
      case 'image': {
        // No images from text (unless the caller resolves them): the alt text, linked to the address.
        const i = tok as Tokens.Image;
        const node = o.image?.(decode(i.href), decode(i.text ?? ''), i.title ? decode(i.title) : null);
        if (node) {
          out.push(node);
          break;
        }
        push(text(decode(i.text || i.href), [...marks, { type: 'link', attrs: { href: decode(i.href) } }]));
        break;
      }
      case 'html':
        // Raw HTML is shown as the text it is, never interpreted.
        push(text((tok as Tokens.HTML).text, marks));
        break;
      case 'checkbox':
        break;
      default:
        if ('text' in tok && typeof tok.text === 'string') push(text(decode(tok.text), marks));
    }
  }
  return out;
};

const paragraph = (content: RichNode[]): RichNode => ({ type: 'paragraph', ...(content.length ? { content } : {}) });

/** An image is a block: a paragraph holding images becomes paragraphs and images (blank text around them dropped). */
const lift = (content: RichNode[]): RichNode[] => {
  if (!content.some((n) => n.type === 'image')) return [paragraph(content)];
  const out: RichNode[] = [];
  let run: RichNode[] = [];
  const flush = () => {
    while (run[0]?.type === 'hardBreak' || (run[0]?.type === 'text' && !run[0].text?.trim())) run.shift();
    while (run.at(-1)?.type === 'hardBreak' || (run.at(-1)?.type === 'text' && !run.at(-1)!.text?.trim())) run.pop();
    if (run.length) out.push(paragraph(run));
    run = [];
  };
  for (const n of content) {
    if (n.type === 'image') {
      flush();
      out.push(n);
    } else run.push(n);
  }
  flush();
  return out;
};

/** Where images may not stand (headings, table cells): their alt text. */
const noImages = (content: RichNode[]): RichNode[] =>
  content.map((n) => (n.type === 'image' ? text(String(n.attrs?.alt ?? ''), []) : n)).filter((n): n is RichNode => !!n);

const blocks = (tokens: Token[] | undefined, o: MarkdownOptions = {}): RichNode[] => {
  const out: RichNode[] = [];
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'heading': {
        const h = tok as Tokens.Heading;
        out.push({
          type: 'heading',
          attrs: { level: h.depth <= 2 ? 2 : 3 },
          content: noImages(inline(h.tokens, [], o)),
        });
        break;
      }
      case 'paragraph':
        out.push(...lift(inline((tok as Tokens.Paragraph).tokens, [], o)));
        break;
      case 'text': {
        // A tight list item's text.
        const t = tok as Tokens.Text;
        out.push(...lift(t.tokens?.length ? inline(t.tokens, [], o) : inline([t], [], o)));
        break;
      }
      case 'blockquote':
        out.push({ type: 'blockquote', content: blocks((tok as Tokens.Blockquote).tokens, o) });
        break;
      case 'code': {
        const c = tok as Tokens.Code;
        out.push({ type: 'codeBlock', content: c.text ? [{ type: 'text', text: c.text }] : [] });
        break;
      }
      case 'hr':
        out.push({ type: 'horizontalRule' });
        break;
      case 'list': {
        const l = tok as Tokens.List;
        const task = l.items.some((i) => i.task);
        const items = l.items.map((i): RichNode => ({
          type: task ? 'taskItem' : 'listItem',
          ...(task ? { attrs: { checked: !!i.checked } } : {}),
          content: (() => {
            const c = blocks(
              i.tokens.filter((x) => x.type !== 'checkbox'),
              o,
            );
            if (c[0]?.type === 'image') c.unshift(paragraph([])); // a list item starts with a paragraph
            return c.length ? c : [paragraph([])];
          })(),
        }));
        const start = typeof l.start === 'number' && l.start > 1 ? { attrs: { start: l.start } } : {};
        out.push({
          type: task ? 'taskList' : l.ordered ? 'orderedList' : 'bulletList',
          ...(l.ordered && !task ? start : {}),
          content: items,
        });
        break;
      }
      case 'table': {
        const t = tok as Tokens.Table;
        const cell = (c: Tokens.TableCell, header: boolean): RichNode => ({
          type: header ? 'tableHeader' : 'tableCell',
          ...(c.align ? { attrs: { align: c.align } } : {}),
          content: noImages(inline(c.tokens, [], o)),
        });
        out.push({
          type: 'table',
          content: [
            { type: 'tableRow', content: t.header.map((c) => cell(c, true)) },
            ...t.rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell(c, false)) })),
          ],
        });
        break;
      }
      case 'html':
        out.push(paragraph(inline([tok])));
        break;
      default:
        if ('text' in tok && typeof tok.text === 'string' && tok.text) out.push(paragraph(inline([tok])));
    }
  }
  return out;
};

/**
 * Markdown (GFM: headings, bold / italic / strike, lists, task lists, tables, code, quotes, links; a single line
 * break is a line break, as in chat) → a rich document for `renderRichDoc` / an update's `body_json`.
 */
export const markdownToRichDoc = (markdown: string, opts: MarkdownOptions = {}): RichNode => {
  const src = markdown.slice(0, opts.maxLength ?? MAX_MARKDOWN).replace(/\r\n?/g, '\n');
  const content = blocks(Lexer.lex(src, { gfm: true, breaks: true }), opts);
  return { type: 'doc', content: content.length ? content : [paragraph([])] };
};

// ---------------------------------------------------------------------------------------------------------------
// Rich document → Markdown (kb-import: the knowledge center's export, read back by `markdownToRichDoc`).
// ---------------------------------------------------------------------------------------------------------------

export type RichToMarkdownOptions = {
  /** An image node → its Markdown (`![alt](images/x.png)`), or '' to drop it. */
  image?: (attrs: Record<string, unknown>) => string;
};

/** Characters that would start Markdown syntax inside plain text. */
const escapeMd = (s: string) => s.replace(/([\\`*_[\]#<>|~])/g, '\\$1');

const wrapMark = (m: RichMark, s: string) => {
  switch (m.type) {
    case 'bold':
      return `**${s}**`;
    case 'italic':
      return `_${s}_`;
    case 'strike':
      return `~~${s}~~`;
    case 'link': {
      const href = typeof m.attrs?.href === 'string' ? m.attrs.href : '';
      return /^(https?:\/\/|mailto:)/i.test(href) ? `[${s}](${href.replace(/[()\s]/g, encodeURIComponent)})` : s;
    }
    default:
      return s;
  }
};

const MARK_ORDER = ['strike', 'italic', 'bold', 'link'];

const inlineMd = (nodes: RichNode[] | undefined, o: RichToMarkdownOptions): string =>
  (nodes ?? [])
    .map((n): string => {
      if (n.type === 'hardBreak') return '\\\n';
      if (n.type === 'image') return o.image?.(n.attrs ?? {}) ?? '';
      if (n.type === 'mention') return `@${String(n.attrs?.label ?? '')}`;
      if (n.type !== 'text') return inlineMd(n.content, o);
      const raw = n.text ?? '';
      const marks = n.marks ?? [];
      if (marks.some((m) => m.type === 'code')) {
        const fence = raw.includes('`') ? '``' : '`';
        return marks.filter((m) => m.type === 'link').reduce((acc, m) => wrapMark(m, acc), `${fence}${raw}${fence}`);
      }
      // Marks around leading / trailing spaces do not parse back: the spaces stay outside.
      const lead = /^\s*/.exec(raw)![0];
      const trail = /\s*$/.exec(raw.slice(lead.length))![0];
      const core = raw.slice(lead.length, raw.length - trail.length);
      if (!core) return raw;
      const sorted = [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
      return lead + sorted.reduce((acc, m) => wrapMark(m, acc), escapeMd(core)) + trail;
    })
    .join('');

const indent = (s: string, pad: string) =>
  s
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n');

const blockMd = (n: RichNode, o: RichToMarkdownOptions): string => {
  const kids = (list = n.content) => (list ?? []).map((c) => blockMd(c, o)).filter((x) => x !== '');
  switch (n.type) {
    case 'doc':
      return kids().join('\n\n');
    case 'paragraph':
      // A paragraph that starts like a list item stays a paragraph.
      return inlineMd(n.content, o)
        .replace(/^(\d+)([.)])(\s)/, '$1\\$2$3')
        .replace(/^([-+])(\s)/, '\\$1$2');
    case 'heading':
      return `${n.attrs?.level === 3 ? '###' : '##'} ${inlineMd(n.content, o)}`;
    case 'image':
      return o.image?.(n.attrs ?? {}) ?? '';
    case 'horizontalRule':
      return '---';
    case 'codeBlock': {
      const code = (n.content ?? []).map((c) => c.text ?? '').join('');
      const fence = code.includes('```') ? '~~~~' : '```';
      return `${fence}\n${code}\n${fence}`;
    }
    case 'blockquote':
      return kids()
        .join('\n\n')
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = Number(n.attrs?.start);
      let i = Number.isInteger(start) && start > 1 ? start : 1;
      return (n.content ?? [])
        .map((item) => {
          const marker =
            n.type === 'orderedList'
              ? `${i++}.`
              : n.type === 'taskList'
                ? `- [${item.attrs?.checked === true ? 'x' : ' '}]`
                : '-';
          const body = kids(item.content).join('\n\n');
          return `${marker} ${indent(body, ' '.repeat(n.type === 'bulletList' ? 2 : marker.length + 1))}`;
        })
        .join('\n');
    }
    case 'table': {
      const rows = (n.content ?? []).map((r) =>
        (r.content ?? []).map((c) =>
          (c.content ?? [])
            .map((p) => (p.type === 'paragraph' ? inlineMd(p.content, o) : inlineMd([p], o)))
            .join(' ')
            .replace(/\\\n/g, ' ')
            .replace(/\n/g, ' ')
            .replace(/\|/g, '\\|'),
        ),
      );
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
      return [line(rows[0]!), line(Array.from({ length: width }, () => '---')), ...rows.slice(1).map(line)].join('\n');
    }
    default:
      // Unknown containers keep their content.
      return n.content?.length ? kids().join('\n\n') : '';
  }
};

/** A rich document → GFM Markdown that `markdownToRichDoc` reads back (the knowledge center's export). */
export const richDocToMarkdown = (doc: RichNode, opts: RichToMarkdownOptions = {}): string =>
  `${blockMd(doc, opts).trim()}\n`;
