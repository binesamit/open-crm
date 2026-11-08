// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../../db/client';
import type { PublicFormPage } from '../../middleware/security-headers';
import { embedAllowedByToken } from './forms.repo';

/**
 * The public form page's CSP input (`/f/<token>`): whether the form allows embedding. Read at most every 30 s
 * per token, so a page load never waits on the database twice; an unknown token or a read error = not embeddable.
 */
const TTL_MS = 30_000;
const MAX_ENTRIES = 5000;
const cache = new Map<string, { at: number; embed: boolean }>();

export const formPagePolicy =
  (db: Db) =>
  async (path: string): Promise<PublicFormPage> => {
    const token = /^\/f\/([a-z0-9]{6,64})\/?$/.exec(path)?.[1];
    if (!token) return { embed: false };
    const now = Date.now();
    const hit = cache.get(token);
    if (hit && now - hit.at < TTL_MS) return { embed: hit.embed };
    const embed = await embedAllowedByToken(db, token).catch(() => false);
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(token, { at: now, embed });
    return { embed };
  };

/** Drops a token's cached policy (a saved form shows its embedding setting on the next page load). */
export const forgetFormPage = (token: string) => {
  cache.delete(token);
};
