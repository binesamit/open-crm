// SPDX-License-Identifier: AGPL-3.0-only
import {
  type HelpGuide,
  type HelpGuideView,
  helpAssetPath,
  helpGuideSchema,
  helpVideoEmbedUrl,
  HELP_VIDEO_TYPES,
  isId,
  RICH_MARKS,
  RICH_NODES,
  renderRichDoc,
  type RichNode,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { existingHelpAssetIds, helpAssetTypes, isHelpImageType } from './help.assets';

/**
 * Article content: an article is the same rich text the editor writes, minus everything that belongs
 * to one account — mentions of people, links / embeds of items, boards and docs, account files. What is left renders
 * through the shared allowlist (`renderRichDoc`), so stored HTML from a browser is never shown.
 *
 * Images (kb-import): only here, an `image` node `{src, alt, width?}` is allowed — and only when `src` is the id of a
 * help image (`help_assets`). Anything else (an address, an account's file, a doc's image) is dropped.
 */
const ALLOWED_NODES = new Set<string>(RICH_NODES.filter((n) => n !== 'mention'));
const ALLOWED_MARKS = new Set<string>(RICH_MARKS);

/** An image node of an article, normalised (only its known attributes), or null when it is not one. */
const helpImage = (node: RichNode): RichNode | null => {
  const src = node.attrs?.src;
  if (typeof src !== 'string' || !isId(src)) return null;
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.slice(0, 300) : '';
  const width = Number(node.attrs?.width);
  return {
    type: 'image',
    attrs: { src, alt, ...(Number.isInteger(width) && width >= 16 && width <= 4000 ? { width } : {}) },
  };
};

/** Account-only nodes are dropped; a mention / entity link keeps only its visible label as text. */
export const stripAccountEmbeds = (node: RichNode): RichNode | null => {
  if (node.type === 'image') return helpImage(node);
  if (node.type === 'text') {
    const marks = node.marks?.filter((m) => ALLOWED_MARKS.has(m.type));
    return { type: 'text', text: node.text ?? '', ...(marks?.length ? { marks } : {}) };
  }
  if (node.type === 'mention' || node.type === 'entityLink') {
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label : '';
    return label ? { type: 'text', text: label } : null;
  }
  if (!ALLOWED_NODES.has(node.type)) {
    // Unknown containers (callouts, columns, details …) keep their children; embeds of account objects go.
    const kids = (node.content ?? []).map(stripAccountEmbeds).filter((n): n is RichNode => !!n);
    if (!kids.length) return null;
    return kids.length === 1 && kids[0]!.type !== 'text' ? kids[0]! : { type: 'paragraph', content: kids };
  }
  const content = node.content?.map(stripAccountEmbeds).filter((n): n is RichNode => !!n);
  return { ...node, ...(content ? { content: flattenParagraphs(node.type, content) } : {}) };
};

/** Where only blocks may stand: stray inline nodes are wrapped in a paragraph (a table cell too — the editor's rule). */
const BLOCK_PARENTS = new Set(['doc', 'listItem', 'taskItem', 'blockquote', 'tableCell', 'tableHeader']);

/** A doc / list may not hold bare text: wrap stray inline nodes in a paragraph. */
const flattenParagraphs = (parent: string, kids: RichNode[]) => {
  if (!BLOCK_PARENTS.has(parent)) return kids;
  const out: RichNode[] = [];
  for (const k of kids) {
    if (k.type === 'text' || k.type === 'hardBreak') {
      const last = out.at(-1);
      if (last?.type === 'paragraph' && last.attrs?.__wrap) last.content!.push(k);
      else out.push({ type: 'paragraph', attrs: { __wrap: true }, content: [k] });
    } else out.push(k);
  }
  return out.map((n) => (n.attrs?.__wrap ? { type: 'paragraph', content: n.content } : n));
};

export const EMPTY_DOC: RichNode = { type: 'doc', content: [{ type: 'paragraph' }] };

export const cleanContent = (doc: RichNode | undefined | null): RichNode => {
  const out = doc ? stripAccountEmbeds({ ...doc, type: 'doc' }) : null;
  return out?.content?.length ? out : EMPTY_DOC;
};

/** The image ids an article's content holds. */
export const imageIdsOf = (node: RichNode, out: string[] = []): string[] => {
  if (node.type === 'image' && typeof node.attrs?.src === 'string') out.push(node.attrs.src);
  for (const c of node.content ?? []) imageIdsOf(c, out);
  return out;
};

const dropImages = (node: RichNode, keep: Set<string>): RichNode | null => {
  if (node.type === 'image') return keep.has(String(node.attrs?.src)) ? node : null;
  if (!node.content) return node;
  return { ...node, content: node.content.map((c) => dropImages(c, keep)).filter((c): c is RichNode => !!c) };
};

/** `cleanContent`, and every image must be a stored help image (others are dropped). */
export const cleanHelpContent = async (db: Db, doc: RichNode | undefined | null): Promise<RichNode> => {
  const clean = cleanContent(doc);
  const ids = imageIdsOf(clean);
  if (!ids.length) return clean;
  const known = await existingHelpAssetIds(db, ids);
  return known.size === new Set(ids).size ? clean : cleanContent(dropImages(clean, known));
};

/**
 * HTML + plain text of an article. `origin` = the app's address the images are served from (readers get the HTML on
 * the public help center too, possibly on another address); without it, a path on the same origin.
 */
export const renderArticle = (doc: RichNode, origin = '') => {
  const base = origin.replace(/\/+$/, '');
  const r = renderRichDoc(doc, {
    image: (attrs) => {
      const src = attrs.src;
      if (typeof src !== 'string' || !isId(src)) return null;
      return {
        src: `${base}${helpAssetPath(src)}`,
        alt: typeof attrs.alt === 'string' ? attrs.alt : '',
        width: typeof attrs.width === 'number' ? attrs.width : null,
      };
    },
  });
  return { html: r.html, text: r.text };
};

/** A stable JSON text (keys sorted) — Postgres jsonb does not keep key order, so a naive comparison always differs. */
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
};

