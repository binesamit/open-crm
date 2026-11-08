// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Rich text for updates and replies (M1.1 #7). The editor (TipTap) sends its ProseMirror JSON; the server
 * renders HTML from it with this allowlist — HTML from the browser is never stored or shown. Unknown nodes
 * keep only their text, unknown marks are dropped, links must be http(s) or mailto.
 */
export const RICH_NODES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'mention',
  // Tables (sync-ai): Markdown from AI writers (agents, the assistant, MCP) may carry GFM tables.
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
] as const;
export const RICH_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight'] as const;

export type RichMark = { type: string; attrs?: Record<string, unknown> };
export type RichNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichNode[];
  text?: string;
  marks?: RichMark[];
};

const MAX_DEPTH = 24;
/**
 * r17reply: the limits were sized for chat lines — 20,000 characters per text node (a whole pasted log
 * in a code block is one node), 5,000 nodes per block and 200 KB of editor JSON (a pasted line is a node, a
 * highlighted token a node with marks — many times the text). A pasted log was refused with a bare 400 the composer
 * never showed. Now the visible text is what is limited (MAX_RICH_TEXT, checked with a clear message by the server
 * and before sending by the composer); the JSON / node caps only stop abuse.
 */
/** Most characters of visible text one update, reply or comment may have (~100 KB — a long pasted log fits). */
export const MAX_RICH_TEXT = 100_000;
/** Largest editor JSON accepted (the request body cap is 5 MB). */
export const MAX_RICH_JSON = 2_000_000;
const MAX_RICH_CHILDREN = 50_000;

const markSchema = z.object({ type: z.string().max(40), attrs: z.record(z.string(), z.unknown()).optional() });
// Recursive via a getter (zod 4), which JSON Schema / OpenAPI generation understands, unlike z.lazy.
export const richNodeSchema = z
  .object({
    type: z.string().max(40),
    attrs: z.record(z.string(), z.unknown()).optional(),
    get content() {
      return z.array(richNodeSchema).max(MAX_RICH_CHILDREN).optional();
    },
    // Looser than MAX_RICH_TEXT on purpose: the service refuses long text with a clear `update_too_long`.
    text: z.string().max(MAX_RICH_JSON).optional(),
    marks: z.array(markSchema).max(20).optional(),
  })
  .meta({ id: 'RichNode' }); // a named component, so OpenAPI emits a $ref instead of recursing forever
/** A whole document; size is capped so a request can't make the renderer do unbounded work. */
export const richDocSchema = richNodeSchema.refine(
  (d) => d.type === 'doc' && JSON.stringify(d).length <= MAX_RICH_JSON,
  `expected a doc of at most ${MAX_RICH_JSON / 1_000_000} MB`,
);

/**
 * Why a document may not be sent, or null when it may: `text` — more than MAX_RICH_TEXT characters of visible text;
 * `size` — more than MAX_RICH_JSON of editor JSON. `limit` is in characters either way (shown to the user).
 */
export const richDocOverLimit = (doc: RichNode): { kind: 'text' | 'size'; limit: number; length: number } | null => {
  const size = JSON.stringify(doc).length;
  if (size > MAX_RICH_JSON) return { kind: 'size', limit: MAX_RICH_JSON, length: size };
  const length = renderRichDoc(doc).text.length;
  return length > MAX_RICH_TEXT ? { kind: 'text', limit: MAX_RICH_TEXT, length } : null;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const safeHref = (href: unknown): string | null => {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) && h.length <= 2000 ? h : null;
};

/**
 * The HTML a text mark opens and closes with; null = a mark that renders nothing (an unsafe link). `blank`: links
 * open in a new tab (the app; a document export keeps them in place). One table for both (duplication #19).
 */
