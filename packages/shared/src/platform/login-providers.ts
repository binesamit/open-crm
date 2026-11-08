// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Sign-in providers (owner console → "ספקי התחברות"): "Continue with Google / Microsoft". The owner
 * pastes each provider's client id and secret in the console (the secret is sealed, never shown again); the server's
 * environment (GOOGLE_CLIENT_ID / _SECRET, MICROSOFT_CLIENT_ID / _SECRET / _TENANT_ID) is only the fallback when
 * nothing is saved. Changes apply without a restart.
 */
export const LOGIN_PROVIDERS = ['google', 'microsoft'] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];
export const loginProviderSchema = z.enum(LOGIN_PROVIDERS);

/** How a session was made (stored per session): a provider, a password, an email link, or unknown (older sessions). */
export const SIGN_IN_METHODS = ['password', 'magic_link', ...LOGIN_PROVIDERS] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/**
 * A Microsoft Entra tenant: `common` (work, school and personal accounts), `organizations`, `consumers`, or one
 * directory's id (GUID) / domain.
 */
export const microsoftTenantSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9.-]+$/);
export const MICROSOFT_DEFAULT_TENANT = 'common';

export const loginProviderTestSchema = z.object({
  ok: z.boolean(),
  at: z.string(),
  /** A short code when it failed (`invalid_client`, `unreachable`, …). */
  error: z.string().nullable(),
});
export type LoginProviderTest = z.infer<typeof loginProviderTestSchema>;

/** One provider as the owner console sees it (never the secret). */
export const loginProviderStateSchema = z
  .object({
    provider: loginProviderSchema,
    /** The owner's switch (default on: a provider with credentials is offered). */
    enabled: z.boolean(),
    client_id: z.string().nullable(),
    has_secret: z.boolean(),
    /** `…AbCd` — the last characters of the saved secret, to recognise it. */
    secret_hint: z.string().nullable(),
    /** Microsoft only. */
    tenant_id: z.string().nullable(),
    /** Where the credentials in effect come from: the console, the environment, or none yet. */
    source: z.enum(['setting', 'env', 'none']),
    /** Offered on the sign-in screen now (switched on and has credentials). */
    active: z.boolean(),
    /** The exact return address to register with the provider. */
    redirect_uri: z.string(),
    /** The environment has its own credentials for this provider (shown as the fallback). */
    env_configured: z.boolean(),
    last_test: loginProviderTestSchema.nullable(),
  })
  .meta({ id: 'LoginProviderState' });
export type LoginProviderState = z.infer<typeof loginProviderStateSchema>;

export const loginProvidersResponseSchema = z.object({ data: z.array(loginProviderStateSchema) });
export type LoginProvidersResponse = z.infer<typeof loginProvidersResponseSchema>;

/** PATCH /platform/login-providers/{provider}: only what is sent changes; null clears (back to the environment). */
export const updateLoginProviderSchema = z.object({
  enabled: z.boolean().optional(),
  client_id: z.string().trim().min(1).max(300).nullable().optional(),
  /** Write-only; sealed at rest. */
  client_secret: z.string().trim().min(1).max(500).nullable().optional(),
  tenant_id: microsoftTenantSchema.nullable().optional(),
});
export type UpdateLoginProvider = z.infer<typeof updateLoginProviderSchema>;

/** A Google Workspace domain (the `hd` claim of a Google ID token). */
export const ssoGoogleDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/);
/** A Microsoft Entra directory (tenant) id (the `tid` claim of a Microsoft ID token): a GUID. */
export const ssoMicrosoftTenantSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The account's sign-in policy (Administration → אבטחה): members must sign in through a provider. */
export const accountSsoPolicySchema = z.object({
  required: z.boolean().default(false),
  /** Which providers count (at least one when required). */
  providers: z.array(loginProviderSchema).default([...LOGIN_PROVIDERS]),
  /** The requirement covers people with these email domains; empty = every member. */
  domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
    )
    .max(20)
    .default([]),
  /** Admins may still sign in with a password / link (a way back in). The platform owner is always exempt. */
  exempt_admins: z.boolean().default(false),
  /**
   * S-72: a Google sign-in counts only from these Google Workspace domains (the ID token's `hd` claim); empty = any
   * Google account (also a personal one). Recommended when the account requires Google.
   */
  google_domains: z.array(ssoGoogleDomainSchema).max(20).default([]),
  /**
   * S-72: a Microsoft sign-in counts only from these Entra directories (the ID token's `tid` claim); empty = any
   * Microsoft account (also a personal one). Recommended when the account requires Microsoft.
   */
  microsoft_tenants: z.array(ssoMicrosoftTenantSchema).max(20).default([]),
});
export type AccountSsoPolicy = z.infer<typeof accountSsoPolicySchema>;

/** An account (of mine) that will not open with how I signed in now, and the providers it accepts. */
export const ssoGateSchema = z.object({
  account_id: z.string(),
  providers: z.array(loginProviderSchema),
  /** S-72: I did sign in through an accepted provider, but with an account of another organisation. */
  organization: z.boolean().optional(),
});
export type SsoGate = z.infer<typeof ssoGateSchema>;

/** Whether `email` is covered by an account's SSO requirement (domain list, empty = everyone). */
export const ssoCovers = (policy: Pick<AccountSsoPolicy, 'domains'>, email: string) =>
  !policy.domains.length || policy.domains.includes(email.split('@').pop()?.toLowerCase() ?? '');

/**
 * S-72: the organisation a provider sign-in came from (stored with the session): Google's `hd` (a Workspace domain;
 * none for a personal account), Microsoft's `tid` (the directory). Null for a password / link session or no claim.
 */
export const ssoOrgFromClaims = (provider: string, claims: Record<string, unknown>): string | null => {
  const v = provider === 'google' ? claims.hd : provider === 'microsoft' ? claims.tid : undefined;
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase().slice(0, 200) : null;
};

/** S-72: whether a provider session's organisation is one the policy accepts for that provider (empty list = any). */
export const ssoOrgAllowed = (
  policy: Pick<AccountSsoPolicy, 'google_domains' | 'microsoft_tenants'>,
  method: string | null | undefined,
  org: string | null | undefined,
) => {
  const list = method === 'google' ? policy.google_domains : method === 'microsoft' ? policy.microsoft_tenants : [];
  return !list?.length || (!!org && list.includes(org.toLowerCase()));
};
