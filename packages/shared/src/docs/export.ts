// SPDX-License-Identifier: AGPL-3.0-only
import { openMark as openRichMark, type RichMark, type RichNode } from '../rich';
import { firstStrongDir, type Locale } from '../i18n';
import { CALLOUT_TONES, docPlainText } from './content';
import { isId } from '../ids';

/**
 * A doc's content (its ProseMirror JSON, M8 ד3) as HTML and Markdown — export, print-to-PDF and previews. Like
 * `rich.ts` this is an allowlist: every text is escaped, unknown nodes keep only their text, unknown marks and
 * attributes are dropped, links must be http(s) / mailto, and nothing from the browser is passed through.
 * Pure — the API renders exports with it and the tests check it.
 */
export type DocExportLinks = {
  /** A (short-lived) URL for an image / file of the doc; null leaves its name only. */
  assetUrl?: (assetId: string) => string | null;
  /** The app URL of an item / board / doc a doc links to or embeds; null leaves the name only. */
  entityUrl?: (kind: 'item' | 'board' | 'doc', id: string, boardId?: string) => string | null;
};

const MAX_DEPTH = 48;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safeHref = (href: unknown): string | null => {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) && h.length <= 4000 ? h : null;
};
/** URLs our callbacks produce: absolute http(s) only (an app link or a signed storage link). */
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) && u.length <= 4000 ? u : null);

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
/** An id from a node's attributes — only a well-formed one reaches a link (S-99); anything else is ''. */
const idOf = (v: unknown) => (typeof v === 'string' && isId(v) ? v : '');
const int = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

const tone = (v: unknown) => ((CALLOUT_TONES as readonly string[]).includes(String(v)) ? String(v) : 'info');

// ---------------------------------------------------------------- HTML

/** The shared mark table, with links that stay in place (an exported document opens no tabs). */
const openMark = (m: RichMark) => openRichMark(m, { blank: false });

const anchor = (url: string | null, inner: string, cls?: string) =>
  url
    ? `<a href="${escapeHtml(url)}"${cls ? ` class="${cls}"` : ''} rel="noopener noreferrer">${inner}</a>`
    : cls
      ? `<span class="${cls}">${inner}</span>`
      : inner;

