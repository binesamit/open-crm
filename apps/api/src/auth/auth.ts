// SPDX-License-Identifier: AGPL-3.0-only
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { magicLink, twoFactor } from 'better-auth/plugins';
import { absoluteUrl, newId, PASSWORD_MAX_LENGTH, PASSWORD_MIN_FLOOR, passwordLengthProblem, t } from '@bines/shared';
import type { Db } from '../db/client';
import { authIdentities, authSessions, authTwoFactors, authVerifications, users } from '../db/schema';
import type { Env } from '../env';
import { deviceOf, type Mailer, magicLinkEmail, resetPasswordEmail } from '@bines/server-mail';
import type { Logger } from '../lib/logger';
import { RESOLVED_IP_HEADER } from '../lib/client-ip';
import { findValidInvitationByToken, hasPendingInvitationForEmail } from '../modules/invitations/invitations.repo';
import { findLocaleByEmail, findUserIdByEmail, markPlatformOwner } from '../modules/users/users.repo';
import { TRUST_DEVICE_SECONDS, twoFactorAfter, twoFactorBefore } from './two-factor';
import { signInMethodOf, signInOrgOf } from './sign-in-method';
import { socialProviderSync } from '../modules/platform/login-providers';
import { platformMailBrand } from '../modules/platform/mail-brand';
import { accountPasswordMin, platformPasswordMin, userPasswordMin } from './password-policy';
import { loadPlatformSettings, productName } from '../modules/platform/platform-settings';
import { publicAddress } from '../modules/platform/public-address';
import { signupIntentAllows } from '../modules/signup/signup.intent';

export const INVITE_TOKEN_HEADER = 'x-invite-token';

/** The doors where a provider (Google / Microsoft) vouches for the email. */
const SOCIAL_PATHS: ReadonlySet<string> = new Set(['/callback/:id', '/sign-in/social']);

/**
 * Authentication only (D12): sessions are not bound to an account; membership is resolved per request.
 *
 * Who may create a user (there is no open sign-up):
 * - the platform owner (SEED_ADMIN_EMAIL) — via magic link, Google or Microsoft, which prove the email;
 * - anyone with a pending invitation for that email — magic link / Google / Microsoft prove the email (a provider's
 *   address counts only when the provider says it is verified, see login-providers.ts); email+password
 *   sign-up must present the invitation token (header x-invite-token), which proves inbox access, so the
 *   email is marked verified. This blocks pre-registering someone else's address with a known password.
 * - self sign-up (D32, only while the owner turned it on): a password sign-up goes through the same invitation door
 *   (signup.service makes the account and its first-admin invitation after the email link); a Google / Microsoft one
 *   is allowed here by the sign-up screen's intent cookie (signup.intent.ts) for a provider-verified address.
 */
