// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { APP_PAGE_BADGE_EVENT, AppError, type ExtensionAppPage, newId, type SetAppPageBadge } from '@bines/shared';
import type { Db } from '../../db/client';
import { extensionAppPageBadges } from '../../db/schema';
import { EVENTS_CHANNEL } from '../../lib/realtime';
import { RateLimiter } from '../../lib/rate-limit';
import type { Actor, AppDeps } from '../../types';
import { activeMemberIds } from '../automations/automations.repo';
import { liveInstallation, type LiveInstallation } from './ext-token';
import type { ExtActor } from './ext-storage';
import { listFrameFeatures, mayUse } from './extensions.service';

/**
 * an extension's page in the sidebar (`app_page`) and the count beside it. Generic: any extension may
 * add pages; the count is a number it keeps up to date — the account's (everyone sees it) or one member's (wins over
 * the account's for that member). Who sets it:
 * - its server (`bos_xat_`): the account's count, or any active member's (`user_id`);
 * - its page (`bos_ext_`, or `setBadge` through the app): only its own user's count.
 * Only for its own installation and its own `app_page` keys; every change reaches open apps over `/me/events`.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets'>;

/** Count changes per installation per minute (a busy inbox moves a lot, but never this much). */
const writes = new RateLimiter(600, 60_000);

const appPageOf = (live: LiveInstallation, key: string) => {
  const f = live.manifest.features.find((x) => x.key === key);
  if (!f || f.type !== 'app_page') throw new AppError('not_found', 'App page not found');
  return f;
};

/** The badge rows that matter to this member on these installations: the account's and their own. */
const badgesFor = async (db: Db, installationIds: string[], userId: string) =>
  installationIds.length
    ? db
        .select({
          installationId: extensionAppPageBadges.installationId,
          feature: extensionAppPageBadges.feature,
          userId: extensionAppPageBadges.userId,
          count: extensionAppPageBadges.count,
        })
        .from(extensionAppPageBadges)
        .where(
          and(
            inArray(extensionAppPageBadges.installationId, installationIds),
            or(isNull(extensionAppPageBadges.userId), eq(extensionAppPageBadges.userId, userId)),
          ),
        )
    : [];

/**
 * GET /extensions/app-pages — the sidebar pages of enabled, not-killed installations this member may open (guests
 * only where allowed), each with its count: mine, else the account's, else none.
 */
export const listAppPages = async (deps: Deps, a: Actor): Promise<{ data: ExtensionAppPage[] }> => {
  const pages = (await listFrameFeatures(deps, a, { type: 'app_page' })).data;
  const rows = await badgesFor(deps.db, [...new Set(pages.map((p) => p.installation_id))], a.user.id);
  const at = (p: { installation_id: string; feature: string }, user: string | null) =>
    rows.find((r) => r.installationId === p.installation_id && r.feature === p.feature && r.userId === user)?.count;
  return { data: pages.map((p) => ({ ...p, badge: at(p, a.user.id) ?? at(p, null) ?? null })) };
};

/** Store (or, with `count: null`, remove) one count, then tell the open apps it is for. */
const writeBadge = async (
  db: Db,
  input: { accountId: string; installationId: string; feature: string; userId: string | null; count: number | null },
) => {
  const wait = writes.hit(input.installationId);
  if (wait > 0) throw new AppError('rate_limited', 'Too many badge changes', { retry_after_ms: wait });
  const t = extensionAppPageBadges;
  const who = input.userId === null ? isNull(t.userId) : eq(t.userId, input.userId);
  if (input.count === null)
    await db.delete(t).where(and(eq(t.installationId, input.installationId), eq(t.feature, input.feature), who));
  else
    await db.execute(sql`
      insert into ${t} (id, account_id, installation_id, feature, user_id, count)
      values (${newId()}, ${input.accountId}, ${input.installationId}, ${input.feature}, ${input.userId}, ${input.count})
      on conflict (installation_id, feature, (coalesce(user_id, '')))
      do update set count = excluded.count, updated_at = now()`);
  // No activity row (a count is not history): the event alone, the type only — the sidebar refetches.
  await db.execute(
    sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({
      id: '',
      account_id: input.accountId,
      type: APP_PAGE_BADGE_EVENT,
      user_id: input.userId,
    })})`,
  );
  return { key: input.feature, count: input.count, user_id: input.userId };
};

/** PUT /ext/app-pages/:key/badge — the extension's server or page (its token). */
export const setBadgeAsExtension = async (deps: Deps, a: ExtActor, key: string, input: SetAppPageBadge) => {
  const ext = a.token?.ext;
  if (!ext) throw new AppError('forbidden', 'extension_token_only');
  const live = await liveInstallation(deps.db, ext.installationId, a.ctx.accountId);
  if (!live) throw new AppError('not_found', 'Extension not found');
  appPageOf(live, key);
  let userId: string | null;
  if (ext.server) {
    userId = input.user_id ?? null;
    if (userId && !(await activeMemberIds(deps.db, a.ctx.accountId, [userId])).has(userId))
      throw new AppError('not_found', 'Member not found');
  } else {
    // A page speaks for the member on it, never for anyone else (nor for the whole account).
    if (input.user_id && input.user_id !== a.user.id) throw new AppError('forbidden', 'badge_own_only');
    userId = a.user.id;
  }
  return writeBadge(deps.db, {
    accountId: a.ctx.accountId,
    installationId: live.row.id,
    feature: key,
    userId,
    count: input.count,
  });
};

/**
 * PUT /extensions/installations/:id/app-pages/:key/badge — `setBadge` from one of the extension's pages, through the
 * app (the person's session): only their own count, only where they may open the extension.
 */
export const setBadgeFromPage = async (
  deps: Deps,
  a: Actor,
  installationId: string,
  key: string,
  input: SetAppPageBadge,
) => {
  const live = await liveInstallation(deps.db, installationId, a.ctx.accountId);
  if (!live || !mayUse(a.ctx, live.row)) throw new AppError('not_found', 'Extension not found');
  appPageOf(live, key);
  if (input.user_id && input.user_id !== a.user.id) throw new AppError('forbidden', 'badge_own_only');
  return writeBadge(deps.db, {
    accountId: a.ctx.accountId,
    installationId: live.row.id,
    feature: key,
    userId: a.user.id,
    count: input.count,
  });
};
