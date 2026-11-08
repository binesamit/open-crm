// SPDX-License-Identifier: AGPL-3.0-only
import { MAP_ORIGIN_MAX, mapSettingsSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Env } from '../../env';
import { loadPlatformSettings } from '../platform/platform-settings';
import { accountMapSettings } from './geo.repo';

/**
 * Map origins in the page's CSP (M8 ד10): nothing hard-coded — the server default style (`MAP_STYLE_URL`), the
 * deployment's `MAP_ORIGINS`, and every account's chosen style URL and extra origins (Administration →
 * Connections). The accounts' part is read from the database at most once a minute (and again right after a
 * change in this process), so a new tile provider works without a deploy.
 */
const originOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
};

/** The deployment's own map origins (env): the default style's origin and MAP_ORIGINS. */
export const configuredMapOrigins = (env: Partial<Pick<Env, 'MAP_STYLE_URL' | 'MAP_ORIGINS'>>): string[] => {
  const list = [originOf(env.MAP_STYLE_URL), ...(env.MAP_ORIGINS ?? '').split(',').map((s) => originOf(s.trim()))];
  return [...new Set(list.filter((o): o is string => !!o))];
};

/**
 * At most this many characters of account map origins join the CSP (S-31): every account's origins go into every
 * page's header, so one account must not be able to grow it until proxies / browsers refuse the page.
 */
export const ACCOUNT_MAP_ORIGINS_BUDGET = 8_000;

/**
 * Origins of the accounts' map settings (style URL + extra origins), within ACCOUNT_MAP_ORIGINS_BUDGET — and only
 * those the platform owner approved (`approved`, audit 2026-10-10 #8: the CSP is every account's).
 */
export const accountOrigins = (all: unknown[], approved: ReadonlySet<string>): string[] => {
  const out = new Set<string>();
  let size = 0;
  const add = (o: string | null) => {
    if (!o || !approved.has(o)) return;
    if (o.length > MAP_ORIGIN_MAX || out.has(o) || size + o.length + 1 > ACCOUNT_MAP_ORIGINS_BUDGET) return;
    out.add(o);
    size += o.length + 1;
  };
  for (const raw of all) {
    const m = mapSettingsSchema.safeParse(raw ?? {});
    if (!m.success) continue;
    add(originOf(m.data.style_url));
    for (const o of m.data.extra_origins) add(originOf(o));
  }
  return [...out];
};

const TTL_MS = 60_000;
let cache: { at: number; origins: string[] } | null = null;
let loading: Promise<string[]> | null = null;

/** Drops the cached account origins (a settings change in this process shows on the next page load). */
export const forgetMapOrigins = () => {
  cache = null;
};

/** The accounts' map origins, cached for a minute; [] when the database cannot be read (the env ones still apply). */
export const mapOrigins = async (db: Db, now = Date.now()): Promise<string[]> => {
  if (cache && now - cache.at < TTL_MS) return cache.origins;
  loading ??= Promise.all([accountMapSettings(db), loadPlatformSettings(db)])
    .then(([rows, platform]) => accountOrigins(rows, new Set(platform.maps.approved_origins)))
    .catch(() => cache?.origins ?? [])
    .then((origins) => {
      cache = { at: Date.now(), origins };
      loading = null;
      return origins;
    });
  return loading;
};
