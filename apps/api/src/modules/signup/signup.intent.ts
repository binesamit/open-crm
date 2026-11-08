// SPDX-License-Identifier: AGPL-3.0-only
import { signupEmailProblem } from '@bines/shared';
import type { Db } from '../../db/client';
import { sha256 } from '../../lib/tokens';
import { findSignupRequestByToken, type SignupRequestRow } from './signup.repo';
import { loadSignupSettings } from './signup.store';

/**
 * A Google / Microsoft sign-up (D32): the sign-up screen first posts the details (`POST /public/signup/intent`), which
 * stores a request (`pending_provider`, half an hour) and sets this cookie — a random token, only its hash is stored.
 * The provider's callback (Better Auth) may then create the person — auth.ts asks `signupIntentAllows` — and
 * `POST /public/signup/complete` turns the signed-in person into the new account's admin. HttpOnly, SameSite=Lax
 * (the provider's redirect back is a top-level GET, which carries it), scoped to the API.
 */
export const SIGNUP_INTENT_COOKIE = 'bos.signup_intent';
export const SIGNUP_INTENT_MINUTES = 30;

export const intentCookie = (token: string, secure: boolean) =>
  `${SIGNUP_INTENT_COOKIE}=${token}; Path=/api; Max-Age=${SIGNUP_INTENT_MINUTES * 60}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

export const clearIntentCookie = (secure: boolean) =>
  `${SIGNUP_INTENT_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

/** The token of the intent cookie in a Cookie header, or null. */
export const intentToken = (cookieHeader: string | null | undefined): string | null => {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SIGNUP_INTENT_COOKIE) {
      const v = rest.join('=').trim();
      return /^[A-Za-z0-9_-]{20,200}$/.test(v) ? v : null;
    }
  }
  return null;
};

/** The live intent behind a Cookie header (still `pending_provider`, not expired), or undefined. */
export const liveIntent = async (db: Db, cookieHeader: string | null | undefined, now = new Date()) => {
  const token = intentToken(cookieHeader);
  if (!token) return undefined;
  const r = await findSignupRequestByToken(db, sha256(token));
  return r && r.status === 'pending_provider' && r.expiresAt && r.expiresAt > now ? r : undefined;
};

export type IntentCheck = { ok: true; request: SignupRequestRow } | { ok: false; problem?: string };

/**
 * auth.ts, a provider's callback about to create a person with no invitation: does a live sign-up intent for this
 * provider allow it? No cookie = `{ok: false}` without reading anything (every existing door is unchanged); the
 * switch off = no. An address the sign-up rules refuse = `{ok: false, problem}`.
 */
export const signupIntentAllows = async (
  db: Db,
  p: { cookie: string | null | undefined; provider: string | undefined; email: string },
): Promise<IntentCheck> => {
  if (!intentToken(p.cookie)) return { ok: false };
  const settings = await loadSignupSettings(db);
  if (!settings.enabled) return { ok: false };
  const request = await liveIntent(db, p.cookie);
  if (!request || request.method !== p.provider) return { ok: false };
  const problem = signupEmailProblem(p.email, settings);
  return problem ? { ok: false, problem } : { ok: true, request };
};
