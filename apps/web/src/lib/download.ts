// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '@bines/sdk';

/**
 * Downloads a file the API produces (CSV exports) with the session and the account header, and saves it under
 * `filename`. The JSON client cannot do this: it parses every answer.
 */
export const downloadFrom = async (accountId: string, path: string, filename: string) => {
  const res = await fetch(`/api/v1${path}`, { credentials: 'include', headers: { 'x-account-id': accountId } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: ApiError['body'] } | null;
    throw new ApiError(res.status, body?.error ?? { code: 'internal', message: res.statusText, request_id: '' });
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/** The name from `Content-Disposition` (`filename*=UTF-8''…` first — Hebrew names), else `fallback`. */
const filenameOf = (res: Response, fallback: string) => {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  if (star) return decodeURIComponent(star);
  return /filename="([^"]+)"/i.exec(cd)?.[1] ?? fallback;
};

/** A file the API makes from a POST body (board export): saved under the name the API gives it. */
export const downloadPost = async (accountId: string, path: string, body: unknown, fallback = 'export') => {
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-account-id': accountId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: ApiError['body'] } | null;
    throw new ApiError(res.status, err?.error ?? { code: 'internal', message: res.statusText, request_id: '' });
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameOf(res, fallback);
  a.click();
  URL.revokeObjectURL(url);
};

/** Checks an API answer and saves its body under the name the API gives it (else `fallback`). */
export const saveResponse = async (res: Response, fallback: string) => {
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: ApiError['body'] } | null;
    throw new ApiError(res.status, err?.error ?? { code: 'internal', message: res.statusText, request_id: '' });
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameOf(res, fallback);
  a.click();
  URL.revokeObjectURL(url);
};

/** A file the API makes on a GET (a document's PDF): saved under the name the API gives it. */
export const downloadGet = async (accountId: string, path: string, fallback = 'download') =>
  saveResponse(
    await fetch(`/api/v1${path}`, { credentials: 'include', headers: { 'x-account-id': accountId } }),
    fallback,
  );
