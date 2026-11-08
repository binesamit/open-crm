// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq } from 'drizzle-orm';
import { LOGIN_PROVIDERS, type SignInMethod, ssoOrgFromClaims } from '@bines/shared';
import type { Db } from '../db/client';
import { authIdentities } from '../db/schema';

/**
 * How a new Better Auth session was made (`auth_sessions.sign_in_method`): an account that requires
 * Google / Microsoft lets in only sessions made through them. Decided from the door the session comes through:
 * - a provider's callback / ID-token sign-in → that provider;
 * - email + password (sign-in, sign-up by invitation) → `password`; a magic link → `magic_link`;
 * - the code step after any of them (two-factor) → the door that started it (kept with the challenge, see
 *   two-factor.ts), else `password` (the plugin's own challenge follows a password);
 * - a session replaced while signed in (turning 2FA off, changing the password) → the one it replaces.
 */
type HookCtx = {
  path?: string;
  params?: Record<string, string | undefined>;
  body?: unknown;
  context?: {
    session?: { session?: { signInMethod?: unknown; signInOrg?: unknown } } | null;
    secret?: string;
    createAuthCookie?: (name: string) => { name: string };
    internalAdapter?: {
      findVerificationValue: (identifier: string) => Promise<{ value: string } | null | undefined>;
    };
  };
  getSignedCookie?: (name: string, secret: string) => Promise<string | null | false | undefined>;
};

const PROVIDERS: ReadonlySet<string> = new Set(LOGIN_PROVIDERS);
const asProvider = (v: unknown): SignInMethod | null =>
  typeof v === 'string' && PROVIDERS.has(v) ? (v as SignInMethod) : null;

/** The verification row that carries the door of a pending two-factor challenge. */
export const challengeMethodKey = (identifier: string) => `2fa-method-${identifier}`;

export const signInMethodOf = async (raw: unknown): Promise<SignInMethod | null> => {
  const ctx = (raw ?? {}) as HookCtx;
  switch (ctx.path) {
    case '/callback/:id':
      return asProvider(ctx.params?.id);
    case '/sign-in/social':
      return asProvider((ctx.body as { provider?: unknown } | undefined)?.provider);
    case '/sign-in/email':
    case '/sign-up/email':
      return 'password';
    case '/magic-link/verify':
      return 'magic_link';
    case '/two-factor/verify-totp':
    case '/two-factor/verify-backup-code':
    case '/two-factor/verify-otp': {
      const c = ctx.context;
      const id =
        c?.createAuthCookie && c.secret && ctx.getSignedCookie
          ? await ctx.getSignedCookie(c.createAuthCookie('two_factor').name, c.secret)
          : null;
      // No challenge: the signed-in person confirming their app (enrolment replaces the session) — keep its door.
      if (!id || !c?.internalAdapter) return inherited(ctx);
      const row = await c.internalAdapter.findVerificationValue(challengeMethodKey(id));
      return asMethod(row?.value) ?? 'password';
    }
    default:
      return inherited(ctx);
  }
};

const asMethod = (v: unknown): SignInMethod | null => (v === 'password' || v === 'magic_link' ? v : asProvider(v));
const inherited = (ctx: HookCtx) => asMethod(ctx.context?.session?.session?.signInMethod);

/** Paths where a provider has just vouched for the person: its ID token (kept on the identity row) is this sign-in's. */
const FRESH_PROVIDER_PATHS: ReadonlySet<string> = new Set([
  '/callback/:id',
  '/sign-in/social',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
]);

/** The claims of a JWT (no signature check: the token came from the provider over TLS, Better Auth checked it). */
const jwtClaims = (token: string | null | undefined): Record<string, unknown> => {
  const part = token?.split('.')[1];
  if (!part) return {};
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * S-72: the organisation of a provider session (`auth_sessions.sign_in_org`) — Google's `hd` (Workspace domain) or
 * Microsoft's `tid` (directory) — so an account may accept only its own organisation's accounts (sso-policy.ts).
 * Read from the ID token Better Auth just saved on the person's identity for that provider (the callback updates it
 * before it makes the session; the code step after it finds the same one); a session replaced while signed in keeps
 * the one it replaces. Null for a password / link session and a personal account without the claim.
 */
export const signInOrgOf = async (
  db: Db,
  raw: unknown,
  method: SignInMethod | null,
  userId: string,
): Promise<string | null> => {
  if (!method || !PROVIDERS.has(method)) return null;
  const ctx = (raw ?? {}) as HookCtx;
  if (!FRESH_PROVIDER_PATHS.has(ctx.path ?? '')) {
    const org = ctx.context?.session?.session?.signInOrg;
    return typeof org === 'string' && org ? org : null;
  }
  const row = (
    await db
      .select({ idToken: authIdentities.idToken })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, userId), eq(authIdentities.providerId, method)))
      .orderBy(desc(authIdentities.updatedAt))
      .limit(1)
  )[0];
  return ssoOrgFromClaims(method, jwtClaims(row?.idToken));
};
