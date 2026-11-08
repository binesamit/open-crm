// SPDX-License-Identifier: AGPL-3.0-only
import { absoluteUrl, AppError, canAccount } from '@bines/shared';
import { assertPasswordLength, userPasswordMin } from '../../auth/password-policy';
import { resetPasswordEmail } from '@bines/server-mail';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { RateLimiter } from '../../lib/rate-limit';
import { ipBucket } from '../../lib/client-ip';
import { newSecretToken } from '../../lib/tokens';
import { recordEvent } from '../activity/activity.repo';
import { findAccountById } from '../accounts/accounts.repo';
import { recordAudit } from '../audit/audit.repo';
import { assertMayTakeOverSignIn, findMemberWithUser } from './admin.repo';
import { deleteResetTokensOf, findUserById, findUserIdByEmail, hasPassword, signInProvidersOf } from './users.repo';
import { ANON_EMAIL_DOMAIN, type AdminActor } from './admin.service';
import { removeTwoFactor, twoFactorEnabledOf } from '../admin/two-factor.repo';
import { myTwoFactor } from '../admin/two-factor.service';
import { platformMailBrand } from '../platform/mail-brand';
import { assertOwnerMayAct } from '../support/support.access';
import { webOrigin } from '../platform/public-address';

/**
 * Sign-in that does not depend on email (fix8: "מה הגיבוי שלי אם המיילים לא עובדים לי להתחברות?"):
 * - an account admin (or the platform owner, from the owner console) makes a one-time link for a member — copied
 *   and sent by WhatsApp etc., never emailed. It opens /login#reset=<token> (a fragment: never sent to a server,
 *   so it reaches no access log), where the member chooses a password and is signed in.
 * - the link is a Better Auth password-reset token: single use (consumed on use), 1 hour, and making a new one
 *   drops the member's earlier unused ones. Every link made is in the audit log (never the token itself).
 * - in the profile, a member with no password sets one (`setMyPassword`); changing one goes through Better Auth's
 *   /change-password, which needs the current password.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'auth'>;

export const RECOVERY_TTL_MS = 60 * 60 * 1000;

/** Links per admin per hour — plenty for real use, a wall for a script. */
const linkLimiter = new RateLimiter(20, 60 * 60 * 1000);
/** First-password attempts per user per 15 minutes. */
const passwordLimiter = new RateLimiter(10, 15 * 60 * 1000);

const resetIdentifier = (token: string) => `reset-password:${token}`;

export const issueResetLink = async (deps: Deps, userId: string) => {
  const ctx = await deps.auth.$context;
  const token = newSecretToken(24);
  const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS);
  await deleteResetTokensOf(deps.db, userId);
  await ctx.internalAdapter.createVerificationValue({ identifier: resetIdentifier(token), value: userId, expiresAt });
  return { url: absoluteUrl(await webOrigin(deps), `/login#reset=${token}`), expires_at: expiresAt.toISOString() };
};

export const limitRecoveryLinks = (actorId: string) => {
  const wait = linkLimiter.hit(actorId);
  if (wait > 0) throw new AppError('rate_limited', 'Too many sign-in links', { retry_after_ms: wait });
};

/**
 * POST /users/:id/recovery-link — admins only. Never yourself (the profile is for that), never a deactivated or
 * anonymised member, never the platform owner unless you are them, and never someone who is also active in
 * another account (their password opens that account too — the platform owner does that one).
 */
