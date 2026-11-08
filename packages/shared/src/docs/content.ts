// SPDX-License-Identifier: AGPL-3.0-only
import type { RichNode } from '../rich';

/**
 * What the server derives from a doc's Yjs state on every save (M8 ד1): the ProseMirror JSON (read without a
 * WebSocket, export) and from it the plain text (search) and the files it shows (orphan-file protection).
 * Pure — the same code runs in the API's store hook and in tests.
 */

/** The Yjs fragment the editor binds to (Tiptap's Collaboration default). */
export const DOC_FRAGMENT = 'default';
/** A doc's Yjs state above this is refused / warned about (plan §3.3). */
export const DOC_STATE_MAX_BYTES = 5 * 1024 * 1024;
/** Searchable text kept per doc. */
export const DOC_TEXT_MAX = 100_000;

/** Nodes after which a line ends in the text (paragraphs, headings, list items …). */
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'tableRow',
  'detailsSummary',
  'callout',
  'image',
  'fileBlock',
  'boardEmbed',
  'itemEmbed',
]);

const EMBEDS = new Set(['image', 'fileBlock', 'boardEmbed', 'itemEmbed']);

/**
 * The doc's text: block by block on its own line, inline nodes (text, mentions, hard breaks) joined. Empty lines are
 * dropped, so an empty doc is ''.
 */
export const docPlainText = (doc: RichNode | null | undefined, max = DOC_TEXT_MAX): string => {
  if (!doc) return '';
  const lines: string[] = [];
  let line = '';
  let size = 0;
  const flush = () => {
    const v = line.replace(/[ \t]+/g, ' ').trim();
    if (v) {
      lines.push(v);
      size += v.length + 1;
    }
    line = '';
  };
  const walk = (n: RichNode, depth: number) => {
    if (size > max || depth > 64) return;
    if (n.type === 'text') line += n.text ?? '';
    else if (n.type === 'hardBreak') line += ' ';
    else if (n.type === 'mention') line += `@${String(n.attrs?.label ?? n.attrs?.id ?? '')}`;
    // Links to items / boards / docs and embeds read as their name; images and files as theirs.
    else if (n.type === 'entityLink') line += String(n.attrs?.label ?? '');
    else if (EMBEDS.has(n.type)) line += String(n.attrs?.label ?? n.attrs?.name ?? n.attrs?.alt ?? '');
    for (const c of n.content ?? []) walk(c, depth + 1);
    if (BLOCKS.has(n.type)) flush();
  };
  walk(doc, 0);
  flush();
  return lines.join('\n').slice(0, max);
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Ids of the files (assets) a doc shows: any node with an `asset_id` (images / files, ד2). */
export const docAssetIds = (doc: RichNode | null | undefined): string[] => {
  const out = new Set<string>();
  const walk = (n: RichNode, depth: number) => {
    if (depth > 64) return;
    const id = n.attrs?.asset_id ?? n.attrs?.assetId;
    if (typeof id === 'string' && ULID.test(id)) out.add(id);
    for (const c of n.content ?? []) walk(c, depth + 1);
  };
  if (doc) walk(doc, 0);
  return [...out];
};

/** People mentioned in the doc (`@`), for notifications in ד2. */
export const docMentionIds = (doc: RichNode | null | undefined): string[] => {
  const out = new Set<string>();
  const walk = (n: RichNode, depth: number) => {
    if (depth > 64) return;
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') out.add(n.attrs.id);
    for (const c of n.content ?? []) walk(c, depth + 1);
  };
  if (doc) walk(doc, 0);
  return [...out];
};

/** Block types that carry a stable id (Tiptap UniqueID, attribute `id`): what a comment anchors to. */
export const DOC_ID_BLOCKS = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'callout',
  'table',
  'image',
  'fileBlock',
  'boardEmbed',
  'itemEmbed',
  'details',
  'columns',
] as const;

const ID_BLOCKS = new Set<string>(DOC_ID_BLOCKS);

/** Callout tones (the F4 status palette): the block's colour and its default emoji. */
export const CALLOUT_TONES = ['info', 'ok', 'warn', 'danger'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

/**
 * The same content with an id on every block that takes one (made from JSON — an import, a template — rather than
 * typed in the editor, whose UniqueID extension gives them): so anyone can comment on any block from the start.
 */
export const withBlockIds = (doc: RichNode, newId: () => string = () => globalThis.crypto.randomUUID()): RichNode => {
  const walk = (n: RichNode, depth: number): RichNode => {
    if (depth > 64) return n;
    const needs = ID_BLOCKS.has(n.type) && !(typeof n.attrs?.id === 'string' && n.attrs.id);
    return {
      ...n,
      ...(needs ? { attrs: { ...(n.attrs ?? {}), id: newId() } } : {}),
      ...(n.content ? { content: n.content.map((c) => walk(c, depth + 1)) } : {}),
    };
  };
  return walk(doc, 0);
};

/** Block id → its text, for every block with an id (comment anchors and their quotes). */
export const docBlocks = (doc: RichNode | null | undefined): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (n: RichNode, depth: number) => {
    if (depth > 64) return;
    const id = n.attrs?.id;
    if (typeof id === 'string' && id && ID_BLOCKS.has(n.type))
      out.set(id, docPlainText({ type: 'doc', content: [n] }, 500));
    for (const c of n.content ?? []) walk(c, depth + 1);
  };
  if (doc) walk(doc, 0);
  return out;
};

/** Items, boards and docs a doc links to or embeds (`entityLink`, `boardEmbed`, `itemEmbed`). */
export const docEntityRefs = (doc: RichNode | null | undefined) => {
  const out: { kind: 'item' | 'board' | 'doc'; id: string }[] = [];
  const seen = new Set<string>();
  const add = (kind: 'item' | 'board' | 'doc', id: unknown) => {
    if (typeof id !== 'string' || !ULID.test(id) || seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    out.push({ kind, id });
  };
  const walk = (n: RichNode, depth: number) => {
    if (depth > 64) return;
    if (n.type === 'entityLink') {
      const kind = n.attrs?.kind;
      if (kind === 'item' || kind === 'board' || kind === 'doc') add(kind, n.attrs?.id);
    } else if (n.type === 'boardEmbed') add('board', n.attrs?.board_id);
    else if (n.type === 'itemEmbed') add('item', n.attrs?.item_id);
    for (const c of n.content ?? []) walk(c, depth + 1);
  };
  if (doc) walk(doc, 0);
  return out;
};
