// SPDX-License-Identifier: AGPL-3.0-only
import {
  absoluteUrl,
  normalizeOrigin,
  type PlatformPublicAddress,
  type PublicAddressEnv,
  resolvePublicAddress,
  type ResolvedPublicAddress,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Env } from '../../env';
import type { Logger } from '../../lib/logger';
import type { FileStorage } from '../../lib/storage';
import { loadPlatformSettings } from './platform-settings';

/**
 * The API's side of the one public-address resolver (M11): the owner's setting (platform_settings row `platform`,
 * cached 30s and cleared on save) else WEB_ORIGIN. Every absolute link the API builds goes through here, so a new
 * domain set in the owner console applies without a redeploy.
 */
export type PublicAddressDeps = { db: Db; env: Pick<Env, 'WEB_ORIGIN'> & Partial<Pick<Env, 'BETTER_AUTH_URL'>> };

export const publicAddress = async (deps: PublicAddressDeps): Promise<ResolvedPublicAddress> =>
  resolvePublicAddress((await loadPlatformSettings(deps.db)).public_address, deps.env);

/** The app's origin (no trailing slash): links people open. */
export const webOrigin = async (deps: PublicAddressDeps) => (await publicAddress(deps)).web;

/** The API's origin (= the app's unless set): API reference, MCP, OAuth issuer, extension API base. */
export const apiOrigin = async (deps: PublicAddressDeps) => (await publicAddress(deps)).api;

/** An absolute link to a path of the app. */
export const appLink = async (deps: PublicAddressDeps, path: string) => absoluteUrl(await webOrigin(deps), path);

/**
 * The origins the file bucket lets browsers upload from / download to: the address in effect, the previous ones kept
 * during a move and WEB_ORIGIN — deduplicated.
 */
export const bucketCorsOrigins = (saved: Partial<PlatformPublicAddress> | undefined, env: PublicAddressEnv) => {
  const envWeb = env.WEB_ORIGIN ? normalizeOrigin(env.WEB_ORIGIN) : null;
  const previous = (saved?.previous_origins ?? []).map((o) => normalizeOrigin(o));
  return [...new Set([resolvePublicAddress(saved, env).web, ...previous, envWeb].filter((o): o is string => !!o))];
};

/**
 * Applies those origins to the bucket's CORS — only when we manage it (S3_SET_CORS; the storage then offers
 * `setCorsOrigins`). At boot and after the owner saves the public address. Best effort: a failure is logged, never
 * thrown (the save itself already succeeded).
 */
export const syncBucketCors = async (deps: {
  db: Db;
  env: Pick<Env, 'WEB_ORIGIN' | 'S3_SET_CORS'> & Partial<Pick<Env, 'BETTER_AUTH_URL'>>;
  storage: FileStorage;
  logger: Logger;
}) => {
  if (!deps.env.S3_SET_CORS || !deps.storage.setCorsOrigins) return null;
  try {
    const origins = bucketCorsOrigins((await loadPlatformSettings(deps.db)).public_address, deps.env);
    await deps.storage.setCorsOrigins(origins);
    return origins;
  } catch (err) {
    deps.logger.warn({ err: String(err) }, 'could not set bucket CORS');
    return null;
  }
};