export const accountRecoveryLink = async (deps: Deps, a: AdminActor, userId: string, meta: RequestMeta) => {
  const decision = canAccount(a.ctx.role, 'users.manage');
  if (!decision.ok) throw new AppError('forbidden', decision.reason);
  const m = await findMemberWithUser(deps.db, a.ctx.accountId, userId);
  if (!m) throw new AppError('not_found', 'User not found');
  if (userId === a.user.id) throw new AppError('forbidden', 'self');
  if (m.membership.status !== 'active' || m.user.email.endsWith(`@${ANON_EMAIL_DOMAIN}`))
    throw new AppError('forbidden', 'user_not_active');
  // S-52: never someone whose sign-in opens more than this account (the platform owner does those).
  if (!a.user.isPlatformOwner) await assertMayTakeOverSignIn(deps.db, a.ctx.accountId, userId);
  limitRecoveryLinks(a.user.id);
  const link = await issueResetLink(deps, userId);
  await deps.db.transaction(async (tx) => {
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'user.recovery_link_created',
      targetType: 'user',
      targetId: userId,
      payload: { email: m.user.email, expires_at: link.expires_at },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'user.recovery_link_created',
      actorId: a.user.id,
      requestId: a.requestId,
      meta: { user_id: userId },
    });
  });
  return link;
};

/** The active, real member of an account by email (the owner's recovery link and its emergency path). */
export const activeMemberByEmail = async (deps: Pick<Deps, 'db'>, accountId: string, email: string) => {
  const userId = await findUserIdByEmail(deps.db, email);
  const m = userId ? await findMemberWithUser(deps.db, accountId, userId) : undefined;
  if (!m || !userId) throw new AppError('not_found', 'User not found');
  if (m.membership.status !== 'active' || m.user.email.endsWith(`@${ANON_EMAIL_DOMAIN}`))
    throw new AppError('forbidden', 'user_not_active');
  return { userId, user: m.user };
};

/**
 * POST /platform/accounts/:id/recovery-link — the platform owner, for anyone in that account (audited there). Only
 * with an active edit grant of the account (or as its admin): closes it as a way in by itself. Without
 * one, 403 `support_grant_required` — the emergency path (`support.service` requestEmergencyRecovery) remains.
 */