const html = (n: RichNode, links: DocExportLinks, depth: number): string => {
  if (depth > MAX_DEPTH) return '';
  const kids = () => (n.content ?? []).map((c) => html(c, links, depth + 1)).join('');
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'doc':
      return kids();
    case 'text': {
      const marks = (n.marks ?? []).map(openMark).filter((m): m is [string, string] => !!m);
      return (
        marks.map((m) => m[0]).join('') +
        escapeHtml(n.text ?? '') +
        marks
          .map((m) => m[1])
          .reverse()
          .join('')
      );
    }
    case 'paragraph':
      return `<p>${kids()}</p>`;
    case 'heading': {
      const level = int(a.level, 1, 3) ?? 2;
      return `<h${level}>${kids()}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${kids()}</ul>`;
    case 'orderedList': {
      const start = int(a.start, 2, 99999);
      return `${start ? `<ol start="${start}">` : '<ol>'}${kids()}</ol>`;
    }
    case 'listItem':
      return `<li>${kids()}</li>`;
    case 'taskList':
      return `<ul class="tasks">${kids()}</ul>`;
    case 'taskItem': {
      const checked = a.checked === true;
      return `<li class="task" data-checked="${checked}"><input type="checkbox" disabled${checked ? ' checked' : ''}><div>${kids()}</div></li>`;
    }
    case 'blockquote':
      return `<blockquote>${kids()}</blockquote>`;
    case 'codeBlock':
      return `<pre dir="ltr"><code>${kids()}</code></pre>`;
    case 'horizontalRule':
      return '<hr>';
    case 'hardBreak':
      return '<br>';
    case 'table':
      return `<table><tbody>${kids()}</tbody></table>`;
    case 'tableRow':
      return `<tr>${kids()}</tr>`;
    case 'tableHeader':
    case 'tableCell': {
      const tag = n.type === 'tableHeader' ? 'th' : 'td';
      const colspan = int(a.colspan, 2, 50);
      const rowspan = int(a.rowspan, 2, 500);
      return `<${tag}${colspan ? ` colspan="${colspan}"` : ''}${rowspan ? ` rowspan="${rowspan}"` : ''}>${kids()}</${tag}>`;
    }
    case 'callout': {
      const emoji = str(a.emoji, 8);
      return `<div class="callout callout-${tone(a.tone)}">${emoji ? `<span class="callout-emoji">${escapeHtml(emoji)}</span>` : ''}<div>${kids()}</div></div>`;
    }
    case 'details':
      return `<details open>${kids()}</details>`;
    case 'detailsSummary':
      return `<summary>${kids()}</summary>`;
    case 'detailsContent':
      return `<div>${kids()}</div>`;
    case 'columns':
      return `<div class="columns">${kids()}</div>`;
    case 'column':
      return `<div class="column">${kids()}</div>`;
    case 'image': {
      const id = idOf(a.asset_id);
      const alt = str(a.alt, 255);
      const url = id ? safeUrl(links.assetUrl?.(id)) : null;
      return url
        ? `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"></figure>`
        : `<p class="missing">[${escapeHtml(alt || 'image')}]</p>`;
    }
    case 'fileBlock': {
      const id = idOf(a.asset_id);
      const name = str(a.name, 255) || 'file';
      return `<p class="file">📎 ${anchor(id ? safeUrl(links.assetUrl?.(id)) : null, escapeHtml(name))}</p>`;
    }
    case 'mention':
      return `<span class="mention">@${escapeHtml(str(a.label, 120))}</span>`;
    case 'entityLink': {
      const kind = a.kind === 'board' || a.kind === 'doc' ? a.kind : 'item';
      const url = safeUrl(links.entityUrl?.(kind, idOf(a.id), idOf(a.board_id) || undefined));
      return anchor(url, escapeHtml(str(a.label, 255)), 'entity');
    }
    case 'boardEmbed': {
      const url = safeUrl(links.entityUrl?.('board', idOf(a.board_id)));
      return `<p class="embed">📋 ${anchor(url, escapeHtml(str(a.label, 255) || 'board'))}</p>`;
    }
    case 'itemEmbed': {
      const url = safeUrl(links.entityUrl?.('item', idOf(a.item_id), idOf(a.board_id) || undefined));
      return `<p class="embed">▣ ${anchor(url, escapeHtml(str(a.label, 255) || 'item'))}</p>`;
    }
    default:
      // Not on the allowlist: its text only.
      return kids();
  }
};

/** The doc's body as safe HTML. */
export const docToHtml = (doc: RichNode | null | undefined, links: DocExportLinks = {}): string =>
  doc ? html(doc, links, 0) : '';

const PAGE_CSS = `
:root{color-scheme:light}
body{font-family:Rubik,Heebo,Arial,sans-serif;color:#13221f;max-width:820px;margin:32px auto;padding:0 24px;line-height:1.65;font-size:15px}
h1.title{font-size:30px;margin:0 0 20px}
h1{font-size:26px}h2{font-size:21px}h3{font-size:17px}
blockquote{border-inline-start:3px solid #d5e2de;margin:12px 0;padding:2px 14px;color:#33524b}
pre{background:#f1f6f4;border-radius:8px;padding:12px;overflow:auto;direction:ltr;text-align:left}
code{font-family:Consolas,Menlo,monospace;font-size:13px}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #d5e2de;padding:6px 8px;vertical-align:top}th{background:#f1f6f4}
ul.tasks{list-style:none;padding-inline-start:4px}li.task{display:flex;gap:8px;align-items:flex-start}li.task>div>p{margin:0}
.callout{display:flex;gap:10px;border-radius:10px;padding:10px 14px;margin:12px 0}
.callout-info{background:#e5f4ff}.callout-ok{background:#e6f7ef}.callout-warn{background:#fff4e0}.callout-danger{background:#ffe9ec}
.columns{display:flex;gap:24px}.column{flex:1;min-width:0}
.mention,.entity{color:#2e6b57;font-weight:500}
figure{margin:12px 0}img{max-width:100%;border-radius:8px}
.missing,.embed,.file{color:#33524b}
@media print{body{margin:0;max-width:none}a{color:inherit}}
`;

