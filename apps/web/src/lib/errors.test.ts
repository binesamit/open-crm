// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@bines/sdk';
import { classifyError, isChunkLoadError, reloadForNewVersion, retryTransient } from './errors';

const api = (status: number, code = 'bad_request') =>
  new ApiError(status, { code: code as 'bad_request', message: code, request_id: '' });

describe('round 12: what a crash was', () => {
  it('knows a chunk of an older deploy (Chrome, Firefox, Safari, CSS)', () => {
    for (const msg of [
      'Failed to fetch dynamically imported module: https://x/assets/DocPage-abc.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      'Unable to preload CSS for /assets/x.css',
    ])
      expect(isChunkLoadError(new TypeError(msg))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(classifyError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe('chunk');
  });

  it('tells a blip from a bug', () => {
    expect(classifyError(api(502))).toBe('server');
    expect(classifyError(api(200, 'unavailable'))).toBe('server'); // an HTML page while the API restarts
    expect(classifyError(new TypeError('Failed to fetch'))).toBe('offline');
    expect(classifyError(api(404))).toBe('not_found');
    expect(classifyError(api(403))).toBe('forbidden');
    expect(classifyError(api(422))).toBe('app');
    expect(classifyError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe('app');
  });

  it('retries the data a page needs on blips only, three times', () => {
    expect(retryTransient(0, api(503))).toBe(true);
    expect(retryTransient(2, api(503))).toBe(true);
    expect(retryTransient(3, api(503))).toBe(false);
    expect(retryTransient(0, api(403))).toBe(false);
    expect(retryTransient(0, new Error('bug'))).toBe(false);
  });

  it('reloads to the new version once a minute at most', () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const reload = vi.fn();
    expect(reloadForNewVersion(store, 1_000_000, reload)).toBe(true);
    expect(reloadForNewVersion(store, 1_030_000, reload)).toBe(false); // the chunk is really missing: no loop
    expect(reloadForNewVersion(store, 1_070_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
