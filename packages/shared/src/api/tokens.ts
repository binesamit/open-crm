// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { dailyQuotaSchema, perMinuteLimitSchema } from '../platform/settings';

/**
 * API tokens (06 §1.2–1.3): personal tokens `bos_pat_…`, bound to one account; they act as their user with the
 * token's scopes ∩ the user's permissions. Only the hash is stored; the token is shown once.
 */
export const TOKEN_SCOPES = [
  'boards:read',
  'boards:write',
  'items:write',
  'updates:read',
  'updates:write',
  'users:read',
  'users:write',
  'teams:write',
  'automations:read',
  'automations:write',
  'agents:read',
  'agents:run',
  'agents:write',
  'webhooks',
  'notifications:read',
  'notifications:write',
  'search',
  'admin',
  // Secret columns: reveal a secret's value. Never implied, not even by `admin`.
  'secrets:read',
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Scopes only account admins may give a token. */
export const ADMIN_ONLY_SCOPES: TokenScope[] = ['admin', 'users:write', 'secrets:read'];

/** S-85: how fresh (minutes) the two-factor code must be to mint a personal `secrets:read` token. */
export const SECRET_TOKEN_STEP_UP_MINUTES = 5;

/** What a scope also allows (a write implies its read; admin everything but `secrets:read`). */
export const scopeAllows = (granted: readonly string[], required: TokenScope): boolean => {
  // A secret's value only with the scope itself (default none): `admin` does not include it.
  if (required === 'secrets:read') return granted.includes('secrets:read');
  if (granted.includes('admin') || granted.includes(required)) return true;
  const implied: Partial<Record<TokenScope, TokenScope[]>> = {
    'boards:read': ['boards:write', 'items:write'],
    'updates:read': ['updates:write'],
    'users:read': ['users:write', 'teams:write'],
    'automations:read': ['automations:write'],
    // AI agents: running one lets a token see the agent and its runs; managing includes running.
    'agents:read': ['agents:run', 'agents:write'],
    'agents:run': ['agents:write'],
    'notifications:read': ['notifications:write'],
  };
  return (implied[required] ?? []).some((s) => granted.includes(s));
};

export const TOKEN_PREFIX = 'bos_pat_';
/** Service tokens (06 §1.2): an account-level identity "שירות: <name>", created by admins. */
export const SERVICE_TOKEN_PREFIX = 'bos_svc_';
export const isApiToken = (s: string) => s.startsWith(TOKEN_PREFIX) || s.startsWith(SERVICE_TOKEN_PREFIX);

export const apiTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** `bos_pat_AbCd` — enough to recognize it, never enough to use it. */
    prefix: z.string(),
    scopes: z.array(z.string()),
    user_id: z.string().nullable(),
    user_name: z.string().nullable(),
    /** A service token (its user is a service identity, not a person). */
    service: z.boolean(),
    /** The token's own budget a minute; null = the account's (or the platform's) default. */
    rate_limit_per_minute: z.number().int().nullable(),
    /** The token's own budget a day; null = the account's (or the platform's) default. */
    daily_quota: z.number().int().nullable(),
    /** What the token runs with now (its own override, else the account's, else the platform's). */
    limits: z.object({
      per_minute: z.number().int(),
      daily: z.number().int(),
      /** What it would run with without its own override (the account's, else the platform's). */
      default_per_minute: z.number().int(),
      default_daily: z.number().int(),
    }),
    /** null = every board the user can see. */
    board_ids: z.array(z.string()).nullable(),
    last_used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .meta({ id: 'ApiToken' });
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  /** Limit the token to these boards (and their subitems); omitted = every board the user can see. */
  board_ids: z.array(z.string()).min(1).max(100).optional(),
  /** null = never expires. */
  expires_in_days: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(90),
  /** Its own budget a minute (omitted / null = the account's default). */
  rate_limit_per_minute: perMinuteLimitSchema.nullable().optional(),
  /** Its own budget a day (omitted / null = the account's default). */
  daily_quota: dailyQuotaSchema.nullable().optional(),
});

/** PATCH /tokens/{id}: the token's own budgets; null = back to the account's default. */
export const updateTokenLimitsSchema = z.object({
  rate_limit_per_minute: perMinuteLimitSchema.nullable().optional(),
  daily_quota: dailyQuotaSchema.nullable().optional(),
});
export type UpdateTokenLimits = z.infer<typeof updateTokenLimitsSchema>;

/** A service token: a new service member of the account (its role caps what the token may do) + its token. */
export const createServiceTokenSchema = createTokenSchema.extend({
  role: z.enum(['member', 'admin']).default('member'),
});

/** The one response that carries the secret. */
export const createdTokenSchema = apiTokenSchema.extend({ token: z.string() });
export type CreatedToken = z.infer<typeof createdTokenSchema>;
