// SPDX-License-Identifier: AGPL-3.0-only
import { platformPublicAddressSchema, resolvePublicAddress, type PublicAddressEnv } from '@bines/shared';
import type { SqlClient } from './repositories/trash.repo';

/**
 * The worker's side of the one public-address resolver (M11): every link in a notification / digest / SLA email and
 * in a push message is built on the platform owner's setting (platform_settings row `platform`, `public_address`),
 * else on the worker's own WEB_ORIGIN. Read from the database (cached briefly), so a domain changed in the owner
 * console reaches the worker without a redeploy — and a worker whose WEB_ORIGIN was never updated still links right.
 */
const CACHE_MS = 30_000;
let cached: { at: number; web: string } | null = null;

export const appUrlFrom = async (db: SqlClient, env: PublicAddressEnv = process.env): Promise<string> => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.web;
  const row = (
    await db.query(`select settings->'public_address' as public_address from platform_settings where id = 'platform'`)
  ).rows[0] as { public_address?: unknown } | undefined;
  const parsed = platformPublicAddressSchema.safeParse(row?.public_address ?? {});
  const web = resolvePublicAddress(parsed.success ? parsed.data : undefined, env).web;
  cached = { at: Date.now(), web };
  return web;
};

/** Tests: forget the cached address. */
export const resetAppUrlCache = () => {
  cached = null;
};