// --- practical guides ----

/** Every file id a guide names (video, still, captions, screenshots). */
export const guideAssetIds = (g: HelpGuide | null | undefined): string[] =>
  g
    ? [
        g.video?.asset_id,
        g.video?.poster_id,
        ...(g.video?.captions ?? []).map((c) => c.asset_id),
        ...g.steps.map((s) => s.image_id),
      ].filter((x): x is string => !!x && isId(x))
    : [];

/**
 * A guide as stored: the schema's shape, and every file of the right kind — the video a stored video, the still and
 * the screenshots stored images, the captions stored WebVTT files (anything else is dropped). A video is a file or a
 * YouTube / Vimeo address, never both (the file wins). Null = no guide.
 */
export const cleanGuide = async (db: Db, raw: unknown): Promise<HelpGuide | null> => {
  if (raw === null || raw === undefined) return null;
  const g = helpGuideSchema.parse(raw);
  const types = await helpAssetTypes(db, guideAssetIds(g));
  const is = (id: string | null | undefined, ok: (type: string) => boolean) =>
    id && ok(types.get(id) ?? '') ? id : null;
  const isVideo = (type: string) => (HELP_VIDEO_TYPES as readonly string[]).includes(type);
  let video = g.video;
  if (video) {
    const assetId = is(video.asset_id, isVideo);
    video = {
      ...video,
      asset_id: assetId,
      url: assetId ? null : video.url,
      poster_id: is(video.poster_id, isHelpImageType),
      captions: video.captions.filter(
        (c, i, all) => is(c.asset_id, (t) => t === 'text/vtt') && all.findIndex((x) => x.locale === c.locale) === i,
      ),
      chapters: [...video.chapters].sort((a, b) => a.at - b.at),
    };
    if (!video.asset_id && !video.url) video = null;
  }
  return {
    video,
    steps: g.steps.map((s) => ({ ...s, image_id: is(s.image_id, isHelpImageType) })),
  };
};

/** A guide for readers: files as their addresses (`origin` as for the article's images). */
export const guideView = (raw: unknown, origin = ''): HelpGuideView | null => {
  const parsed = raw ? helpGuideSchema.safeParse(raw) : null;
  if (!parsed?.success) return null;
  const g = parsed.data;
  const base = origin.replace(/\/+$/, '');
  const path = (id: string | null) => (id ? `${base}${helpAssetPath(id)}` : null);
  const v = g.video;
  return {
    video: v
      ? {
          src: path(v.asset_id),
          embed_url: v.asset_id ? null : helpVideoEmbedUrl(v.url),
          poster: path(v.poster_id),
          captions: v.captions.map((c) => ({ locale: c.locale, src: path(c.asset_id)! })),
          chapters: v.chapters,
          duration: v.duration,
        }
      : null,
    steps: g.steps.map((s) => ({ text: s.text, image: path(s.image_id), marker: s.marker })),
  };
};

/** A guide's text (the steps), indexed with the article so search finds what a guide walks through. */
export const guideText = (raw: unknown) => {
  const parsed = raw ? helpGuideSchema.safeParse(raw) : null;
  if (!parsed?.success) return '';
  const g = parsed.data;
  return [...(g.video?.chapters ?? []).map((c) => c.title), ...g.steps.map((s, i) => `${i + 1}. ${s.text}`)].join('\n');
};

/** A plain-text doc: paragraphs split on blank lines. */
export const textToDoc = (parts: string[][]): RichNode => {
  const content: RichNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0 && part.length) content.push({ type: 'horizontalRule' });
    for (const para of part)
      for (const p of para.split(/\n{2,}/)) {
        const text = p.trim();
        if (text) content.push({ type: 'paragraph', content: [{ type: 'text', text }] });
      }
  });
  return content.length ? { type: 'doc', content } : EMPTY_DOC;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Personal details out of a ticket's text before it becomes an article draft (plan stage 6): email addresses, links,
 * phone numbers, long numbers, record ids, and the names the ticket knows (the requester, the people who wrote in it,
 * the account's name and address). A person still reviews the draft — it is never published by itself.
 */
export const scrubPii = (text: string, known: { names?: string[]; account?: string[] } = {}) => {
  let out = text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\bhttps?:\/\/\S+/gi, '[link]')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '[id]')
    .replace(/(?<![\w])\+?\d[\d\s().-]{6,}\d(?![\w])/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[phone]' : m))
    .replace(/\b\d{6,}\b/g, '[number]');
  const words = (list: string[] | undefined) =>
    [...new Set((list ?? []).flatMap((n) => [n, ...n.split(/\s+/)]).map((n) => n.trim()))]
      .filter((n) => n.length >= 2)
      .sort((a, b) => b.length - a.length);
  for (const name of words(known.account))
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'giu'), '[account]');
  for (const name of words(known.names))
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
  return out;
};