export const createAuth = (deps: { db: Db; env: Env; mailer: Mailer; logger: Logger }) => {
  const { db, env, mailer, logger } = deps;
  const ownerEmail = env.SEED_ADMIN_EMAIL?.toLowerCase();
  // Better Auth's own base is fixed when the server starts: BETTER_AUTH_URL, else WEB_ORIGIN. Every link we email,
  // and the providers' return address (login-providers.ts), is built on the public address instead (M11).
  const baseURL = env.BETTER_AUTH_URL ?? env.WEB_ORIGIN;
  const address = () => publicAddress({ db, env });
  const webOrigin = async () => (await address()).web;
  /** A link Better Auth built on its base, moved to the public address (same server, same path and query). */
  const onPublicAddress = async (url: string) => {
    const link = new URL(url);
    return new URL(`${link.pathname}${link.search}${link.hash}`, await webOrigin()).toString();
  };

  const send = async (message: Parameters<Mailer['send']>[0]) => {
    try {
      await mailer.send(message);
    } catch (err) {
      logger.error({ err, to: message.to }, 'auth email failed');
      throw new APIError('INTERNAL_SERVER_ERROR', { message: 'email_not_sent' });
    }
  };

  /** Only people who could actually get in receive auth emails; the HTTP response is the same either way. */
  const mayReceiveAuthEmail = async (email: string) => {
    const e = email.toLowerCase();
    return (
      (!!ownerEmail && e === ownerEmail) || !!(await findUserIdByEmail(db, e)) || hasPendingInvitationForEmail(db, e)
    );
  };

  /** The authenticator app shows the product's name (owner console, white-label), not a literal brand. */
  const TOTP_PATHS = new Set(['/two-factor/enable', '/two-factor/get-totp-uri']);

  /**
   * The configured minimum password length (./password-policy.ts) on Better Auth's doors that choose a
   * password: sign-up by invitation (the inviting account's), change (the signed-in person's) and reset (the link's
   * person's). Better Auth itself only knows the floor.
   */
  const tooShort = (password: unknown, min: number) => {
    if (typeof password !== 'string' || passwordLengthProblem(password, min) !== 'too_short') return;
    throw new APIError('BAD_REQUEST', {
      message: 'password_min_length',
      code: 'PASSWORD_TOO_SHORT',
      min_length: min,
    });
  };
  const passwordGuard = async (ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (ctx.path === '/change-password') {
      const session = await getSessionFromCtx(ctx);
      if (session) tooShort(body.newPassword, await userPasswordMin(db, session.user.id));
    } else if (ctx.path === '/reset-password') {
      const token = typeof body.token === 'string' ? body.token : '';
      const v = token ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`) : null;
      tooShort(body.newPassword, v ? await userPasswordMin(db, v.value) : await platformPasswordMin(db));
    }
  };

  const twoFactorGuard = twoFactorBefore(db);
  // Google / Microsoft come from the owner console, read before each auth request — no restart.
  const syncProviders = socialProviderSync({ db, env });
  const twoFactorAudit = twoFactorAfter(db, webOrigin);

  return betterAuth({
    appName: t('app.name'),
    baseURL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET ?? 'dev-only-secret-change-me-dev-only-secret',
    // S-82: no usage data to Better Auth's servers, whatever its default or BETTER_AUTH_TELEMETRY says.
    telemetry: { enabled: false },
    // The public address, WEB_ORIGIN / BETTER_AUTH_URL and the previous addresses kept during a move (M11).
    trustedOrigins: async () => (await address()).accepted,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: users,
        session: authSessions,
        account: authIdentities,
        verification: authVerifications,
        twoFactor: authTwoFactors,
      },
    }),
    user: {
      additionalFields: {
        isPlatformOwner: { type: 'boolean', input: false, defaultValue: false, required: false },
        locale: { type: 'string', input: false, defaultValue: 'he', required: false },
        // null = never chosen: the member follows the account's timezone (A3).
        timezone: { type: 'string', input: false, required: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // How this session was made (password / magic_link / google / microsoft): an account may require a provider.
      // S-72: and, for a provider, the organisation it came from (Google `hd` / Microsoft `tid`).
      additionalFields: {
        signInMethod: { type: 'string', input: false, required: false },
        signInOrg: { type: 'string', input: false, required: false },
      },
    },
    advanced: {
      cookiePrefix: 'bos',
      database: { generateId: () => newId() },
      // Secure cookies in production — unless the app is served over plain http (a standalone install on
      // http://<host>:3000), where a browser would never send them back.
      useSecureCookies: env.NODE_ENV === 'production' && !baseURL.startsWith('http://'),
      // The address resolved by lib/client-ip.ts (trusted proxy config, S-10); app.ts overwrites this header on every
      // auth request, so a client cannot choose its own rate-limit bucket.
      ipAddress: { ipAddressHeaders: [RESOLVED_IP_HEADER] },
    },
    emailAndPassword: {
      enabled: true,
      // The lowest any setting may ask for; the configured minimum is checked in hooks.before (passwordGuard).
      minPasswordLength: PASSWORD_MIN_FLOOR,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // Every password user is created through an invitation token (hooks.before below), which proves the
      // email, so there is no unverified password account to protect against.
      requireEmailVerification: false,
      autoSignIn: true,
      // "שכחתי סיסמה" (fix8): the link opens our login page with the token in the fragment (#reset=…), which
      // browsers never send to a server — so it reaches no access log. Better Auth's own URL carries it in a query.
      // One hour, single use; using it signs out every other session. Also how a link-only user gets a password.
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) =>
        send(
          resetPasswordEmail({
            to: user.email,
            brand: await platformMailBrand({ db }, (user as { locale?: string }).locale),
            url: absoluteUrl(await webOrigin(), `/login#reset=${token}`),
          }),
        ),
    },
    // Tighter limits on what sends email or guesses secrets (per IP; on in production — Better Auth's default).
    rateLimit: {
      customRules: {
        '/request-password-reset': { window: 60 * 15, max: 5 },
        '/reset-password': { window: 60, max: 10 },
        '/sign-in/magic-link': { window: 60 * 15, max: 10 },
        '/change-password': { window: 60 * 15, max: 10 },
        '/sign-in/email': { window: 60, max: 10 },
      },
    },
    // Filled per request from the owner console / environment (hooks.before → syncProviders).
    socialProviders: {},
    plugins: [
      magicLink({
        expiresIn: 600,
        sendMagicLink: async ({ email, url }, ctx) => {
          if (await mayReceiveAuthEmail(email)) {
            const device = deviceOf(ctx?.request?.headers.get('user-agent') ?? ctx?.headers?.get('user-agent'));
            await send(
              magicLinkEmail({
                to: email,
                brand: await platformMailBrand({ db }, await findLocaleByEmail(db, email)),
                url: await onPublicAddress(url),
                ...(device ? { context: { device } } : {}),
              }),
            );
          }
        },
      }),
      // M8 ד12 (D25): an authenticator app (TOTP) + 10 backup codes, optional unless an account requires it. People
      // who sign in by link / Google have no password to confirm with (`allowPasswordless`); people with a password
      // confirm with it. The code step after every way in: ./two-factor.ts.
      twoFactor({
        allowPasswordless: true,
        trustDeviceMaxAge: TRUST_DEVICE_SECONDS,
        backupCodeOptions: { amount: 10, length: 10 },
      }),
    ],
    hooks: {
      // Runs before Better Auth looks the email up, so sign-up cannot be used to probe which emails exist.
      before: createAuthMiddleware(async (ctx) => {
        await syncProviders(ctx.context.socialProviders);
        await twoFactorGuard(ctx);
        await passwordGuard(ctx);
        if (TOTP_PATHS.has(ctx.path)) {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (body.issuer) return;
          const user = (ctx.context as { session?: { user?: { locale?: string } } }).session?.user;
          const issuer = productName(await loadPlatformSettings(db), user?.locale === 'en' ? 'en' : 'he');
          return { context: { body: { ...body, issuer } } };
        }
        if (ctx.path !== '/sign-up/email') return;
        const token = ctx.headers?.get(INVITE_TOKEN_HEADER);
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '').toLowerCase();
        const invitation = token ? await findValidInvitationByToken(db, token) : undefined;
        if (!invitation || invitation.email.toLowerCase() !== email) {
          throw new APIError('FORBIDDEN', { message: 'invitation_required' });
        }
        tooShort((ctx.body as { password?: unknown }).password, await accountPasswordMin(db, invitation.accountId));
      }),
      after: createAuthMiddleware(async (ctx) => twoFactorAudit(ctx)),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            const signInMethod = await signInMethodOf(ctx);
            const signInOrg = await signInOrgOf(db, ctx, signInMethod, session.userId);
            return { data: { ...session, signInMethod, signInOrg } };
          },
        },
      },
      user: {
        create: {
          before: async (user, ctx) => {
            const email = user.email.toLowerCase();
            const isOwner = !!ownerEmail && email === ownerEmail;

            if (ctx?.path === '/sign-up/email') {
              const token = ctx.headers?.get(INVITE_TOKEN_HEADER);
              const invitation = token ? await findValidInvitationByToken(db, token) : undefined;
              if (!invitation || invitation.email.toLowerCase() !== email) {
                throw new APIError('FORBIDDEN', { message: 'invitation_required' });
              }
              return { data: { ...user, email, emailVerified: true } };
            }

            // A provider's address proves the person only when the provider vouches for it (Microsoft work
            // directories set addresses freely — "nOAuth"); a magic link proves it by itself.
            // On a provider's callback a `code` makes Better Auth send the browser back to the sign-in page
            // (errorCallbackURL ?error=CODE) instead of answering a bare 403.
            const social = SOCIAL_PATHS.has(ctx?.path ?? '');
            if (social && !user.emailVerified) {
              throw new APIError('FORBIDDEN', { message: 'email_not_verified', code: 'EMAIL_NOT_VERIFIED' });
            }
            if (!isOwner && !(await hasPendingInvitationForEmail(db, email))) {
              // Self sign-up (D32): no intent cookie = nothing read, the refusal below exactly as before.
              if (social) {
                const params = (ctx as { params?: { id?: string } } | null | undefined)?.params;
                const body = (ctx?.body ?? {}) as { provider?: unknown };
                const intent = await signupIntentAllows(db, {
                  cookie: ctx?.headers?.get('cookie'),
                  provider: params?.id ?? (typeof body.provider === 'string' ? body.provider : undefined),
                  email,
                });
                if (intent.ok) return { data: { ...user, email } };
                if (intent.problem)
                  throw new APIError('FORBIDDEN', {
                    message: 'signup_email_not_allowed',
                    code: 'SIGNUP_EMAIL_NOT_ALLOWED',
                  });
              }
              throw new APIError('FORBIDDEN', {
                message: 'invitation_required',
                ...(social ? { code: 'INVITATION_REQUIRED' } : {}),
              });
            }
            return { data: { ...user, email } };
          },
          after: async (user) => {
            if (ownerEmail && user.email.toLowerCase() === ownerEmail) await markPlatformOwner(db, user.id);
          },
        },
      },
    },
  });
};

export type Auth = ReturnType<typeof createAuth>;
