// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  AppError,
  type HelpAsset,
  type HelpFileType,
  type HelpImageType,
  HELP_IMAGE_TYPES,
  HELP_IMPORT_LIMITS,
  helpAssetPath,
  isId,
  newId,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { helpAssets } from '../../db/schema';
import type { AppDeps } from '../../types';

/**
 * Images of help articles (kb-import): platform-level storage (`platform/help/<id>.<ext>`), never an account's file.
 * Only raster images whose first bytes say PNG / JPEG / WebP / GIF are kept (the name and the declared type are not
 * trusted); the same bytes (sha256) are stored once. Readers get them through a public redirect to a short-lived
 * signed link (`GET /help/assets/{id}`), like the email logo.
 */
export type HelpAssetRow = typeof helpAssets.$inferSelect;
type Deps = Pick<AppDeps, 'db' | 'storage'>;

const EXT: Record<HelpFileType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'text/vtt': 'vtt',
};

/** What a file may be: an image (articles, steps, posters), a guide's video, or its captions. */
export type HelpFileKind = 'image' | 'video' | 'captions';
export const isHelpImageType = (type: string): type is HelpImageType =>
  (HELP_IMAGE_TYPES as readonly string[]).includes(type);

/** How long a signed image link lives (the redirect itself is cached for less). */
const LINK_TTL = 60 * 60;

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));

const nil = { width: null, height: null };

/** JPEG: the size is in the first start-of-frame segment. */
const jpegSize = (b: Uint8Array): { width: number; height: number } | null => {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    i += 2 + len;
  }
  return null;
};

