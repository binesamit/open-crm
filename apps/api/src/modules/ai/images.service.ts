// SPDX-License-Identifier: AGPL-3.0-only
import {
  AI_EACH_PHOTOS_MAX,
  AI_IMAGES_MAX_PER_CALL,
  AI_STYLE_COUNT_MAX,
  AI_VARIATIONS_MAX,
  type AiFidelity,
  type AiPhotoMode,
  aiImageCost,
  type AiSourceCount,
  AppError,
  columnTypes,
  type FilterGroup,
  newId,
} from '@bines/shared';
import {
  AI_INPUT_IMAGE_MIMES,
  AiContentPolicyError,
  aiRetryReason,
  type AiImage,
  type AiInputImage,
  fitInputImages,
  inputImageLimit,
  type InputImageLimit,
  MAX_AI_IMAGE_BYTES,
  ProviderHttpError,
  safeAiError,
  sniffImageMime,
} from '@bines/server-ai';
import type { AppDeps } from '../../types';
import { assertBoard, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { findColumnByKey } from '../boards/boards.repo';
import { attachToCell, getFile, loadFileColumn, safeName } from '../files/files.service';
import { cellFileAssets, currentOf, findAsset, insertAsset, markUploaded, newestCellImages } from '../files/files.repo';
import { loadItem, type Actor } from '../items/items.service';
import { newestFileMatches } from '../items/query.service';
import { assertCanComment, createUpdate } from '../updates/updates.service';
import { addUsage, findConnection, updateConnectionRow } from './ai.repo';
import { assertAiAvailable } from './ai.service';
import { connectionDefaultModel, modelForCall, secretOf } from './models.service';
import { recordAiFailure } from '../errors/errors.sources';
import { CALL_RETRY, withAiRetry } from './retry';

/**
 * AI images: a picture from a text description, made by an AI connection's image model and
 * saved as an ordinary file — in a file column, or on a new update — so it has the item's permissions, versions,
 * the file viewer and the trash like any upload. Used by the `generate_image` AI tool (assistant, agents, MCP), the
 * `generate_image` automation action and AI columns with image output.
 *
 * Which connection / model / size / quality: the caller's (an automation action or an AI column may name its own),
 * else the account's AI image settings (Administration → AI → images) — never code. Spending: AI on, the plan's
 * `ai` feature, the plan's and the account's AI budget (`assertAiAvailable`); the cost comes from the price table
 * (per image by size / quality, else the tokens the provider reports) and lands in `ai_usage` as source `image`.
 * Safety: the bytes are the provider's (base64, or its own result links fetched through the SSRF guard by the
 * adapter); their type is read from the bytes, raster images only, ≤ 20 MB each. A provider's safety refusal
 * answers `ai_image_content_policy` with the provider's own short reason, so the person can change the description.
 */
type Deps = AppDeps;

export type ImageOptions = {
  prompt: string;
  /** Null / absent = the account's image settings. A connection given without a model uses its default model. */
  connectionId?: string | null;
  model?: string | null;
  size?: string | null;
  quality?: string | null;
  count?: number;
  /** Image to image: pictures already read to start from (`loadSourceFile`). */
  images?: AiInputImage[];
  /**
   * Image to image, round 2: the item's photos (`listSourceImages`), read once the model is known — the newest within
   * its limit (`inputImageLimit`) go, after `images`; several columns add a line naming them to the prompt.
   */
  sources?: SourceImageRef[];
  /**
   * Style examples of other items (`listStyleExamples`, round 3): sent first — before `images` and `sources` — with a
   * line saying they are the style to follow; they take the model's limit first.
   */
  examples?: SourceImageRef[];
  /** How much may change (round 4): `close` / `locked` add their prompt lines; absent = `free`. */
  fidelity?: AiFidelity;
  /** `locked` (round 4): the approved base design, sent first as the picture to edit (`resolveFidelityBase`). */
  base?: SourceImageRef | null;
};

export type MadeImages = {
  model: string;
  connectionId: string;
  images: AiImage[];
  costUsd: number;
  size: string | null;
  quality: string | null;
  /** With `sources` / `examples`: how many pictures went of how many there were (`examples` of them style examples). */
  sourceImages?: { sent: number; total: number; examples?: number };
};

/** What a model cannot do with the pictures it was given (the adapter says so before any call). */
const INPUT_ERRORS = new Set(['ai_model_no_image_edit', 'ai_image_edit_one_png', 'ai_image_input_invalid']);

/** A provider error as the person reads it: a safety refusal with its reason, else the short safe code. */
const imageError = (err: unknown): unknown => {
  if (err instanceof AppError) return err;
  if (err instanceof Error && INPUT_ERRORS.has(err.message)) return new AppError('unprocessable', err.message);
  if (err instanceof AiContentPolicyError)
    return new AppError('unprocessable', 'ai_image_content_policy', { provider_message: err.providerMessage });
  // a busy / slow / unavailable provider may succeed later — the reason and its wait travel along.
  const retry = aiRetryReason(err);
  return new AppError('unprocessable', 'ai_image_failed', {
    reason: safeAiError(err),
    ...(err instanceof ProviderHttpError && err.providerMessage ? { provider_message: err.providerMessage } : {}),
    ...(retry ? { retry: { reason: retry.reason, after_ms: retry.retryAfterMs } } : {}),
  });
};

/** Makes the images (no file yet): checks, the call, the cost in `ai_usage`. */
export const generateImages = async (deps: Deps, accountId: string, o: ImageOptions): Promise<MadeImages> => {
  const ai = await assertAiAvailable(deps.db, accountId, 'image');
  const conf = ai.images;
  const connectionId = o.connectionId || conf.connection_id;
  if (!connectionId) throw new AppError('unprocessable', 'ai_images_not_configured');
  const row = await findConnection(deps.db, accountId, connectionId);
  if (!row) throw new AppError('unprocessable', 'ai_images_not_configured');
  // The account's model goes with the account's connection; otherwise the connection's default when it makes images,
  // else the newest image model of its live list (any provider — never an id fixed in code).
  const model =
    o.model ||
    (o.connectionId && o.connectionId !== conf.connection_id ? null : conf.model) ||
    (await connectionDefaultModel(deps, row, 'image'));
  if (!model) throw new AppError('unprocessable', 'ai_image_no_model');
  const known = await modelForCall(deps, row, model);
  if (!known.capabilities.image_generation)
    throw new AppError('invalid_value', 'ai_model_no_image_generation', { model });
  const client = deps.aiClient(await secretOf(deps, row));
  if (!client.generateImage)
    throw new AppError('invalid_value', 'ai_provider_no_image_generation', { provider: row.provider });
  const size = o.size || conf.size || null;
  const quality = o.quality || conf.quality || null;
  const count = Math.max(1, Math.min(o.count ?? 1, conf.max_images, AI_IMAGES_MAX_PER_CALL));
  // The photos within what this provider / model takes (count and bytes): the newest go, read from storage now.
  const given = o.images ?? [];
  const limit = inputImageLimit(row.provider, model);
  // `locked` (round 4): the approved base goes first, as the picture to edit; style examples are not sent then (the
  // base is the style), and the item's photos follow as the subject.
  const baseImage = o.base ? await readInputImage(deps, o.base.asset) : null;
  const examples = baseImage ? [] : (o.examples ?? []);
  const lead = baseImage ? 1 : 0;
  const read =
    o.sources?.length || examples.length
      ? await readSourceImages(
          deps,
          o.sources ?? [],
          {
            maxImages: Math.max(0, limit.maxImages - given.length - lead),
            maxTotalBytes:
              limit.maxTotalBytes - given.reduce((n, img) => n + img.data.length, 0) - (baseImage?.data.length ?? 0),
          },
          examples,
          given.length + lead,
        )
      : null;
  // The base (locked), else the style examples first, then a file given by id, then the item's photos.
  const images = baseImage
    ? [baseImage, ...given, ...(read?.images ?? [])]
    : read
      ? [...read.images.slice(0, read.examples), ...given, ...read.images.slice(read.examples)]
      : given;
  const legend = baseImage
    ? lockedLegend(images.length - 1, o.base!.columnTitle)
    : fidelityLegend(o.fidelity ?? 'free', images.length, read?.legend ?? null);
  let res;
  try {
    res = await client.generateImage({
      model,
      prompt: withLegend(o.prompt, legend),
      size,
      quality,
      n: count,
      ...(images.length ? { images } : {}),
    });
  } catch (err) {
    const e = imageError(err);
    // Errors hub: a failed image call (a safety refusal included — the code says which).
    recordAiFailure(deps.db, { accountId, connectionId: row.id, source: 'image', model, err: e });
    throw e;
  }
  // The adapter already checks; checked again here — whatever a client returns, only real images ≤ the cap are kept.
  const made = res.images
    .filter((i) => i.data.length > 0 && i.data.length <= MAX_AI_IMAGE_BYTES && sniffImageMime(i.data) === i.mime)
    .slice(0, count);
  const costUsd = aiImageCost(known.price, { size, quality, count: made.length || count }, res.usage);
  await addUsage(deps.db, {
    accountId,
    day: new Date().toISOString().slice(0, 10),
    source: 'image',
    connectionId: row.id,
    model,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  });
  await updateConnectionRow(deps.db, row.id, { lastUsedAt: new Date() });
  if (!made.length) throw new AppError('unprocessable', 'ai_image_empty');
  return {
    model,
    connectionId: row.id,
    images: made,
    costUsd,
    size,
    quality,
    ...(baseImage
      ? {
          sourceImages: {
            sent: images.length,
            total: 1 + given.length + (o.sources?.length ?? 0),
          },
        }
      : read
        ? { sourceImages: sourceImagesRecord(read, examples.length > 0) }
        : {}),
  };
};

/**
 * How much may change (round 4, `AI_FIDELITY_MODES`) — guidance in the prompt only: no mask, no inpainting (the
 * providers' edit endpoints take a mask, but which pixels are "the figure" is not known here, so the model is told).
 */
export const FIDELITY_CLOSE_LINE =
  'Stay close to the picture you start from (Image 1): keep its composition, framing, proportions and colours, and change only what the description asks for.';
export const FIDELITY_LOCKED_LINE =
  'Image 1 is an approved base design. Keep everything in it exactly as it is — the composition, framing, background, colours, lighting, style, text and every other detail. Replace only the figure (the person or subject) with the one in the reference photo, drawn in the style of Image 1 and in the same place. Change nothing else.';
export const FIDELITY_LOCKED_NO_PHOTO_LINE =
  'Image 1 is an approved base design. Keep everything in it exactly as it is, and change only what the description asks for.';

/** The prompt's lines for `locked`: the base, the reference photo(s) after it, and what may change. */
export const lockedLegend = (photos: number, baseTitle: string) => {
  const base = `Image 1: the approved base design (from «${baseTitle}»).`;
  if (!photos) return `${base}\n${FIDELITY_LOCKED_NO_PHOTO_LINE}`;
  const ref =
    photos === 1 ? 'Image 2: the reference photo.' : `Images 2–${photos + 1}: reference photos of the same subject.`;
  return `${base} ${ref}\n${FIDELITY_LOCKED_LINE}`;
};

/** One design of a set: its picture, the source photo it came from (null = together / none) and its variation. */
export type ImageSetOutput = {
  image: AiImage;
  sourceFileId: string | null;
  variation: number;
  sourceImages?: { sent: number; total: number; examples?: number };
};
export type ImageSet = {
  model: string;
  outputs: ImageSetOutput[];
  costUsd: number;
  calls: number;
  /** "Sent X of Y" added up over the calls (absent = no pictures went). */
  sourceImages?: { sent: number; total: number; examples?: number };
  /** Why the set ended early (a limit, the budget, a failed call after some designs were made); null = all made. */
  stopped: string | null;
};

/** Stops of a later call in a set that end the set (an earlier design is kept); anything else ends it too. */
const setStop = (err: unknown) =>
  err instanceof AppError
    ? err.code === 'plan_limit_reached' || err.code === 'plan_feature_unavailable'
      ? err.code
      : err.message
    : 'ai_image_failed';

/**
 * Several designs (round 4): `photoMode` `each` = one call per source photo (the newest
 * `AI_EACH_PHOTOS_MAX`; style examples / the locked base go with every call), `together` = one call with every photo
 * (also with no photo). `variations` per call: the provider's `n` (the account's per-call cap) and, with `repeat`,
 * more calls until that many are made (`repeat: false` = one call of `count`, the `generate_image` tool's way).
 * Each call goes through `generateImages` — AI on, the plan, the budget, its own `ai_usage` row — and `beforeCall`
 * (the AI column's per-run / per-month limits) may stop the set before any call after the first; a stop or a failed
 * call once something was made ends the set with what was made (`stopped`), else the error is thrown as before.
 */
export const generateImageSet = async (
  deps: Deps,
  accountId: string,
  o: ImageOptions & {
    photoMode: AiPhotoMode;
    variations: number;
    repeat?: boolean;
    beforeCall?: (spent: number) => Promise<string | null>;
  },
): Promise<ImageSet> => {
  const photos = o.sources ?? [];
  const jobs =
    o.photoMode === 'each' && photos.length
      ? photos.slice(-AI_EACH_PHOTOS_MAX).map((p) => ({ sources: [p], sourceFileId: p.fileId ?? null }))
      : [{ sources: photos, sourceFileId: null }];
  const repeat = o.repeat !== false;
  const variations = Math.max(1, Math.min(o.variations, repeat ? AI_VARIATIONS_MAX : AI_IMAGES_MAX_PER_CALL));
  const out: ImageSet = { model: '', outputs: [], costUsd: 0, calls: 0, stopped: null };
  for (const job of jobs) {
    let made = 0;
    while (made < variations) {
      if (out.calls > 0 && o.beforeCall) {
        const stop = await o.beforeCall(out.costUsd);
        if (stop) {
          out.stopped = stop;
          return out;
        }
      }
      let r: MadeImages;
      try {
        // a busy / slow provider is tried again (backoff, its Retry-After) before the set stops.
        r = await withAiRetry(
          () =>
            generateImages(deps, accountId, {
              ...o,
              count: variations - made,
              ...(job.sources.length ? { sources: job.sources } : { sources: [] }),
            }),
          CALL_RETRY,
        );
      } catch (err) {
        if (!out.outputs.length) throw err;
        out.stopped = setStop(err);
        return out;
      }
      out.calls += 1;
      out.costUsd += r.costUsd;
      out.model = r.model;
      if (r.sourceImages) {
        // "Sent X of Y" over the set's calls (each call's own is on its designs).
        const sum = out.sourceImages ?? { sent: 0, total: 0 };
        out.sourceImages = {
          sent: sum.sent + r.sourceImages.sent,
          total: sum.total + r.sourceImages.total,
          ...(r.sourceImages.examples !== undefined
            ? { examples: (sum.examples ?? 0) + r.sourceImages.examples }
            : sum.examples !== undefined
              ? { examples: sum.examples }
              : {}),
        };
      }
      for (const image of r.images.slice(0, variations - made)) {
        made += 1;
        out.outputs.push({
          image,
          sourceFileId: job.sourceFileId,
          variation: made,
          ...(r.sourceImages ? { sourceImages: r.sourceImages } : {}),
        });
      }
      if (!repeat) break;
    }
  }
  return out;
};

/**
 * The `locked` base (round 4): the newest image of `baseColumn` on the item (as `a` may read it), else the newest
 * style example. None → `close`, with the note `fidelity_no_base` for the cell. Other fidelities pass through.
 */
export const resolveFidelityBase = async (
  deps: Pick<Deps, 'db'>,
  a: Actor,
  itemId: string,
  fidelity: AiFidelity,
  baseColumn: string | null | undefined,
  examples: SourceImageRef[],
): Promise<{ fidelity: AiFidelity; base: SourceImageRef | null; note: string | null }> => {
  if (fidelity !== 'locked') return { fidelity, base: null, note: null };
  let base: SourceImageRef | null = null;
  if (baseColumn) {
    try {
      base = (await listSourceImages(deps, a, itemId, [baseColumn], 1)).at(-1) ?? null;
    } catch (err) {
      if (err instanceof AppError && err.message === 'ai_source_column_unavailable')
        throw new AppError('unprocessable', 'ai_fidelity_base_unavailable', { column_id: baseColumn });
      throw err;
    }
  }
  base ??= examples.at(-1) ?? null;
  return base ? { fidelity, base, note: null } : { fidelity: 'close', base: null, note: 'fidelity_no_base' };
};

/** `close` adds its line when pictures go with the call; `free` (and no pictures) leaves the lines as they were. */
export const fidelityLegend = (fidelity: AiFidelity, images: number, legend: string | null) =>
  fidelity !== 'free' && images > 0 ? [legend, FIDELITY_CLOSE_LINE].filter(Boolean).join('\n') : legend;

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** A file name from the description (or the name asked for): letters and digits, `-1`, `-2` … for several. */
export const imageFileName = (base: string, mime: string, index: number, of: number) => {
  const stem =
    base
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'image';
  return `${stem}${of > 1 ? `-${index + 1}` : ''}.${EXT[mime] ?? 'png'}`;
};

/** The images as the actor's own uploaded files (server-side write to storage, like a file attached from a link). */
export const storeImages = async (
  deps: Pick<Deps, 'db' | 'storage'>,
  a: Actor,
  images: AiImage[],
  baseName: string,
) => {
  const out: { id: string; name: string; size: number; mime: string }[] = [];
  for (const [i, img] of images.entries()) {
    const name = imageFileName(baseName, img.mime, i, images.length);
    const id = newId();
    const key = `${a.ctx.accountId}/${id}/${safeName(name)}`;
    await insertAsset(deps.db, {
      id,
      accountId: a.ctx.accountId,
      ownerId: a.user.id,
      kind: 'file',
      storageKey: key,
      fileName: name,
      mime: img.mime,
      size: img.data.length,
      uploadStatus: 'pending',
    });
    await deps.storage.put(key, Buffer.from(img.data), img.mime);
    await markUploaded(deps.db, id, img.data.length, img.mime);
    out.push({ id, name, size: img.data.length, mime: img.mime });
  }
  return out;
};

// --- image to image: the pictures a call starts from ----

const isInputMime = (mime: string | null | undefined) =>
  (AI_INPUT_IMAGE_MIMES as readonly string[]).includes(mime ?? '');

/** An asset's bytes from storage (server-side, never a link) as an input picture; null when it is not one. */
const readInputImage = async (deps: Pick<Deps, 'storage'>, asset: { storageKey: string | null; fileName: string }) => {
  if (!asset.storageKey) return null;
  const bytes = await deps.storage.get(asset.storageKey, MAX_AI_IMAGE_BYTES);
  if (!bytes?.length) return null;
  const data = new Uint8Array(bytes);
  // The type is read from the bytes, never from the file's name or what the upload said.
  const mime = sniffImageMime(data);
  return mime && isInputMime(mime) ? ({ mime, data, name: asset.fileName } satisfies AiInputImage) : null;
};

/**
 * A picture an item's file column holds (not read yet): its column (key + title, for the prompt's line saying which
 * pictures came from where), the stored file, when it was added (newer = later; the provider's limit keeps the
 * newest) and its size.
 */
export type SourceImageRef = {
  /** The file's id (its root, the same at every version) — which photo a design came from (round 4). */
  fileId?: string;
  columnKey: string;
  columnTitle: string;
  asset: { storageKey: string | null; fileName: string; size: number };
  at: number;
};

/**
 * The image(s) of an item's file columns, as the actor may read them: the item readable (board rights, view_items),
 * each column a file column they may see (its view restriction). Only PNG / JPEG / WebP of at most 20 MB count.
 * Columns in the order given, oldest first within a column; `count` = every image (`'all'`) or the newest N of each
 * column. `[]` = no image there. A column that is missing, not a file column or hidden throws
 * `ai_source_column_unavailable` (with its key). Nothing is read from storage yet (`readSourceImages`).
 */
export const listSourceImages = async (
  deps: Pick<Deps, 'db'>,
  a: Actor,
  itemId: string,
  columnKeys: string[],
  count: AiSourceCount = 'all',
): Promise<SourceImageRef[]> => {
  const { item, access } = await loadItem(deps.db, a, itemId);
  const out: SourceImageRef[] = [];
  for (const columnKey of [...new Set(columnKeys)]) {
    const column = await findColumnByKey(deps.db, item.boardId, columnKey);
    if (!column || columnTypes.get(column.type)?.engine !== 'files' || !columnAllowed(access, column.restrictedView))
      throw new AppError('unprocessable', 'ai_source_column_unavailable', { column_id: columnKey });
    // The cell's order is the order files were added: the newest are the last ones. Each file at its current
    // version.
    const rows = (await cellFileAssets(deps.db, item.id, column.id)).filter(
      (r) =>
        r.current.uploadStatus === 'uploaded' && isInputMime(r.current.mime) && r.current.size <= MAX_AI_IMAGE_BYTES,
    );
    const taken = count === 'all' ? rows : rows.slice(-Math.max(1, count));
    for (const r of taken)
      out.push({
        fileId: r.asset.id,
        columnKey: column.key,
        columnTitle: column.title,
        asset: r.current,
        at: r.addedAt ? new Date(r.addedAt).getTime() : 0,
      });
  }
  return out;
};

/**
 * The pictures a call starts from — the style examples first (`examples` of them), then the item's own photos —,
 * how many went of how many there were, and the prompt's lines saying what they are.
 */
export type SourceImages = {
  images: AiInputImage[];
  sent: number;
  total: number;
  legend: string | null;
  /** How many of `images` (the first ones) are style examples of other items. */
  examples: number;
};

const span = (from: number, to: number) => (from === to ? `Image ${from}` : `Images ${from}–${to}`);

/**
 * Which columns the pictures came from, for the model (several columns only, or `always`): "Images 1–3: «Photos».
 * Image 4: «Approved sketch»." — numbered as sent from `offset + 1`, consecutive pictures of one column together.
 */
export const sourceImagesLegend = (columns: string[], offset = 0, always = false): string | null => {
  if (!columns.length || (!always && new Set(columns).size < 2)) return null;
  const runs: { title: string; from: number; to: number }[] = [];
  columns.forEach((title, i) => {
    const last = runs[runs.length - 1];
    if (last && last.title === title && last.to === offset + i) last.to = offset + i + 1;
    else runs.push({ title, from: offset + i + 1, to: offset + i + 1 });
  });
  return runs.map((r) => `${span(r.from, r.to)}: «${r.title}».`).join(' ');
};

/** The line for the style examples (the first `count` pictures): what they are and that their style is followed. */
export const styleExamplesLegend = (count: number, columnTitle: string) =>
  count === 1
    ? `Image 1 is an approved example of the required style (from «${columnTitle}»). Follow its style.`
    : `Images 1–${count} are approved examples of the required style (from «${columnTitle}»). Follow their style.`;

/** Larger than any time: style examples go before the item's own photos when the limit chooses. */
const EXAMPLE_AT = Number.MAX_SAFE_INTEGER - 1000;

/**
 * Reads the pictures that go (server-side, from storage): the style examples first (round 3 — they
 * take the model's limit first), then, when there are more photos than what is left of the limit, the newest that
 * fit it (`fitInputImages` — count and bytes), in their order. A file that no longer reads as an image is left out.
 * `total` = the pictures there were (examples included). `between` = pictures the caller puts between the examples
 * and the photos (a file given by id), for the numbering of the line naming the photos' columns.
 */
export const readSourceImages = async (
  deps: Pick<Deps, 'storage'>,
  refs: SourceImageRef[],
  limit: InputImageLimit,
  examples: SourceImageRef[] = [],
  between = 0,
): Promise<SourceImages> => {
  const chosen = fitInputImages(
    [
      ...examples.map((r, i) => ({ ...r, bytes: r.asset.size, at: EXAMPLE_AT + i, example: true })),
      ...refs.map((r) => ({ ...r, bytes: r.asset.size, example: false })),
    ],
    limit,
  );
  const exampleImages: AiInputImage[] = [];
  const images: AiInputImage[] = [];
  const titles: string[] = [];
  for (const r of chosen) {
    const img = await readInputImage(deps, r.asset);
    if (!img) continue;
    if (r.example) exampleImages.push(img);
    else {
      images.push(img);
      titles.push(r.columnTitle);
    }
  }
  const n = exampleImages.length;
  const legend = n
    ? [styleExamplesLegend(n, examples[0]!.columnTitle), sourceImagesLegend(titles, n + between, true)]
        .filter(Boolean)
        .join('\n')
    : sourceImagesLegend(titles, between);
  return {
    images: [...exampleImages, ...images],
    sent: n + images.length,
    total: examples.length + refs.length,
    legend,
    examples: n,
  };
};

/** What a cell / run log records about the pictures sent (`examples` only when there were style examples). */
export const sourceImagesRecord = (r: SourceImages, hadExamples: boolean) => ({
  sent: r.sent,
  total: r.total,
  ...(hadExamples ? { examples: r.examples } : {}),
});

/**
 * Style examples (round 3): the newest `count` images of the file column `style.column` on OTHER items
 * of the item's board that match `style.filter`, read as `a` (a person: their board rights, item visibility and
 * column restrictions; an automation: its owner) — one query for the candidate items (`newestFileMatches`: the
 * filter, an image in the column, the newest image first, at most `count` items — enough for the `count` newest
 * images), one for their images; nothing read from storage yet. Oldest first. `[]` when none match, when the actor
 * cannot read the board, or when the column is hidden from them (never an error, nothing about other items said).
 * A column that is gone / not a file column → `ai_style_column_unavailable`; a filter that cannot run for them (a
 * rule on a column gone or hidden from them) → `ai_style_filter_invalid`.
 */
export const listStyleExamples = async (
  deps: Pick<Deps, 'db'>,
  a: Actor,
  item: { id: string; boardId: string },
  style: { column: string; filter?: FilterGroup | null; count: number },
): Promise<SourceImageRef[]> => {
  const { db } = deps;
  let access;
  try {
    access = await loadBoardAccess(db, a.ctx, a.user, item.boardId);
    assertBoard(access, 'item.read');
  } catch (err) {
    if (err instanceof AppError && (err.code === 'not_found' || err.code === 'forbidden')) return [];
    throw err;
  }
  const column = await findColumnByKey(db, item.boardId, style.column);
  if (!column || columnTypes.get(column.type)?.engine !== 'files')
    throw new AppError('unprocessable', 'ai_style_column_unavailable', { column_id: style.column });
  if (!columnAllowed(access, column.restrictedView)) return [];
  const count = Math.max(1, Math.min(style.count, AI_STYLE_COUNT_MAX));
  const newestFile = { columnId: column.id, mimes: AI_INPUT_IMAGE_MIMES, maxBytes: MAX_AI_IMAGE_BYTES };
  let ids: string[];
  try {
    ids = await newestFileMatches(db, a, item.boardId, style.filter?.rules.length ? style.filter : null, {
      newestFile,
      exclude: [item.id],
      limit: count,
    });
  } catch (err) {
    if (err instanceof AppError && FILTER_ERRORS.has(err.code))
      throw new AppError('unprocessable', 'ai_style_filter_invalid', {
        ...(typeof err.details?.column_id === 'string' ? { column_id: err.details.column_id } : {}),
      });
    throw err;
  }
  if (!ids.length) return [];
  const rows = await newestCellImages(db, ids, newestFile, count);
  return rows.reverse().map((r) => ({
    columnKey: column.key,
    columnTitle: column.title,
    asset: r.asset,
    at: r.addedAt ? new Date(r.addedAt).getTime() : 0,
  }));
};

const FILTER_ERRORS = new Set<string>(['unknown_column', 'invalid_operator', 'query_too_complex', 'invalid_query']);

/** The prompt with the line naming the pictures' columns, when there is one. */
export const withLegend = (prompt: string, legend: string | null) => (legend ? `${prompt}\n\n${legend}` : prompt);

/** One file as an input picture (the `generate_image` tool): read like `get_file_link` reads it, else 404. */
export const loadSourceFile = async (
  deps: Pick<Deps, 'db' | 'storage'>,
  a: Actor,
  fileId: string,
): Promise<AiInputImage> => {
  await getFile(deps, a, fileId);
  const found = await findAsset(deps.db, a.ctx.accountId, fileId);
  // A file's id reads its current version, as `get_file_link` serves it.
  const asset = found && !found.parentAssetId ? await currentOf(deps.db, found) : found;
  if (!asset || !isInputMime(asset.mime) || asset.size > MAX_AI_IMAGE_BYTES)
    throw new AppError('invalid_value', 'ai_source_not_image');
  const img = await readInputImage(deps, asset);
  if (!img) throw new AppError('invalid_value', 'ai_source_not_image');
  return img;
};

/**
 * A stored version as the one picture to change ("Ask the AI for a change" in the file viewer): the
 * same checks as every input picture — PNG / JPEG / WebP, ≤ 20 MB, the type read from the bytes. Else 422
 * `ai_source_not_image`. The caller has checked the actor's rights.
 */
export const readImageForEdit = async (
  deps: Pick<Deps, 'storage'>,
  asset: { storageKey: string | null; fileName: string; mime: string; size: number },
): Promise<AiInputImage> => {
  if (!isInputMime(asset.mime) || asset.size > MAX_AI_IMAGE_BYTES)
    throw new AppError('unprocessable', 'ai_source_not_image');
  const img = await readInputImage(deps, asset);
  if (!img) throw new AppError('unprocessable', 'ai_source_not_image');
  return img;
};

export type ImageTarget = { itemId: string; columnKey?: string | null; updateText?: string | null };

/**
 * Checks the actor may put a file there before anything is spent: a file column = item.update + the column's edit
 * restriction; an update = may comment on the item. AI spends the account's money: never for guests.
 */
export const assertImageTarget = async (deps: Pick<Deps, 'db'>, a: Actor, t: ImageTarget) => {
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'ai_not_for_guests');
  if (a.ctx.role === 'viewer' && t.columnKey) throw new AppError('forbidden', 'viewer_read_only');
  if (t.columnKey) await loadFileColumn(deps.db, a, t.itemId, t.columnKey);
  else {
    await loadItem(deps.db, a, t.itemId);
    await assertCanComment(deps.db, a);
  }
};

