// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '@bines/sdk';

/**
 * Round 12 (product owner: "sometimes the system just shows an empty page with an error"). What a crash was, in words a
 * person can act on — the error screen (`error-screen.tsx`) picks its text and its main button from this:
 *  - `chunk`: a new version was deployed while the tab was open, and a page's code file (lazy chunk) of the old
 *    version is gone — only a reload helps (and `reloadForNewVersion` does it once by itself);
 *  - `offline` / `server`: the server could not be reached or failed (a deploy restarting it) — trying again helps;
 *  - `not_found` / `forbidden`: the thing is gone or not yours;
 *  - `app`: a bug in the page — reported to GlitchTip; trying again re-renders it.
 */
export type ErrorKind = 'chunk' | 'offline' | 'server' | 'not_found' | 'forbidden' | 'app';

const CHUNK =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk [\w-]+ failed/i;

const messageOf = (err: unknown) =>
  err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : String((err as { message?: unknown } | null)?.message ?? '');

export const isChunkLoadError = (err: unknown) =>
  CHUNK.test(messageOf(err)) || (err as Error | null)?.name === 'ChunkLoadError';

export const classifyError = (err: unknown): ErrorKind => {
  if (isChunkLoadError(err)) return 'chunk';
  if (err instanceof ApiError) {
    // A body that was not JSON (a proxy's page while the API restarts) — the SDK marks it `unavailable`.
    if (err.body?.code === 'unavailable') return 'server';
    if (err.status === 404) return 'not_found';
    if (err.status === 403) return 'forbidden';
    if (err.status === 0 || err.status >= 500 || err.status === 429) return err.status === 0 ? 'offline' : 'server';
    return 'app';
  }
  // fetch() itself failed (no network, the server restarting).
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return 'offline';
  return 'app';
};

/** Errors worth a quiet retry before showing anything (a blip while the server restarts). */
export const isTransient = (err: unknown) => {
  const kind = classifyError(err);
  return kind === 'offline' || kind === 'server';
};

/** React Query `retry` for the data a page cannot render without (session, accounts): blips only, 3 times. */
export const retryTransient = (failureCount: number, err: unknown) => failureCount < 3 && isTransient(err);

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const RELOAD_KEY = 'bines.chunk-reload';
/** At most one automatic reload per this long — a chunk that is really missing must not loop. */
const RELOAD_WINDOW_MS = 60_000;

/**
 * A chunk of an older deploy failed to load: reloads the page once (the new index.html names the new chunks).
 * Returns whether it reloaded; a second failure within a minute shows the error screen instead.
 */
export const reloadForNewVersion = (
  store: Store | null = safeSession(),
  now = Date.now(),
  reload: () => void = () => window.location.reload(),
) => {
  try {
    const last = Number(store?.getItem(RELOAD_KEY) ?? 0);
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    store?.setItem(RELOAD_KEY, String(now));
  } catch {
    // No storage (private mode): still reload once — the page has no other way to recover.
  }
  reload();
  return true;
};

const safeSession = (): Store | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