/** The image's real type (from its first bytes) and size in pixels, or null when it is not one we keep. */
export const sniffImage = (
  b: Uint8Array,
): { type: HelpImageType; width: number | null; height: number | null } | null => {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return { type: 'image/png', ...(b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : nil) };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ...(jpegSize(b) ?? nil) };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')
    return { type: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = b.length >= 30 ? ascii(b, 12, 4) : '';
    if (chunk === 'VP8X') return { type: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ' && b.length >= 30)
      return { type: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    return { type: 'image/webp', ...nil };
  }
  return null;
};

/**
 * A guide's video by its first bytes: MP4 (an `ftyp` box first) or WebM (the EBML header with the
 * `webm` doc type). Anything else — however it is named — is refused.
 */
export const sniffVideo = (b: Uint8Array): 'video/mp4' | 'video/webm' | null => {
  if (b.length < 12) return null;
  if (ascii(b, 4, 4) === 'ftyp') return 'video/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return ascii(b, 0, Math.min(b.length, 64)).includes('webm') ? 'video/webm' : null;
  return null;
};

/** WebVTT captions: text starting `WEBVTT` (after an optional byte-order mark), then a line end or a space. */
export const isWebVtt = (b: Uint8Array) => {
  const start = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  if (ascii(b, start, 6) !== 'WEBVTT') return false;
  const next = b[start + 6];
  return next === undefined || next === 0x0a || next === 0x0d || next === 0x20 || next === 0x09;
};

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const dims = (n: number | null) => (n && n > 0 && n < 100_000 ? n : null);

export const helpAssetDto = (a: HelpAssetRow, reused = false): HelpAsset => ({
  id: a.id,
  url: helpAssetPath(a.id),
  content_type: a.contentType as HelpFileType,
  size: a.size,
  width: a.width ?? null,
  height: a.height ?? null,
  reused,
});

export const findHelpAssetBySha = async (db: Db, sha: string) =>
  (await db.select().from(helpAssets).where(eq(helpAssets.sha256, sha)).limit(1))[0];

/** The ids (of `ids`) that are stored help images (a video or captions file is never an article's image). */
export const existingHelpAssetIds = async (db: Db, ids: string[]) => {
  const valid = [...new Set(ids.filter(isId))];
  if (!valid.length) return new Set<string>();
  const rows = await db
    .select({ id: helpAssets.id })
    .from(helpAssets)
    .where(and(inArray(helpAssets.id, valid), inArray(helpAssets.contentType, [...HELP_IMAGE_TYPES])));
  return new Set(rows.map((r) => r.id));
};

export const helpAssetsByIds = async (db: Db, ids: string[]) => {
  const valid = [...new Set(ids.filter(isId))];
  return valid.length ? db.select().from(helpAssets).where(inArray(helpAssets.id, valid)) : [];
};

/** Checks an image: size, then its real type from its first bytes. */
export const checkHelpImage = (bytes: Uint8Array) => {
  if (!bytes.length) throw new AppError('invalid_value', 'help_image_empty');
  if (bytes.length > HELP_IMPORT_LIMITS.imageBytes) throw new AppError('payload_too_large', 'help_image_too_large');
  const kind = sniffImage(bytes);
  if (!kind) throw new AppError('invalid_value', 'help_image_type');
  return kind;
};

/**
 * Checks any help file: an image, a guide's video or its WebVTT captions — by size and by its first
 * bytes, never its name. `kinds` limits what this place accepts.
 */
export const checkHelpFile = (
  bytes: Uint8Array,
  kinds: readonly HelpFileKind[] = ['image', 'video', 'captions'],
): { type: HelpFileType; width: number | null; height: number | null } => {
  if (!bytes.length) throw new AppError('invalid_value', 'help_image_empty');
  const image = kinds.includes('image') ? sniffImage(bytes) : null;
  if (image) {
    if (bytes.length > HELP_IMPORT_LIMITS.imageBytes) throw new AppError('payload_too_large', 'help_image_too_large');
    return image;
  }
  const video = kinds.includes('video') ? sniffVideo(bytes) : null;
  if (video) {
    if (bytes.length > HELP_IMPORT_LIMITS.videoBytes) throw new AppError('payload_too_large', 'help_video_too_large');
    return { type: video, width: null, height: null };
  }
  if (kinds.includes('captions') && isWebVtt(bytes)) {
    if (bytes.length > HELP_IMPORT_LIMITS.captionBytes)
      throw new AppError('payload_too_large', 'help_captions_too_large');
    return { type: 'text/vtt', width: null, height: null };
  }
  throw new AppError(
    'invalid_value',
    kinds.length === 1 && kinds[0] === 'image' ? 'help_image_type' : 'help_file_type',
  );
};

/** Stores a help file — an image unless `kinds` says otherwise (or finds the stored copy of the same bytes). */
export const storeHelpAsset = async (
  deps: Deps,
  by: string | null,
  bytes: Uint8Array,
  kinds: readonly HelpFileKind[] = ['image'],
): Promise<{ row: HelpAssetRow; reused: boolean }> => {
  const kind = checkHelpFile(bytes, kinds);
  const sha = sha256Hex(bytes);
  const known = await findHelpAssetBySha(deps.db, sha);
  if (known) return { row: known, reused: true };
  const id = newId();
  const key = `platform/help/${id}.${EXT[kind.type]}`;
  await deps.storage.put(key, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), kind.type);
  const inserted = await deps.db
    .insert(helpAssets)
    .values({
      id,
      storageKey: key,
      contentType: kind.type,
      size: bytes.length,
      sha256: sha,
      width: dims(kind.width),
      height: dims(kind.height),
      createdBy: by,
    })
    .onConflictDoNothing({ target: helpAssets.sha256 })
    .returning();
  if (inserted[0]) return { row: inserted[0], reused: false };
  // Stored by a parallel upload of the same bytes a moment ago: use that one, drop ours.
  await deps.storage.remove(key).catch(() => undefined);
  return { row: (await findHelpAssetBySha(deps.db, sha))!, reused: true };
};

export const helpAssetFileName = (a: HelpAssetRow) => `${a.id}.${EXT[a.contentType as HelpFileType] ?? 'bin'}`;

/** id → content type of the stored files among `ids` (a guide keeps only files of the right kind in each place). */
export const helpAssetTypes = async (db: Db, ids: (string | null | undefined)[]) =>
  new Map(
    (
      await helpAssetsByIds(
        db,
        ids.filter((x): x is string => !!x),
      )
    ).map((r) => [r.id, r.contentType] as const),
  );

/**
 * GET /help/assets/{id} — public: a redirect to a fresh signed link of a help image or video. Captions (WebVTT) come
 * back as text from the app's own address, so a `<track>` needs no cross-origin access to the storage.
 */
export const helpAssetLocation = async (
  deps: Deps,
  id: string,
): Promise<{ redirect: string } | { text: string; type: string }> => {
  const [a] = isId(id) ? await helpAssetsByIds(deps.db, [id]) : [];
  if (!a) throw new AppError('not_found', 'Image not found');
  if (a.contentType === 'text/vtt') {
    const bytes = await deps.storage.get(a.storageKey, HELP_IMPORT_LIMITS.captionBytes);
    return { text: new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''), type: 'text/vtt; charset=utf-8' };
  }
  return {
    redirect: await deps.storage.presignGet(a.storageKey, helpAssetFileName(a), { inline: true, ttl: LINK_TTL }),
  };
};