export const openMark = (m: RichMark, { blank = true }: { blank?: boolean } = {}): [string, string] | null => {
  switch (m.type) {
    case 'bold':
      return ['<strong>', '</strong>'];
    case 'italic':
      return ['<em>', '</em>'];
    case 'underline':
      return ['<u>', '</u>'];
    case 'strike':
      return ['<s>', '</s>'];
    case 'code':
      return ['<code>', '</code>'];
    case 'highlight':
      return ['<mark>', '</mark>'];
    case 'link': {
      const href = safeHref(m.attrs?.href);
      return href
        ? [`<a href="${escapeHtml(href)}"${blank ? ' target="_blank"' : ''} rel="noopener noreferrer">`, '</a>']
        : null;
    }
    default:
      return null;
  }
};

/**
 * Opt-in extras of one renderer (the account's content never passes any). `image` (kb-import): the knowledge center's
 * articles may hold `image` nodes `{src: <help asset id>, alt, width?}`; the caller turns an id into the address it
 * is served from, or null to drop the image. Without it an `image` node renders nothing, as before.
 */
export type RichRenderOptions = {
  image?: (attrs: Record<string, unknown>) => { src: string; alt: string; width?: number | null; ref?: string } | null;
};

type Out = { html: string[]; text: string[]; mentions: Set<string>; opts: RichRenderOptions };

const blockText = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock', 'tableRow']);

const renderNode = (n: RichNode, out: Out, depth: number): void => {
  if (depth > MAX_DEPTH) return;
  const children = () => (n.content ?? []).forEach((c) => renderNode(c, out, depth + 1));
  const wrap = (open: string, close: string) => {
    out.html.push(open);
    children();
    out.html.push(close);
  };
  switch (n.type) {
    case 'doc':
      return children();
    case 'text': {
      const text = n.text ?? '';
      out.text.push(text);
      const marks = (n.marks ?? []).map((m) => openMark(m)).filter((m): m is [string, string] => !!m);
      out.html.push(...marks.map((m) => m[0]), escapeHtml(text), ...marks.map((m) => m[1]).reverse());
      return;
    }
    case 'paragraph':
      wrap('<p>', '</p>');
      break;
    case 'heading': {
      const level = n.attrs?.level === 3 ? 3 : 2;
      wrap(`<h${level}>`, `</h${level}>`);
      break;
    }
    case 'bulletList':
      return wrap('<ul>', '</ul>');
    case 'orderedList': {
      const start = Number(n.attrs?.start);
      return wrap(Number.isInteger(start) && start > 1 && start < 100000 ? `<ol start="${start}">` : '<ol>', '</ol>');
    }
    case 'listItem':
      wrap('<li>', '</li>');
      break;
    case 'taskList':
      return wrap('<ul data-type="taskList">', '</ul>');
    case 'taskItem': {
      const checked = n.attrs?.checked === true;
      out.text.push(checked ? '[x] ' : '[ ] ');
      wrap(
        `<li data-type="taskItem" data-checked="${checked}"><input type="checkbox" disabled${checked ? ' checked' : ''}><div>`,
        '</div></li>',
      );
      break;
    }
    case 'blockquote':
      wrap('<blockquote>', '</blockquote>');
      break;
    case 'codeBlock':
      wrap('<pre><code>', '</code></pre>');
      break;
    case 'horizontalRule':
      out.html.push('<hr>');
      return;
    case 'table':
      // Wrapped so a wide table scrolls inside its own box instead of widening the thread.
      return wrap('<div class="rich-table"><table>', '</table></div>');
    case 'tableRow':
      // Cells are inline in the plain text: "a | b".
      out.html.push('<tr>');
      (n.content ?? []).forEach((c, i) => {
        if (i) out.text.push(' | ');
        renderNode(c, out, depth + 1);
      });
      out.html.push('</tr>');
      break;
    case 'tableHeader':
    case 'tableCell': {
      const tag = n.type === 'tableHeader' ? 'th' : 'td';
      const align = n.attrs?.align;
      const style = align === 'left' || align === 'right' || align === 'center' ? ` style="text-align:${align}"` : '';
      return wrap(`<${tag}${style}>`, `</${tag}>`);
    }
    case 'hardBreak':
      out.html.push('<br>');
      out.text.push('\n');
      return;
    case 'image': {
      const img = out.opts.image?.(n.attrs ?? {});
      if (!img) return;
      const width = Number(img.width);
      const w = Number.isInteger(width) && width >= 16 && width <= 4000 ? ` width="${width}"` : '';
      // `ref`: an image the app loads itself (an update's email image), named on `data-image-ref`.
      const ref = img.ref ? ` data-image-ref="${escapeHtml(img.ref)}"` : '';
      out.html.push(
        `<figure class="rich-image"><img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt)}"${w}${ref} loading="lazy"></figure>`,
      );
      return;
    }
    case 'mention': {
      const id = String(n.attrs?.id ?? '');
      const label = String(n.attrs?.label ?? '').slice(0, 120);
      if (!ULID.test(id)) {
        out.html.push(escapeHtml(`@${label}`));
        out.text.push(`@${label}`);
        return;
      }
      out.mentions.add(id);
      out.html.push(`<span class="mention" data-user-id="${id}">@${escapeHtml(label)}</span>`);
      out.text.push(`@${label}`);
      return;
    }
    default:
      // Not on the allowlist: keep the text, drop the element.
      return children();
  }
  if (blockText.has(n.type)) out.text.push('\n');
};

