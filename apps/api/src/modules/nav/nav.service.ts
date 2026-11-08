// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import {
  AppError,
  cleanAccountNav,
  cleanNavPlacement,
  type AccountNav,
  type NavLayoutResponse,
  type NavPlacement,
  resolveNavLayout,
  type SetAccountNav,
  type SetMyNav,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers } from '../../db/schema';
import { assertAccountAdmin } from '../../lib/account-admin';
import type { RequestMeta } from '../../types';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import type { AdminActor } from '../admin/security.service';
import { recordAudit } from '../audit/audit.repo';
import { memberSettings } from '../mywork/mywork.repo';

/**
 * where the shell's general places sit on the desktop — the sidebar or the top bar. The account's
 * default lives in `account_settings.settings.nav` (admins; `locked` = members follow it), the member's own choice in
 * `account_members.settings.nav` (that key only, merged in, so other keys there are never touched).
 */
type Actor = Pick<AdminActor, 'ctx' | 'user' | 'requestId'>;

const accountNavOf = async (db: Db, accountId: string): Promise<AccountNav> =>
  cleanAccountNav(((await getAccountSettings(db, accountId)) as { nav?: unknown }).nav);

const mineOf = async (db: Db, accountId: string, userId: string): Promise<NavPlacement | null> => {
  const v = ((await memberSettings(db, accountId, userId)) as { nav?: unknown }).nav;
  return v && typeof v === 'object' ? cleanNavPlacement(v) : null;
};

const responseOf = (mine: NavPlacement | null, account: AccountNav): NavLayoutResponse => ({
  layout: resolveNavLayout(mine, account),
  mine,
  account,
});

/** GET /me/nav — the layout in effect for me here, my own placement and the account's default. */
export const myNav = async (db: Db, a: Actor): Promise<NavLayoutResponse> => {
  const [mine, account] = await Promise.all([
    mineOf(db, a.ctx.accountId, a.user.id),
    accountNavOf(db, a.ctx.accountId),
  ]);
  return responseOf(mine, account);
};

/** PUT /me/nav — my own placement (null = follow the account). Refused while the account's layout is locked. */
export const setMyNav = async (db: Db, a: Actor, input: SetMyNav): Promise<NavLayoutResponse> => {
  const account = await accountNavOf(db, a.ctx.accountId);
  if (account.locked && input.placement !== null) throw new AppError('forbidden', 'nav_locked');
  const where = and(eq(accountMembers.accountId, a.ctx.accountId), eq(accountMembers.userId, a.user.id));
  if (input.placement === null) {
    await db
      .update(accountMembers)
      .set({ settings: sql`${accountMembers.settings} - 'nav'` })
      .where(where);
  } else {
    const json = JSON.stringify(cleanNavPlacement(input.placement));
    await db
      .update(accountMembers)
      .set({ settings: sql`${accountMembers.settings} || jsonb_build_object('nav', ${json}::jsonb)` })
      .where(where);
  }
  return myNav(db, a);
};

/** PUT /accounts/me/nav (admins) — the account's default and lock; one `account.updated` event + audit row. */
export const setAccountNav = async (
  db: Db,
  a: Actor,
  input: SetAccountNav,
  meta: RequestMeta,
): Promise<NavLayoutResponse> => {
  assertAccountAdmin(a.ctx);
  const after: AccountNav = { placement: cleanNavPlacement(input.placement), locked: input.locked };
  await db.transaction(async (tx) => {
    const settings = await getAccountSettings(tx, a.ctx.accountId);
    const before = cleanAccountNav((settings as { nav?: unknown }).nav);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await upsertAccountSettings(tx, a.ctx.accountId, { ...settings, nav: after }, a.user.id);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'account.updated',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      before: { nav: before },
      after: { nav: after },
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'account.updated',
      targetType: 'account',
      targetId: a.ctx.accountId,
      payload: { fields: ['nav'], before: { nav: before }, after: { nav: after } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return myNav(db, a);
};
