// SPDX-License-Identifier: MIT
import { ACCOUNT_HEADER, type ErrorEnvelope } from '@bines/shared';

/**
 * Thin fetch client: base URL, auth (session cookie in the app, or an API token `bos_pat_…` for scripts and
 * no-code tools — 06 §1.2), the account header (D12), the error envelope, and an optional 429 retry.
 * The API's contract is the OpenAPI document (`pnpm --filter @bines/api openapi:export`; the public one is
 * /api/v1/openapi.json, docs at /api/docs).
 */
export type ClientOptions = {
  baseUrl: string;
  /** Account for scoped calls; omit for unscoped routes (/auth, /me/accounts, /platform). */
  accountId?: string;
  /** Bearer token for API/service use; browsers use the session cookie instead. */
  token?: string;
  fetch?: typeof fetch;
  /** X-Request-Id for each call; it comes back on the SSE events the call caused (a tab skips its own). */
  requestId?: () => string;
  /** On 429, wait `Retry-After` and try again, up to this many times (scripts, Make/n8n bridges). Default 0. */
  retryOn429?: number;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorEnvelope['error'],
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

export const createClient = (options: ClientOptions) => {
  const doFetch = options.fetch ?? fetch;

  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<T> => {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.accountId) headers[ACCOUNT_HEADER] = options.accountId;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.requestId) headers['x-request-id'] = options.requestId();

    const send = () =>
      doFetch(`${options.baseUrl}/api/v1${path}`, {
        method,
        headers,
        // A token is the credential: no cookies ride along (06 §1.2).
        credentials: options.token ? 'omit' : 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await send();
    for (let tries = 0; res.status === 429 && tries < (options.retryOn429 ?? 0); tries++) {
      const wait = Number(res.headers.get('retry-after') ?? '1');
      await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 1), 60) * 1000));
      res = await send();
    }
    // A body that is not JSON (empty from a proxy while the API restarts, an HTML error page) must not crash
    // the app: it becomes an ApiError with the status, like any other failure.
    const text = res.status === 204 ? '' : await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok)
      throw new ApiError(
        res.status,
        (json as ErrorEnvelope | undefined)?.error ?? {
          code: 'unavailable',
          message: res.statusText || 'unavailable',
          request_id: '',
        },
      );
    if (json === undefined && text)
      throw new ApiError(res.status, { code: 'unavailable', message: 'not JSON', request_id: '' });
    return json as T;
  };

  return {
    get: <T>(path: string, headers?: Record<string, string>) => request<T>('GET', path, undefined, headers),
    /** `headers` e.g. `{ 'idempotency-key': crypto.randomUUID() }` — a retry then cannot create twice (06 §1.9). */
    post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('POST', path, body, headers),
    /** `headers` e.g. `{ 'if-match': '3' }` for revisioned saves (15 §7). */
    patch: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('PATCH', path, body, headers),
    put: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('PUT', path, body, headers),
    delete: <T>(path: string, headers?: Record<string, string>) => request<T>('DELETE', path, undefined, headers),
  };
};

export type BinesClient = ReturnType<typeof createClient>;
