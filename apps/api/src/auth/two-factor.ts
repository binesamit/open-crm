// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { createAuthMiddleware } from 'better-auth/api';
import { APIError, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import type { Db } from '../db/client';
import { RESOLVED_IP_HEADER } from '../lib/client-ip';
import { auditForUser, myTwoFactor } from '../modules/admin/two-factor.service';
import { challengeMethodKey } from './sign-in-method';

/**
 * Two-factor authentication around Better Auth's `twoFactor` plugin (M8 ד12).
 *
 * The plugin asks for the code after an email + password sign-in only. Here the same challenge follows the other
 * ways in — the magic link and Google (OAuth callback) — so a second factor cannot be skipped by choosing another
 * door: the new session is dropped, the short-lived `two_factor` cookie is set exactly as the plugin sets it, and
 * the browser lands on /login?two_factor=1, where `/two-factor/verify-totp` (or a backup code) finishes the sign-in.
 * A device trusted for 30 days ("זכור מכשיר זה") skips the code on every door alike.
 *
 * Also: the account policy cannot be bypassed by turning 2FA off (`/two-factor/disable` is refused while an account
 * requires it), and every 2FA step is in the audit log of each of the person's accounts (`auth.2fa.*`).
 */
type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export const TWO_FACTOR_CHALLENGE_SECONDS = 600;
export const TRUST_DEVICE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Paths that sign in without going through `/sign-in/email` (the plugin's own hook covers that one). S-25:
 * `/sign-in/social` with an `idToken` (Google One Tap / native) makes a session directly, without the callback.
 */
export const OTHER_SIGN_INS: ReadonlySet<string> = new Set(['/magic-link/verify', '/callback/:id', '/sign-in/social']);

const metaOf = (ctx: Ctx) => ({
  ip: ctx.headers?.get(RESOLVED_IP_HEADER) ?? null,
  userAgent: ctx.headers?.get('user-agent') ?? null,
});

const hmac = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('base64url');

/** The plugin's "trust this device" cookie (`<hmac>!<id>`), still valid for this person. */
const trustedDevice = async (ctx: Ctx, userId: string) => {
  const cookie = ctx.context.createAuthCookie('trust_device', { maxAge: TRUST_DEVICE_SECONDS });
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!value) return false;
  const [token, id] = value.split('!');
  if (!token || !id) return false;
  const expected = Buffer.from(hmac(ctx.context.secret, `${userId}!${id}`));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const record = await ctx.context.internalAdapter.findVerificationValue(id);
  return !!record && record.value === userId && record.expiresAt > new Date();
};

/** Where the sign-in was going (same origin only), from the redirect the endpoint answered with. */
const targetOf = (ctx: Ctx, webOrigin: string) => {
  const returned = ctx.context.returned as { headers?: ConstructorParameters<typeof Headers>[0] } | undefined;
  const location = returned?.headers ? new Headers(returned.headers).get('location') : null;
  if (!location) return '/';
  try {
    const url = new URL(location, webOrigin);
    return url.origin === new URL(webOrigin).origin ? `${url.pathname}${url.search}` : '/';
  } catch {
    return '/';
  }
};

/** After a magic link / Google sign-in: a person with 2FA on gets the code step instead of a session. */
const challengeOtherSignIn = async (ctx: Ctx, origin: () => Promise<string>) => {
  const data = ctx.context.newSession as {
    user: { id: string; twoFactorEnabled?: boolean };
    session: { token: string; signInMethod?: string | null };
  } | null;
  if (!data?.user.twoFactorEnabled) return;
  if (await trustedDevice(ctx, data.user.id)) return;
  deleteSessionCookie(ctx, true);
  await ctx.context.internalAdapter.deleteSession(data.session.token);
  ctx.context.setNewSession(null);
  const cookie = ctx.context.createAuthCookie('two_factor', { maxAge: TWO_FACTOR_CHALLENGE_SECONDS });
  const identifier = `2fa-${randomBytes(15).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + TWO_FACTOR_CHALLENGE_SECONDS * 1000);
  await ctx.context.internalAdapter.createVerificationValue({ value: data.user.id, identifier, expiresAt });
  await ctx.context.internalAdapter.createVerificationValue({
    value: '0',
    identifier: `2fa-attempts-${identifier}`,
    expiresAt,
  });
  // The door this started from (Google / Microsoft / link), for the session the code step makes (sign-in-method.ts).
  if (data.session.signInMethod)
    await ctx.context.internalAdapter.createVerificationValue({
      value: data.session.signInMethod,
      identifier: challengeMethodKey(identifier),
      expiresAt,
    });
  await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
  const webOrigin = await origin();
  const target = targetOf(ctx, webOrigin);
  const search = new URLSearchParams({ two_factor: '1', ...(target !== '/' ? { redirect: target } : {}) });
  throw ctx.redirect(`${webOrigin}/login?${search}`);
};

/** The person behind a pending challenge (the signed `two_factor` cookie), for the audit of a sign-in step. */
const challengedUser = async (ctx: Ctx) => {
  const cookie = ctx.context.createAuthCookie('two_factor');
  const id = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!id) return null;
  const v = await ctx.context.internalAdapter.findVerificationValue(id);
  return v?.value ?? null;
};

const hasChallengeCookie = (ctx: Ctx) =>
  /(?:^|;\s*)(?:__Secure-)?bos\.two_factor=/.test(ctx.headers?.get('cookie') ?? '');

const failed = (ctx: Ctx) => isAPIError(ctx.context.returned);

/** Before Better Auth runs: 2FA cannot be turned off while one of my accounts requires it. */
export const twoFactorBefore = (db: Db) => async (ctx: Ctx) => {
  if (ctx.path !== '/two-factor/disable') return;
  const session = await getSessionFromCtx(ctx);
  if (!session) return;
  const state = await myTwoFactor(db, session.user.id, true);
  if (state.required) throw new APIError('FORBIDDEN', { message: 'two_factor_required_by_policy' });
};

/** After Better Auth answered: the other doors' challenge, and the audit rows. */
/** `webOrigin` resolves the public address (M11) per sign-in, so a new domain applies without a restart. */
export const twoFactorAfter = (db: Db, webOrigin: () => Promise<string>) => async (ctx: Ctx) => {
  if (OTHER_SIGN_INS.has(ctx.path)) return challengeOtherSignIn(ctx, webOrigin);
  const meta = metaOf(ctx);
  const trustDevice = !!(ctx.body as { trustDevice?: boolean } | undefined)?.trustDevice;
  switch (ctx.path) {
    case '/two-factor/verify-totp':
    case '/two-factor/verify-backup-code': {
      const method = ctx.path === '/two-factor/verify-totp' ? 'totp' : 'backup_code';
      const signIn = hasChallengeCookie(ctx);
      if (failed(ctx)) {
        const userId = signIn ? await challengedUser(ctx) : (await getSessionFromCtx(ctx))?.user.id;
        if (userId) await auditForUser(db, userId, 'auth.2fa.failed', { method, sign_in: signIn }, meta);
        return;
      }
      // Without a challenge it is the signed-in person confirming their app: the first time, that turns 2FA on.
      const user = (ctx.context.returned as { user?: { id: string; twoFactorEnabled?: boolean } } | undefined)?.user;
      if (!user) return;
      if (!signIn && method === 'totp' && !user.twoFactorEnabled)
        await auditForUser(db, user.id, 'auth.2fa.enabled', {}, meta);
      else
        await auditForUser(
          db,
          user.id,
          method === 'backup_code' ? 'auth.2fa.backup_code_used' : 'auth.2fa.verified',
          { method, trust_device: trustDevice },
          meta,
        );
      return;
    }
    case '/two-factor/disable':
    case '/two-factor/generate-backup-codes': {
      if (failed(ctx)) return;
      // Turning it off replaces the session (the new one is `newSession`); new backup codes keep it.
      const userId =
        (ctx.context.newSession as { user: { id: string } } | null)?.user.id ??
        (await getSessionFromCtx(ctx).catch(() => null))?.user.id;
      if (!userId) return;
      await auditForUser(
        db,
        userId,
        ctx.path === '/two-factor/disable' ? 'auth.2fa.disabled' : 'auth.2fa.backup_codes_regenerated',
        {},
        meta,
      );
      return;
    }
  }
};
