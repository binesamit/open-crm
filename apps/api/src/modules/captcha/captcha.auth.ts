// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { CAPTCHA_EXEMPT_HEADER, CAPTCHA_TOKEN_HEADER, type PlatformCaptchaSurface } from '@bines/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps, AppEnv } from '../../types';
import { findUserIdByEmail } from '../users/users.repo';
import { assertCaptcha, platformCaptchaKeys } from './captcha.service';

/**
 * Better Auth's public endpoints that a bot would hammer, by the platform place that guards them (owner console →
 * Platform settings → Turnstile). The token comes in the `x-captcha-token` header (the bodies are Better Auth's).
 */
const AUTH_SURFACES: Record<string, PlatformCaptchaSurface> = {
  '/api/auth/sign-in/email': 'sign_in',
  '/api/auth/sign-in/magic-link': 'sign_in',
  '/api/auth/sign-up/email': 'sign_up',
  '/api/auth/request-password-reset': 'forgot_password',
  '/api/auth/forget-password': 'forgot_password',
};

const RESET_PATH = '/api/auth/reset-password';
const PASSWORD_SIGN_IN = '/api/auth/sign-in/email';
/** The one sign-in right after choosing a new password (the reset link already proved the inbox). */
const EXEMPT_TTL_MS = 2 * 60_000;
const exemptIdentifier = (token: string) => `captcha-exempt:${token}`;
/** Same identifier as recovery.service (Better Auth's reset token). */
const resetIdentifier = (token: string) => `reset-password:${token}`;

type Deps = Pick<AppDeps, 'db' | 'secrets' | 'auth'>;

/** A field of the JSON body, read from a copy (Better Auth reads the request itself). */
const bodyField = async (c: Context<AppEnv>, field: string): Promise<string | null> => {
  try {
    const v = ((await c.req.raw.clone().json()) as Record<string, unknown>)[field];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
};

/**
 * A one-use exemption (verification row, ~2 minutes, bound to the user) — consumed here: valid only for a password
 * sign-in of that same user.
 */
const exempted = async (deps: Deps, c: Context<AppEnv>): Promise<boolean> => {
  const token = c.req.header(CAPTCHA_EXEMPT_HEADER);
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return false;
  const ctx = await deps.auth.$context;
  const v = await ctx.internalAdapter.consumeVerificationValue(exemptIdentifier(token));
  if (!v || v.expiresAt <= new Date()) return false;
  const email = await bodyField(c, 'email');
  return !!email && (await findUserIdByEmail(deps.db, email.trim().toLowerCase())) === v.value;
};

/** After a successful reset, while sign-in asks for Turnstile: the exemption in the `x-captcha-exempt` header. */
const issueExemption = async (deps: Deps, c: Context<AppEnv>, userId: string) => {
  const token = randomBytes(24).toString('hex');
  const ctx = await deps.auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: exemptIdentifier(token),
    value: userId,
    expiresAt: new Date(Date.now() + EXEMPT_TTL_MS),
  });
  try {
    c.res.headers.set(CAPTCHA_EXEMPT_HEADER, token);
  } catch {
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set(CAPTCHA_EXEMPT_HEADER, token);
  }
};

/** Before Better Auth: 400 `captcha_required` / `captcha_failed` when the place asks for the check. */
export const authCaptchaGuard =
  (deps: Deps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const path = c.req.path;
    if (path === RESET_PATH) {
      // Whose reset this is — read before Better Auth spends the token.
      const token = await bodyField(c, 'token');
      const v = token
        ? await (await deps.auth.$context).internalAdapter.findVerificationValue(resetIdentifier(token))
        : null;
      await next();
      if (v && v.expiresAt > new Date() && c.res.ok && (await platformCaptchaKeys(deps.db, 'sign_in')))
        await issueExemption(deps, c, v.value);
      return;
    }
    const surface = AUTH_SURFACES[path];
    if (surface) {
      const keys = await platformCaptchaKeys(deps.db, surface);
      if (keys && !(path === PASSWORD_SIGN_IN && (await exempted(deps, c))))
        await assertCaptcha(deps.secrets, keys, c.req.header(CAPTCHA_TOKEN_HEADER), c.get('clientIp') ?? null);
    }
    await next();
  };