/** A whole HTML document (download, or printed to PDF by the browser): title + body, with print styles. */
/**
 * The exported page's direction and language: the doc's own (the first strong letter of its text, else of its
 * title), else the reader's language. Never a fixed language — an English doc exports left-to-right.
 */
export const docExportDirection = (
  doc: RichNode | null | undefined,
  title: string,
  fallback: Locale,
): { dir: 'rtl' | 'ltr'; lang: Locale } => {
  const dir = firstStrongDir(docPlainText(doc, 2000)) ?? firstStrongDir(title);
  if (!dir) return { dir: fallback === 'he' ? 'rtl' : 'ltr', lang: fallback };
  const fallbackDir = fallback === 'he' ? 'rtl' : 'ltr';
  return { dir, lang: dir === fallbackDir ? fallback : dir === 'rtl' ? 'he' : 'en' };
};

export const docExportDocument = (opts: { title: string; bodyHtml: string; dir?: 'rtl' | 'ltr'; lang?: string }) =>
  `<!doctype html>\n<html lang="${escapeHtml(opts.lang ?? 'he')}" dir="${opts.dir ?? 'rtl'}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)}</title>` +
  `<style>${PAGE_CSS}</style></head><body><h1 class="title">${escapeHtml(opts.title)}</h1>${opts.bodyHtml}</body></html>\n`;

// ---------------------------------------------------------------- Markdown

