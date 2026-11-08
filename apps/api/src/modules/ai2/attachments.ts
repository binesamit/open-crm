// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { type AssistantFile, wrapUntrustedContent } from '@bines/shared';
import { sniffImageMime } from '@bines/server-ai';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { findAsset } from '../files/files.repo';
import { extractFileText, knowledgeFileType, tidy } from '../agents/knowledge/extract';
import { isRefMark, refBlocks } from './refs';

/**
 * Files attached to a chat message ("paste images, files… like the updates composer and outside chat
 * apps"). The stored transcript keeps a small mark per file (its id, name, type, size) — never its bytes, which the
 * conversation would otherwise carry and resend on every later turn. When the conversation goes to the model, each
 * mark becomes what the model can use:
 * - an image (PNG / JPEG / WebP / GIF) → an image block the model sees — only when the model reads images; else a
 *   note that tells it so (an old image never blocks a later message of the conversation);
 * - a PDF, Word document or text file (txt, md, csv, json, …) → its text, as untrusted data;
 * - anything else, or a file that is gone → a short note naming it.
 * The same for the assistant and for an agent's chat (the engine's model decides about images).
 */
export const FILE_MARK = 'bines_file';
export type FileMark = { type: typeof FILE_MARK; asset_id: string; name: string; mime: string; size: number };

/** The largest image sent to a model (the providers' own per-image limits are around this). */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
/** The largest document read for its text. */
export const MAX_CHAT_DOC_BYTES = 20 * 1024 * 1024;
/** At most this much of a document's text goes to the model. */
export const MAX_CHAT_DOC_CHARS = 60_000;

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'html',
  'htm',
  'log',
  'yaml',
  'yml',
]);

type Deps = Pick<AppDeps, 'storage'> & { db: Db };
type Asset = { id: string; fileName: string; mime: string; size: number };

export const fileMark = (a: Asset): FileMark => ({
  type: FILE_MARK,
  asset_id: a.id,
  name: a.fileName,
  mime: a.mime,
  size: a.size,
});

export const isFileMark = (b: unknown): b is FileMark =>
  !!b && typeof b === 'object' && (b as { type?: unknown }).type === FILE_MARK;

/** The marks of a stored user turn, as the chat shows them (the message's attachments). */
export const filesOfContent = (content: unknown[]): AssistantFile[] =>
  content.flatMap((turn) => {
    const blocks = (turn as { content?: unknown }).content;
    return Array.isArray(blocks)
      ? blocks.filter(isFileMark).map((m) => ({ id: m.asset_id, name: m.name, mime: m.mime, size: m.size }))
      : [];
  });

/** How a file is read for the model, by its type: an image, a document's text, or nothing. */
export const attachmentKind = (name: string, mime: string): 'image' | 'pdf' | 'docx' | 'text' | null => {
  if (IMAGE_MIMES.has(mime.toLowerCase())) return 'image';
  const known = knowledgeFileType(name);
  if (known === 'pdf' || known === 'docx') return known;
  if (known) return 'text';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (TEXT_EXTENSIONS.has(ext) || /^text\//i.test(mime) || /^application\/(json|xml)$/i.test(mime)) return 'text';
  if (/^application\/pdf$/i.test(mime)) return 'pdf';
  return null;
};

const note = (text: string): Anthropic.TextBlockParam => ({ type: 'text', text: `[${text}]` });
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** One mark → the blocks the model gets (see the module comment). Never throws: a failure becomes a note. */
export const resolveFileMark = async (
  deps: Deps,
  accountId: string,
  mark: FileMark,
  vision: boolean,
): Promise<Anthropic.ContentBlockParam[]> => {
  const what = `"${mark.name}" (${mark.mime || 'unknown type'}, ${kb(mark.size)})`;
  const asset = await findAsset(deps.db, accountId, mark.asset_id);
  if (!asset?.storageKey) return [note(`The user attached the file ${what}; it is no longer available.`)];
  const kind = attachmentKind(asset.fileName, asset.mime);
  if (kind === 'image') {
    if (!vision)
      return [
        note(
          `The user attached the image ${what}, but this model cannot see images. Say so, and suggest choosing a model that reads images.`,
        ),
      ];
    if (asset.size > MAX_CHAT_IMAGE_BYTES)
      return [note(`The user attached the image ${what}; it is too large to look at (over 5 MB).`)];
    const buf = await deps.storage.get(asset.storageKey, MAX_CHAT_IMAGE_BYTES);
    const mime = buf ? sniffImageMime(buf) : null;
    if (!buf || !mime) return [note(`The user attached the image ${what}; it could not be read.`)];
    return [
      { type: 'text', text: wrapUntrustedContent('attachment', `The user attached an image: ${mark.name}`) },
      {
        type: 'image',
        source: { type: 'base64', media_type: mime as 'image/png', data: buf.toString('base64') },
      },
    ];
  }
  if (kind) {
    if (asset.size > MAX_CHAT_DOC_BYTES)
      return [note(`The user attached the file ${what}; it is too large to read (over 20 MB).`)];
    const buf = await deps.storage.get(asset.storageKey, MAX_CHAT_DOC_BYTES);
    if (!buf) return [note(`The user attached the file ${what}; it could not be read.`)];
    let text: string;
    try {
      text = tidy(await extractFileText(kind === 'text' ? 'txt' : kind, buf));
    } catch {
      return [note(`The user attached the file ${what}; its text could not be read.`)];
    }
    if (!text) return [note(`The user attached the file ${what}; it has no readable text.`)];
    const cut = text.length > MAX_CHAT_DOC_CHARS;
    const body = `The user attached a file: ${mark.name}\n\n${cut ? text.slice(0, MAX_CHAT_DOC_CHARS) : text}`;
    return [
      { type: 'text', text: wrapUntrustedContent('attachment', body) },
      ...(cut ? [note(`Only the first ${MAX_CHAT_DOC_CHARS} characters of "${mark.name}" are shown.`)] : []),
    ];
  }
  return [note(`The user attached the file ${what}; its contents cannot be read here (only images and documents).`)];
};

/**
 * The transcript as the model gets it: every file mark replaced by its blocks (each file read once per call, however
 * often it appears), every "@" reference mark by its ids and name (refs.ts). Messages without marks pass through
 * unchanged.
 */
export const withAttachments = async (
  deps: Deps,
  accountId: string,
  messages: Anthropic.MessageParam[],
  vision: boolean,
): Promise<Anthropic.MessageParam[]> => {
  const cache = new Map<string, Promise<Anthropic.ContentBlockParam[]>>();
  const resolve = (m: FileMark) => {
    let hit = cache.get(m.asset_id);
    if (!hit) cache.set(m.asset_id, (hit = resolveFileMark(deps, accountId, m, vision)));
    return hit;
  };
  return Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content === 'string' || !msg.content.some((b) => isFileMark(b) || isRefMark(b))) return msg;
      const blocks = await Promise.all(
        (msg.content as unknown[]).map(async (b) =>
          isFileMark(b) ? await resolve(b) : isRefMark(b) ? refBlocks(b) : [b as Anthropic.ContentBlockParam],
        ),
      );
      return { ...msg, content: blocks.flat() };
    }),
  );
};
