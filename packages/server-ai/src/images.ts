// SPDX-License-Identifier: AGPL-3.0-only
import type { AiImage, AiInputImage, FetchLike } from './types';

/**
 * AI images — what every adapter shares: an image is at most `MAX_AI_IMAGE_BYTES`, its type is read
 * from its bytes (never from what the answer claims) and only raster types a browser shows safely are kept. A
 * result URL is fetched only when it is the provider's own (its storage host, or the connection's own server for an
 * OpenAI-compatible one) and only through the transport the api hands in (the SSRF guard) — never a link the model
 * made up.
 */
export const MAX_AI_IMAGE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** The image type from its first bytes: PNG, JPEG, WebP or GIF; null = something else (refused). */
export const sniffImageMime = (b: Uint8Array): string | null => {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP'
  )
    return 'image/webp';
  if (b.length >= 6 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'GIF8') return 'image/gif';
  return null;
};

/**
 * Image to image: what a call may start from — pictures of PNG / JPEG / WebP (the types every image
 * model reads), each of at most `MAX_AI_IMAGE_BYTES`, its type read from its bytes; how many, and how many bytes in
 * all, is the provider's / model's own limit (`inputImageLimit`).
 */
export const AI_INPUT_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** How many pictures one call may carry, and their bytes together (before base64). */
export type InputImageLimit = { maxImages: number; maxTotalBytes: number };

const MB = 1024 * 1024;

/**
 * The pictures one call may carry, per provider and model (round 2 — "all the photos")
 *
 * Image output (`use: 'image'`):
 * - OpenAI `/images/edits`: gpt-image models take up to 16 images (each png / webp / jpg under 50 MB — OpenAI's
 *   image edit reference); DALL·E 2 one square PNG; DALL·E 3 edits nothing (the adapter refuses it, 1 here). The
 *   request as a whole is held to 50 MB (our cap: the edit endpoint documents no total, and the transport counts it).
 *   An OpenAI-compatible server is read like gpt-image (it answers for itself when it takes fewer).
 * - Gemini image models (`inlineData` parts): Gemini 3 image models ("Nano Banana Pro") take up to 14 reference
 *   images; Gemini 2.5 Flash Image works best with up to 3 (both from Google's image generation guide). An unknown
 *   Gemini image model gets the smaller, 3. A Gemini request with inline data is at most 20 MB in all, and base64
 *   grows bytes by a third: 15 MB of pictures. Imagen edits nothing (refused by the adapter, 1 here).
 *
 * Text output (`use: 'vision'`, image blocks to a model that sees images): at most 20 pictures (Anthropic takes
 * more than 20 only at ≤ 2000 px a side, which nothing here checks — 20 for every provider keeps one rule and the
 * cost bounded); bytes by the provider's request limit less base64's third — Anthropic 32 MB → 20 MB, OpenAI 50 MB →
 * 35 MB, Gemini 20 MB → 15 MB, an OpenAI-compatible server 15 MB (unknown — the smallest).
 */
export const inputImageLimit = (
  provider: string,
  model: string,
  use: 'image' | 'vision' = 'image',
): InputImageLimit => {
  const id = model.replace(/^models\//, '').toLowerCase();
  if (use === 'vision')
    return {
      maxImages: 20,
      maxTotalBytes: provider === 'anthropic' ? 20 * MB : provider === 'openai' ? 35 * MB : 15 * MB,
    };
  if (provider === 'gemini') {
    if (/^imagen/.test(id)) return { maxImages: 1, maxTotalBytes: 15 * MB };
    return { maxImages: /^gemini-3/.test(id) ? 14 : 3, maxTotalBytes: 15 * MB };
  }
  if (provider === 'openai' && /^dall-e/.test(id)) return { maxImages: 1, maxTotalBytes: 4 * MB };
  return { maxImages: 16, maxTotalBytes: 50 * MB };
};

/**
 * Which pictures go when there are more than a call may carry: the newest (`at`, larger = newer) that fit the
 * limit's count and bytes, handed back in their own order. The newest one always goes, whatever its size (the
 * provider answers for it, as with a single picture before).
 */
export const fitInputImages = <T extends { bytes: number; at: number }>(list: T[], limit: InputImageLimit): T[] => {
  const byAge = list.map((x, i) => ({ x, i })).sort((p, q) => q.x.at - p.x.at || q.i - p.i);
  const keep = new Set<number>();
  let bytes = 0;
  for (const { x, i } of byAge) {
    if (keep.size >= limit.maxImages) break;
    if (keep.size && bytes + x.bytes > limit.maxTotalBytes) continue;
    keep.add(i);
    bytes += x.bytes;
  }
  return list.filter((_, i) => keep.has(i));
};

/**
 * The pictures a call starts from, checked again by the adapter (`ai_image_input_invalid` when one is not fit, or
 * when there are more — or more bytes — than the model's limit; the api picks within it before).
 */
export const checkInputImages = (images: AiInputImage[] | undefined, limit?: InputImageLimit): AiInputImage[] => {
  const list = images ?? [];
  if (limit && list.length > Math.max(1, limit.maxImages)) throw new Error('ai_image_input_invalid');
  if (limit && list.length > 1 && list.reduce((n, img) => n + img.data.length, 0) > limit.maxTotalBytes)
    throw new Error('ai_image_input_invalid');
  return list.map((img) => {
    const mime = sniffImageMime(img.data);
    if (
      !mime ||
      !(AI_INPUT_IMAGE_MIMES as readonly string[]).includes(mime) ||
      !img.data.length ||
      img.data.length > MAX_AI_IMAGE_BYTES
    )
      throw new Error('ai_image_input_invalid');
    return { ...img, mime };
  });
};

/** base64 → an image (null when it is too large, empty or not an image). */
export const imageFromBase64 = (b64: string, revisedPrompt?: string | null): AiImage | null => {
  // A quick bound before decoding: base64 is 4 characters per 3 bytes.
  if (!b64 || (b64.length * 3) / 4 > MAX_AI_IMAGE_BYTES + 4) return null;
  const data = new Uint8Array(Buffer.from(b64, 'base64'));
  const mime = sniffImageMime(data);
  if (!mime || !data.length || data.length > MAX_AI_IMAGE_BYTES) return null;
  return { mime, data, revisedPrompt: revisedPrompt ?? null };
};

/**
 * Whether a result URL is the provider's own: https, no credentials, and a host the adapter trusts. Anything else
 * (a model-made link, an internal address) is never fetched.
 */
export const isProviderResultUrl = (raw: string, hostAllowed: (host: string) => boolean) => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && hostAllowed(u.hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** Downloads a provider result URL through the (guarded) transport, size-capped; null when it is not an image. */
export const downloadImage = async (
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string> = {},
): Promise<AiImage | null> => {
  const res = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_AI_IMAGE_BYTES) return null;
  const data = new Uint8Array(await res.arrayBuffer());
  const mime = sniffImageMime(data);
  if (!mime || !data.length || data.length > MAX_AI_IMAGE_BYTES) return null;
  return { mime, data, revisedPrompt: null };
};
