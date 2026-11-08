// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import type { FetchLike } from '@bines/server-ai';
import { assertPublicUrl, guardedFetch } from '../../lib/outbound';

/**
 * The transport of the fetch-based AI adapters (OpenAI, Gemini, OpenAI-compatible): the outbound guard
 * of `lib/outbound` (public addresses only, checked again on the address dialled; no redirects; a size cap). Private
 * / local addresses only when the platform owner allowed local AI endpoints. The guard's refusal reads as an AI one.
 */
export const aiFetch =
  (allowPrivate = false): FetchLike =>
  async (url, init) => {
    try {
      return await guardedFetch({ allowPrivate })(url, init);
    } catch (err) {
      throw aiUrlError(err);
    }
  };

const aiUrlError = (err: unknown) => {
  if (err instanceof AppError && err.message === 'webhook_url_private')
    return new AppError('invalid_value', 'ai_base_url_private');
  if (err instanceof AppError && err.message === 'webhook_url_invalid')
    return new AppError('invalid_value', 'ai_base_url_invalid');
  return err;
};

/**
 * Checks an OpenAI-compatible base URL when it is saved: http(s), no credentials in it, a public address unless the
 * owner allowed local endpoints. (Each call checks again, on the address actually dialled.)
 */
export const assertAiBaseUrl = async (raw: string, allowPrivate: boolean) => {
  try {
    await assertPublicUrl(raw, allowPrivate);
  } catch (err) {
    if (err instanceof AppError) throw aiUrlError(err);
    // A name that does not resolve.
    throw new AppError('invalid_value', 'ai_base_url_unreachable');
  }
};
