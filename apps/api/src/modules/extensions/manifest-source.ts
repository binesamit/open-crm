// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type ExtensionManifest,
  type ExtensionSource,
  extensionManifestSchema,
  isLocalOrigin,
} from '@bines/shared';
import type { Env } from '../../env';
import { allowPrivateOutbound, outboundRequest } from '../../lib/outbound';
import type { Db } from '../../db/client';
import { findCatalogEntry } from './extensions.repo';

/** A manifest is small: anything larger is refused before it is parsed. */
export const MAX_MANIFEST_BYTES = 256 * 1024;

export type ResolvedManifest = {
  manifest: ExtensionManifest;
  source: 'url' | 'manifest' | 'catalog';
  sourceUrl: string | null;
};

const invalid = (issues: string[]) => new AppError('invalid_value', 'manifest_invalid', { issues });

/**
 * Checks that depend on where we run (layer 1 of the sandbox, MARKETPLACE §4.2): an extension's origins are never
 * our own origin (it would get our cookies and DOM), and outside development they are HTTPS and public.
 */
export const assertOriginsAllowed = (env: Pick<Env, 'NODE_ENV' | 'WEB_ORIGIN'>, m: ExtensionManifest) => {
  const ours = new Set<string>();
  try {
    ours.add(new URL(env.WEB_ORIGIN).origin);
  } catch {
    // WEB_ORIGIN is validated by env.ts
  }
  const issues: string[] = [];
  for (const o of m.origins) {
    if (ours.has(o)) issues.push(`origins: ${o} is this app's own origin`);
    if (env.NODE_ENV === 'production') {
      if (!o.startsWith('https://')) issues.push(`origins: ${o} must be https`);
      if (isLocalOrigin(o)) issues.push(`origins: ${o} is a local development origin`);
    }
  }
  if (issues.length) throw invalid(issues);
};

export const parseManifest = (env: Pick<Env, 'NODE_ENV' | 'WEB_ORIGIN'>, raw: unknown): ExtensionManifest => {
  const parsed = extensionManifestSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  assertOriginsAllowed(env, parsed.data);
  return parsed.data;
};

/** Fetches a manifest by URL: SSRF-guarded (lib/outbound), no redirects, 256 KB, 10 s. */
export const fetchManifest = async (env: Pick<Env, 'NODE_ENV' | 'WEB_ORIGIN'>, url: string): Promise<unknown> => {
  if (env.NODE_ENV === 'production' && !url.startsWith('https://'))
    throw new AppError('invalid_value', 'manifest_url_not_https');
  let res;
  try {
    res = await outboundRequest(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 10_000,
      allowPrivate: allowPrivateOutbound(env),
      maxBytes: MAX_MANIFEST_BYTES + 1,
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('invalid_value', 'manifest_unreachable');
  }
  if (!res.ok) throw new AppError('invalid_value', 'manifest_unreachable', { status: res.status });
  if (Buffer.byteLength(res.body) > MAX_MANIFEST_BYTES) throw new AppError('payload_too_large', 'manifest_too_large');
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw invalid(['(root): not JSON']);
  }
};

/** A source (URL / pasted JSON / catalog key) → a validated manifest. */
export const resolveSource = async (
  deps: { env: Pick<Env, 'NODE_ENV' | 'WEB_ORIGIN'>; db: Db },
  source: ExtensionSource,
): Promise<ResolvedManifest> => {
  if ('catalog_key' in source) {
    const row = await findCatalogEntry(deps.db, source.catalog_key);
    if (!row) throw new AppError('not_found', 'Extension not found');
    return { manifest: parseManifest(deps.env, row.manifest), source: 'catalog', sourceUrl: null };
  }
  if ('manifest_url' in source) {
    const raw = await fetchManifest(deps.env, source.manifest_url);
    return { manifest: parseManifest(deps.env, raw), source: 'url', sourceUrl: source.manifest_url };
  }
  if (Buffer.byteLength(JSON.stringify(source.manifest)) > MAX_MANIFEST_BYTES)
    throw new AppError('payload_too_large', 'manifest_too_large');
  return { manifest: parseManifest(deps.env, source.manifest), source: 'manifest', sourceUrl: null };
};