/** Characters that would start Markdown syntax inside a text run. */
const mdEscape = (s: string) => s.replace(/([\\`*_[\]<>|~])/g, '\\$1');

const mdMarks = (n: RichNode): string => {
  let text = mdEscape(n.text ?? '');
  if (!text.trim()) return text;
  const marks = new Set((n.marks ?? []).map((m) => m.type));
  if (marks.has('code')) text = `\`${(n.text ?? '').replace(/`/g, "'")}\``;
  if (marks.has('bold')) text = `**${text}**`;
  if (marks.has('italic')) text = `*${text}*`;
  if (marks.has('strike')) text = `~~${text}~~`;
  const link = (n.marks ?? []).find((m) => m.type === 'link');
  const href = link ? safeHref(link.attrs?.href) : null;
  if (href) text = `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
  return text;
};

const mdLink = (label: string, url: string | null) =>
  url ? `[${mdEscape(label)}](${url.replace(/[()\s]/g, encodeURIComponent)})` : mdEscape(label);

/** The inline content of a block, on one line (hard breaks become `<br>`-free line breaks). */
const mdInline = (nodes: RichNode[] | undefined, links: DocExportLinks): string =>
  (nodes ?? [])
    .map((c) => {
      const a = c.attrs ?? {};
      switch (c.type) {
        case 'text':
          return mdMarks(c);
        case 'hardBreak':
          return '  \n';
        case 'mention':
          return `@${mdEscape(str(a.label, 120))}`;
        case 'entityLink': {
          const kind = a.kind === 'board' || a.kind === 'doc' ? a.kind : 'item';
          return mdLink(str(a.label, 255), safeUrl(links.entityUrl?.(kind, idOf(a.id), idOf(a.board_id) || undefined)));
        }
        default:
          return mdInline(c.content, links);
      }
    })
    .join('');

const indent = (text: string, pad: string) =>
  text
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n');

const mdBlocks = (nodes: RichNode[] | undefined, links: DocExportLinks, depth: number): string =>
  (nodes ?? [])
    .map((n) => md(n, links, depth))
    .filter((b) => b !== '')
    .join('\n\n');

const mdTable = (n: RichNode, links: DocExportLinks): string => {
  const rows = (n.content ?? []).map((r) =>
    (r.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((b) => mdInline(b.content, links))
        .join(' ')
        .replace(/\n/g, ' ')
        .trim(),
    ),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]!), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
};

const md = (n: RichNode, links: DocExportLinks, depth: number): string => {
  if (depth > MAX_DEPTH) return '';
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'doc':
      return mdBlocks(n.content, links, depth + 1);
    case 'paragraph':
      return mdInline(n.content, links);
    case 'heading':
      return `${'#'.repeat(int(a.level, 1, 3) ?? 2)} ${mdInline(n.content, links)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = int(a.start, 1, 99999) ?? 1;
      return (n.content ?? [])
        .map((li, i) => {
          const bullet =
            n.type === 'orderedList'
              ? `${start + i}.`
              : n.type === 'taskList'
                ? `- [${li.attrs?.checked === true ? 'x' : ' '}]`
                : '-';
          const body = (li.content ?? [])
            .map((c) => md(c, links, depth + 1))
            .filter(Boolean)
            .join('\n');
          return `${bullet} ${indent(body, ' '.repeat(bullet.length + 1))}`;
        })
        .join('\n');
    }
    case 'blockquote':
      return mdBlocks(n.content, links, depth + 1)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'codeBlock': {
      const code = (n.content ?? []).map((c) => c.text ?? '').join('');
      const lang = str(a.language, 20).replace(/[^\w+-]/g, '');
      return `\`\`\`${lang}\n${code.replace(/```/g, '``​`')}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return mdTable(n, links);
    case 'callout': {
      const emoji = str(a.emoji, 8);
      const body = mdBlocks(n.content, links, depth + 1);
      return (emoji ? `${emoji} ${body}` : body)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    }
    case 'details':
    case 'columns':
    case 'column':
    case 'detailsContent':
      return mdBlocks(n.content, links, depth + 1);
    case 'detailsSummary':
      return `**${mdInline(n.content, links)}**`;
    case 'image': {
      const id = idOf(a.asset_id);
      const url = id ? safeUrl(links.assetUrl?.(id)) : null;
      const alt = mdEscape(str(a.alt, 255) || 'image');
      return url ? `![${alt}](${url.replace(/[()\s]/g, encodeURIComponent)})` : `[${alt}]`;
    }
    case 'fileBlock': {
      const id = idOf(a.asset_id);
      return `📎 ${mdLink(str(a.name, 255) || 'file', id ? safeUrl(links.assetUrl?.(id)) : null)}`;
    }
    case 'boardEmbed':
      return `📋 ${mdLink(str(a.label, 255) || 'board', safeUrl(links.entityUrl?.('board', idOf(a.board_id))))}`;
    case 'itemEmbed':
      return `▣ ${mdLink(
        str(a.label, 255) || 'item',
        safeUrl(links.entityUrl?.('item', idOf(a.item_id), idOf(a.board_id) || undefined)),
      )}`;
    default:
      return n.content?.some((c) => c.type === 'text')
        ? mdInline(n.content, links)
        : mdBlocks(n.content, links, depth + 1);
  }
};

/** The doc as Markdown (GitHub flavour: task lists, pipe tables), headed by its title. */
export const docToMarkdown = (doc: RichNode | null | undefined, links: DocExportLinks = {}, title?: string) => {
  const body = doc ? md(doc, links, 0) : '';
  return `${title ? `# ${mdEscape(title)}\n\n` : ''}${body}`.trimEnd() + '\n';
};
