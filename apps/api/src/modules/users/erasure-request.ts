// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AppError, newId } from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { Db } from '../../db/client';
import { accountMembers, accounts } from '../../db/schema';
import { st } from '../../lib/i18n';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { accountMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { findStaffRoleOf } from '../tickets/tickets.repo';
import { activeAdminsOf, anonymiseUser, deleteIdentitiesOf, deleteSessionsOf } from './admin.repo';
import { ANON_EMAIL_DOMAIN } from './admin.service';

/**
 * The right to erasure, asked by the person (privacy — GDPR art. 17; Israel Privacy Law §14)
 *
 * - In accounts: each account is the controller of what it holds about its members, so the person **asks** — the
 *   request is recorded on each active membership (`settings.erasure_requested_at`), every admin of that account
 *   is emailed, and the admin carries it out with the existing "deactivate → delete details". The person may
 *   withdraw it while it is pending.
 * - Without any account (a person who left them all): nobody else holds the data — the details are deleted at once
 *   (anonymised as "delete details" does), signs-ins and sessions with them.
 *
 * Platform owners, support staff and service identities cannot erase themselves here (their access matters to
 * others); they write to the privacy address.
 */
const REQUESTED = 'erasure_requested_at';

const liveMemberships = (db: Db, userId: string) =>
  db
    .select({
      id: accountMembers.id,
      accountId: accountMembers.accountId,
      settings: accountMembers.settings,
      account: accounts,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(
      and(
        eq(accountMembers.userId, userId),
        inArray(accountMembers.status, ['active', 'deactivated']),
        isNull(accounts.deletedAt),
      ),
    );

const assertMayErase = async (db: Db, user: SessionUser) => {
  if (user.isService) throw new AppError('forbidden', 'not_for_service_users');
  if (user.isPlatformOwner || (await findStaffRoleOf(db, user.id)))
    throw new AppError('forbidden', 'staff_write_to_privacy');
};

/** POST /me/erasure-request — `confirm_email` must be the person's own address (a deliberate act, not a mis-click). */
export const requestErasure = async (
  deps: Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>,
  user: SessionUser,
  confirmEmail: string,
  meta: RequestMeta,
) => {
  await assertMayErase(deps.db, user);
  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase())
    throw new AppError('validation_failed', 'confirm_email_mismatch');
  const rows = await liveMemberships(deps.db, user.id);

  if (!rows.length) {
    // No account holds them: erase now.
    await deps.db.transaction(async (tx) => {
      await anonymiseUser(
        tx,
        user.id,
        `deleted+${newId().toLowerCase()}@${ANON_EMAIL_DOMAIN}`,
        st('server.deletedUser'),
      );
      await deleteIdentitiesOf(tx, user.id);
      await deleteSessionsOf(tx, user.id);
    });
    return { status: 'erased' as const, accounts: [] as string[] };
  }

  const now = new Date().toISOString();
  const asked: string[] = [];
  for (const r of rows) {
    const settings = (r.settings ?? {}) as Record<string, unknown>;
    if (settings[REQUESTED]) {
      asked.push(r.accountId);
      continue;
    }
    await deps.db
      .update(accountMembers)
      .set({ settings: { ...settings, [REQUESTED]: now }, updatedAt: new Date() })
      .where(eq(accountMembers.id, r.id));
    await recordAudit(deps.db, {
      accountId: r.accountId,
      actorId: user.id,
      action: 'user.erasure_requested',
      targetType: 'user',
      targetId: user.id,
      payload: {},
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const url = await appLink(deps, `/a/${r.account.slug}/admin/users`);
    for (const admin of await activeAdminsOf(deps.db, r.accountId)) {
      if (admin.id === user.id) continue;
      try {
        const brand = await accountMailBrand(deps, r.account, admin.locale);
        const l = brand.locale;
        const v = { name: user.name, email: user.email, account: r.account.name };
        await deps.mailer.send(
          noticeEmail({
            to: admin.email,
            brand,
            subject: st('privacy.erasure.mail.subject', v, l),
            title: st('privacy.erasure.mail.title', v, l),
            lines: [st('privacy.erasure.mail.body', v, l)],
            cta: { label: st('privacy.erasure.mail.cta', v, l), url },
            reason: st('privacy.erasure.mail.reason', v, l),
          }),
        );
      } catch (err) {
        deps.logger.warn({ err, accountId: r.accountId }, 'erasure request email failed');
      }
    }
    asked.push(r.accountId);
  }
  return { status: 'requested' as const, accounts: asked };
};

/** DELETE /me/erasure-request — the person withdraws a pending request (every account). */
export const withdrawErasure = async (db: Db, user: SessionUser, meta: RequestMeta) => {
  for (const r of await liveMemberships(db, user.id)) {
    const settings = { ...((r.settings ?? {}) as Record<string, unknown>) };
    if (!settings[REQUESTED]) continue;
    delete settings[REQUESTED];
    await db.update(accountMembers).set({ settings, updatedAt: new Date() }).where(eq(accountMembers.id, r.id));
    await recordAudit(db, {
      accountId: r.accountId,
      actorId: user.id,
      action: 'user.erasure_withdrawn',
      targetType: 'user',
      targetId: user.id,
      payload: {},
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
  return { ok: true as const };
};

/** When the person asked for erasure in this account (null = no pending request) — from the membership's settings. */
export const erasureRequestedAt = (settings: unknown): string | null => {
  const v = (settings as Record<string, unknown> | null)?.[REQUESTED];
  return typeof v === 'string' ? v : null;
};

/** GET /me/erasure-request — whether a request is pending, and where. */
export const myErasureRequest = async (db: Db, user: SessionUser) => {
  const rows = await liveMemberships(db, user.id);
  const pending = rows.filter((r) => erasureRequestedAt(r.settings)).map((r) => r.accountId);
  return { pending: pending.length > 0, accounts: pending, has_accounts: rows.length > 0 };
};