/** ProseMirror JSON → safe HTML + plain text (search, notifications) + mentioned user ids. */
export const renderRichDoc = (
  doc: RichNode,
  opts: RichRenderOptions = {},
): { html: string; text: string; mentions: string[] } => {
  const out: Out = { html: [], text: [], mentions: new Set(), opts };
  renderNode(doc, out, 0);
  return {
    html: out.html.join(''),
    text: out.text
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    mentions: [...out.mentions],
  };
};

/** True when the document has no text, mention or rule — an empty editor. */
export const isRichDocEmpty = (doc: RichNode): boolean => {
  const r = renderRichDoc(doc);
  return !r.text && !r.html.includes('<hr>');
};

/** Ordered by how they appear (= how the renderer writes them): the check boxes of a stored rich doc. */
const countTasks = (n: RichNode): number =>
  (n.type === 'taskItem' ? 1 : 0) + (n.content ?? []).reduce((sum, c) => sum + countTasks(c), 0);

export const taskCount = (doc: RichNode) => countTasks(doc);

/**
 * The doc with its `index`-th check box (in document order — the order the rendered HTML has them) set to
 * `checked`. Returns null when there is no such check box. The input is never changed.
 */
export const setTaskChecked = (doc: RichNode, index: number, checked: boolean): RichNode | null => {
  let seen = -1;
  let hit = false;
  const walk = (n: RichNode): RichNode => {
    let next = n;
    if (n.type === 'taskItem') {
      seen += 1;
      if (seen === index) {
        hit = true;
        next = { ...n, attrs: { ...(n.attrs ?? {}), checked } };
      }
    }
    if (!n.content) return next;
    return { ...next, content: n.content.map(walk) };
  };
  const out = walk(doc);
  return hit ? out : null;
};

/** The check boxes of a stored rich doc in order (what the AI tools list): each one's own text. */
export const richTasks = (doc: RichNode): { index: number; text: string; checked: boolean }[] => {
  const out: { index: number; text: string; checked: boolean }[] = [];
  const textOf = (n: RichNode): string =>
    n.type === 'taskItem' ? '' : (n.text ?? '') + (n.content ?? []).map(textOf).join('');
  const walk = (n: RichNode) => {
    if (n.type === 'taskItem') {
      const own = (n.content ?? []).filter((c) => c.type !== 'taskList');
      out.push({ index: out.length, text: own.map(textOf).join(' ').trim(), checked: n.attrs?.checked === true });
    }
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
};