/**
 * Make → save → attach, as `a` (the person, the agent's user, the automation's owner): the `generate_image` tool and
 * automation action. Returns the files and what it cost.
 */
export const generateImageOnItem = async (
  deps: Deps,
  a: Actor,
  target: ImageTarget,
  o: ImageOptions & { fileName?: string | null; photoMode?: AiPhotoMode },
) => {
  await assertImageTarget(deps, a, target);
  // Round 4: `each` = one call per source photo; `count` stays the images of one call (capped by the account).
  const made = await generateImageSet(deps, a.ctx.accountId, {
    ...o,
    photoMode: o.photoMode ?? 'together',
    variations: o.count ?? 1,
    repeat: false,
  });
  const files = await storeImages(
    deps,
    a,
    made.outputs.map((x) => x.image),
    o.fileName || o.prompt,
  );
  const ids = files.map((f) => f.id);
  let updateId: string | null = null;
  if (target.columnKey) await attachToCell(deps, a, target.itemId, target.columnKey, ids);
  else {
    const body = (target.updateText || o.prompt).slice(0, 2000);
    updateId = (await createUpdate(deps.db, a, target.itemId, { body }, ids)).id;
  }
  return {
    item_id: target.itemId,
    column_id: target.columnKey ?? null,
    update_id: updateId,
    files,
    model: made.model,
    cost_usd: made.costUsd,
    ...(made.calls > 1 ? { calls: made.calls } : {}),
    ...(made.stopped ? { stopped: made.stopped } : {}),
  };
};
