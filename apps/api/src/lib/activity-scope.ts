// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopeAllows } from '@bines/shared';

/**
 * A request-wide stamp for activity rows (CLAUDE.md rule 2): a request made by an extension (D27, ת2) runs inside
 * this scope, so every event it writes — through any service — carries `meta.via = 'app'` + which app, and the
 * request's batch id: one call = one undoable action ("via app X" in the log, like "via Claude" for MCP).
 * A request by a narrowed API token adds `tokenLimitStamp` to the meta (no batch of its own, S-64).
 */
export type ActivityScope = { batchId?: string; meta: Record<string, unknown> };

const storage = new AsyncLocalStorage<ActivityScope>();

export const runInActivityScope = <T>(scope: ActivityScope, fn: () => Promise<T>): Promise<T> => storage.run(scope, fn);

export const currentActivityScope = (): ActivityScope | undefined => storage.getStore();

/**
 * What the events of a narrowed token say about it (S-64), so work they start later in the background (an AI
 * column's auto-run) keeps the same limits: its board limit, and its scopes when they leave out reads such work
 * does (updates). Empty for a session or an unlimited token — most events carry nothing extra.
 */
export const tokenLimitStamp = (boardLimit: string[] | null | undefined, scopes: string[] | null | undefined) => ({
  ...(boardLimit ? { board_limit: boardLimit } : {}),
  ...(scopes && !scopeAllows(scopes, 'updates:read') ? { token_scopes: scopes } : {}),
});