export const ownerRecoveryLink = async (
  deps: Deps,
  owner: SessionUser,
  accountId: string,
  email: string,
  meta: RequestMeta,
) => {
  const account = await findAccountById(deps.db, accountId);
  if (!account) throw new AppError('not_found', 'Account not found');
  const { userId, user } = await activeMemberByEmail(deps, accountId, email);
  await assertOwnerMayAct(deps.db, owner.id, accountId);
  const m = { user };
  limitRecoveryLinks(owner.id);
  const link = await issueResetLink(deps, userId);
  await recordAudit(deps.db, {
    accountId,
    actorId: owner.id,
    action: 'user.recovery_link_created',
    targetType: 'user',
    targetId: userId,
    payload: { email: m.user.email, expires_at: link.expires_at, via: 'platform_owner' },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return link;
};

/**
 * POST /platform/accounts/:id/reset-2fa — the platform owner turns a member's second factor off from the owner
 * console, for people an account admin may not touch (active in more than one account, S-52). Like the recovery
 * link: only with an active edit grant of the account (or as its admin), audited there as `auth.2fa.reset` via the
 * owner console (audit 2026-10-10 #26 — the inside-the-account bypass is gone).
 */
export const ownerResetTwoFactor = async (
  deps: Pick<Deps, 'db'>,
  owner: SessionUser,
  accountId: string,
  email: string,
  meta: RequestMeta,
) => {
  const account = await findAccountById(deps.db, accountId);
  if (!account) throw new AppError('not_found', 'Account not found');
  const { userId, user } = await activeMemberByEmail(deps, accountId, email);
  await assertOwnerMayAct(deps.db, owner.id, accountId);
  if (userId === owner.id) throw new AppError('forbidden', 'self');
  if (!(await twoFactorEnabledOf(deps.db, userId))) throw new AppError('conflict', 'two_factor_not_enabled');
  await deps.db.transaction(async (tx) => {
    await removeTwoFactor(tx, userId);
    await recordAudit(tx, {
      accountId,
      actorId: owner.id,
      action: 'auth.2fa.reset',
      targetType: 'user',
      targetId: userId,
      payload: { email: user.email, via: 'platform_owner' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await recordEvent(tx, {
      accountId,
      type: 'user.two_factor_reset',
      actorId: owner.id,
      requestId: meta.requestId,
      meta: { user_id: userId, via: 'platform_owner' },
    });
  });
  return { ok: true as const };
};

/** Forgot-password requests per IP and per address, 15 minutes. */
const forgotByIp = new RateLimiter(10, 15 * 60 * 1000);
const forgotByEmail = new RateLimiter(3, 15 * 60 * 1000);

/**
 * POST /auth/forgot-password — public. Emails a /login#reset= link (1 hour, single use) to a user who exists; the
 * answer is the same for unknown addresses. When the email cannot be sent it says so (503 `email_not_sent`), so the
 * login page can point to the other ways in (an admin's one-time link) instead of "check your inbox" — Better
 * Auth's own endpoint swallows send failures.
 */
export const forgotPassword = async (
  deps: Deps & Pick<AppDeps, 'mailer' | 'logger' | 'emailEnabled'>,
  email: string,
  meta: RequestMeta,
) => {
  const e = email.trim().toLowerCase();
  const wait = Math.max(forgotByIp.hit(ipBucket(meta.ip)), forgotByEmail.hit(e));
  if (wait > 0) throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: wait });
  // "Email is off" is the transport's state, said before any address is looked at (the same for everyone).
  if (deps.emailEnabled === false) throw new AppError('unavailable', 'email_not_sent');
  const userId = await findUserIdByEmail(deps.db, e);
  const user = userId ? await findUserById(deps.db, userId) : undefined;
  if (!user || user.isService || user.email.endsWith(`@${ANON_EMAIL_DOMAIN}`)) return { ok: true as const };
  const link = await issueResetLink(deps, user.id);
  // The send runs after the answer: a known address must take as long, and answer the same, as an unknown one
  // (audit 2026-10-10 security #10 — the wait for the mailer and its 503 told registration apart).
  void platformMailBrand(deps, user.locale)
    .then((brand) => deps.mailer.send(resetPasswordEmail({ to: user.email, brand, url: link.url })))
    .catch((err) => deps.logger.warn({ err, userId: user.id }, 'reset password email failed'));
  return { ok: true as const };
};

/** POST /auth/recovery/preview — public: whose link this is (to prefill the sign-in after the new password). */
export const previewRecovery = async (deps: Deps, token: string) => {
  const ctx = await deps.auth.$context;
  const v = await ctx.internalAdapter.findVerificationValue(resetIdentifier(token));
  const user = v && v.expiresAt > new Date() ? await findUserById(deps.db, v.value) : undefined;
  if (!user || user.email.endsWith(`@${ANON_EMAIL_DOMAIN}`))
    throw new AppError('invitation_invalid', 'Link is invalid or expired');
  return {
    email: user.email,
    expires_at: v!.expiresAt.toISOString(),
    password_min_length: await userPasswordMin(deps.db, user.id),
  };
};

/** GET /me/security */
export const mySecurity = async (deps: Deps, user: SessionUser) => {
  const providers = await signInProvidersOf(deps.db, user.id);
  return {
    has_password: providers.includes('credential'),
    providers: providers.filter((p) => p !== 'credential'),
    // The flag in the database, not the session's copy (it changes on enrolment without a new sign-in).
    two_factor: await myTwoFactor(deps.db, user.id, await twoFactorEnabledOf(deps.db, user.id)),
    password_min_length: await userPasswordMin(deps.db, user.id),
  };
};

/** POST /me/password — a first password for someone who signs in by link / Google. Never replaces one. */
export const setMyPassword = async (deps: Deps, user: SessionUser, newPassword: string, headers: Headers) => {
  const wait = passwordLimiter.hit(user.id);
  if (wait > 0) throw new AppError('rate_limited', 'Too many attempts', { retry_after_ms: wait });
  assertPasswordLength(newPassword, await userPasswordMin(deps.db, user.id));
  if (await hasPassword(deps.db, user.id)) throw new AppError('conflict', 'password_exists');
  await deps.auth.api.setPassword({ body: { newPassword }, headers });
  return { ok: true as const };
};
