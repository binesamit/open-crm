// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the service worker keeps on the phone (PWA פ2, the planning notes "PWA" §2): only the app's own files — the hashed
 * Vite assets (identical for everyone, no one's data) and the page shell. Never an API answer, never a file.
 * Shared by the build (vite-pwa.ts writes the list into sw.js) and the tests.
 */

/**
 * How the service worker answers a request (`swRoute` is copied verbatim into sw.js — keep it self-contained).
 * Never touched: the API, the MCP server, OAuth, discovery documents, the worker itself.
 * `network` = not ours to answer (the browser goes to the server as if there were no worker), `shell` = a page
 * navigation (network first, the cached shell when offline), `asset` = a hashed file (cache first).
 */
export function swRoute(pathname: string, method: string, mode: string): 'network' | 'shell' | 'asset' {
  if (method !== 'GET') return 'network';
  const never = ['/api/', '/mcp', '/oauth', '/.well-known', '/sw.js'];
  for (const p of never) if (pathname === p.replace(/\/$/, '') || pathname.startsWith(p)) return 'network';
  if (mode === 'navigate') return 'shell';
  if (pathname.startsWith('/assets/') && !pathname.endsWith('.map')) return 'asset';
  return 'network';
}

/**
 * The request that marks a clicked push notification read (copied verbatim into sw.js — keep it self-contained):
 * the bell's own endpoint, with the session cookie (same origin) and the notification's account, never cached.
 * null when the push did not carry both ids (an older payload): the click still opens the item.
 */
export function swMarkRead(data: unknown): {
  url: string;
  init: {
    method: 'POST';
    credentials: 'same-origin';
    cache: 'no-store';
    headers: Record<string, string>;
    body: string;
  };
} | null {
  const d = (data ?? {}) as { id?: unknown; account_id?: unknown };
  const ok = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Za-z]{1,64}$/.test(v);
  if (!ok(d.id) || !ok(d.account_id)) return null;
  return {
    url: '/api/v1/me/notifications/read',
    init: {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-account-id': d.account_id },
      body: JSON.stringify({ ids: [d.id] }),
    },
  };
}

/** A built file the worker may keep: a hashed asset (not a source map), never anything under the API. */
export const isPrecacheable = (fileName: string) => {
  const path = `/${fileName.replace(/^\/+/, '')}`;
  return path.startsWith('/assets/') && !path.endsWith('.map') && swRoute(path, 'GET', 'no-cors') === 'asset';
};

/** The part of a Rollup output chunk / asset the list needs. */
export type BundleEntry =
  | {
      type: 'chunk';
      fileName: string;
      isEntry: boolean;
      imports: string[];
      viteMetadata?: { importedCss?: Set<string> };
    }
  | { type: 'asset'; fileName: string };

/**
 * Installed up front: the entry chunk with everything it imports statically, every stylesheet and font. Pages loaded
 * on demand (lazy chunks) are kept the first time they are used (runtime cache, still hashed files only).
 */
export const precacheList = (bundle: Record<string, BundleEntry>): string[] => {
  const out = new Set<string>();
  const visit = (name: string) => {
    const entry = bundle[name];
    if (!entry || out.has(name)) return;
    out.add(name);
    if (entry.type === 'chunk') {
      entry.imports.forEach(visit);
      entry.viteMetadata?.importedCss?.forEach((css) => out.add(css));
    }
  };
  for (const entry of Object.values(bundle)) if (entry.type === 'chunk' && entry.isEntry) visit(entry.fileName);
  for (const entry of Object.values(bundle))
    if (entry.type === 'asset' && /\.(css|woff2?)$/.test(entry.fileName)) out.add(entry.fileName);
  return [...out]
    .filter(isPrecacheable)
    .sort()
    .map((f) => `/${f}`);
};

/** A short, stable id of a build (changes when any precached file does: a new deploy = a new worker). */
export const buildId = (files: string[]) => {
  let h = 2166136261;
  for (const ch of files.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h.toString(36);
};
