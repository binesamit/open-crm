// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { passwordMinLengthSchema } from './password';
import { accountSupportSettingsSchema, supportHoursSchema } from './support';
import { SECRET_LIMITS } from '../columns/defs/secret';
import {
  accountSsoPolicySchema,
  loginProviderSchema,
  ssoGoogleDomainSchema,
  ssoMicrosoftTenantSchema,
} from '../platform/login-providers';

/**
 * Administration A4 + A5 (08 §5, §8, §9, §11): security (sessions, allowed domains, guest domain policy), the audit
 * log, usage and tidy up. Admins only.
 */

// ---- security (08 §5) ----
export const emailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/);

export const GUEST_DOMAIN_MODES = ['any', 'allow_list', 'block_list'] as const;
export type GuestDomainMode = (typeof GUEST_DOMAIN_MODES)[number];

export const guestDomainPolicySchema = z.object({
  mode: z.enum(GUEST_DOMAIN_MODES).default('any'),
  domains: z.array(emailDomainSchema).max(50).default([]),
});
export type GuestDomainPolicy = z.infer<typeof guestDomainPolicySchema>;

export const AUTO_JOIN_ROLES = ['member', 'viewer'] as const;

/**
 * `account_settings.settings.security` (08 §5). The account's own domains stay in `settings.domains` (08 §2);
 * `restrict_members_to_domains` limits invitations of members / viewers / admins to them.
 */
/**
 * Two-factor authentication policy (M8 ד12, D25: optional for everyone; an admin may require it). `required_since`
 * is set by the server when the requirement starts or widens: people without 2FA have `grace_days` from then, after
 * which the account's pages need it (enrolment right after the next sign-in).
 */
export const TWO_FACTOR_MODES = ['optional', 'required_admins', 'required_all'] as const;
export type TwoFactorMode = (typeof TWO_FACTOR_MODES)[number];
export const TWO_FACTOR_MAX_GRACE_DAYS = 30;
export const twoFactorPolicySchema = z.object({
  mode: z.enum(TWO_FACTOR_MODES).default('optional'),
  grace_days: z.number().int().min(0).max(TWO_FACTOR_MAX_GRACE_DAYS).default(7),
  required_since: z.string().nullable().default(null),
});
export type TwoFactorPolicy = z.infer<typeof twoFactorPolicySchema>;

/** One address (`203.0.113.7`, `2001:db8::1`) or a CIDR range (`203.0.113.0/24`, `2001:db8::/48`). */
export const ipRangeSchema = z
  .string()
  .trim()
  .pipe(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]));
export const IP_ALLOWLIST_MAX = 100;
/**
 * IP allowlist (M8 ד12): off by default. On, the account's pages and API answer only from these addresses (by the
 * real client address, lib/client-ip.ts S-10). Saving it on requires the saver's own address to be inside.
 */
export const IP_EXEMPT_MAX = 50;
export const ipAllowlistSchema = z.object({
  enabled: z.boolean().default(false),
  ranges: z.array(ipRangeSchema).max(IP_ALLOWLIST_MAX).default([]),
  /** People of the account the list does not hold: a traveller, an outside contractor. */
  exempt_user_ids: z.array(z.string().max(26)).max(IP_EXEMPT_MAX).default([]),
});
export type IpAllowlist = z.infer<typeof ipAllowlistSchema>;

export const secretMaxVerifyMinutesSchema = z
  .number()
  .int()
  .min(SECRET_LIMITS.verifyMinutes.min)
  .max(SECRET_LIMITS.verifyMinutes.max);

export const accountSecuritySchema = z.object({
  restrict_members_to_domains: z.boolean().default(false),
  auto_join: z.boolean().default(false),
  auto_join_role: z.enum(AUTO_JOIN_ROLES).default('member'),
  guest_domain_policy: guestDomainPolicySchema.default({ mode: 'any', domains: [] }),
  two_factor: twoFactorPolicySchema.default({ mode: 'optional', grace_days: 7, required_since: null }),
  ip_allowlist: ipAllowlistSchema.default({ enabled: false, ranges: [], exempt_user_ids: [] }),
  support_access: accountSupportSettingsSchema.default({ allow_edit: false, max_hours: 168 }),
  /** The shortest password the account's people may choose; null = the platform's default. */
  password_min_length: passwordMinLengthSchema.nullable().default(null),
  /**
   * the longest a fresh two-factor code may count for secrets (columns, secret updates, a board's
   * delete-with-code), whatever a column or board sets — an admin's ceiling for the whole account. Default 12 hours.
   */
  secret_max_verify_minutes: secretMaxVerifyMinutesSchema.default(SECRET_LIMITS.verifyMinutes.max),
  /** Sign in through Google / Microsoft only; off by default. */
  sso: accountSsoPolicySchema.default({
    required: false,
    providers: ['google', 'microsoft'],
    domains: [],
    exempt_admins: false,
    google_domains: [],
    microsoft_tenants: [],
  }),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

/** GET /security */
export const securitySettingsSchema = accountSecuritySchema.extend({
  domains: z.array(z.string()),
  /** The address this request came from (for the IP allowlist: you cannot save a list that leaves you out). */
  current_ip: z.string().nullable().optional(),
  /** The platform's minimum password length, what an empty `password_min_length` means (placeholder). */
  platform_password_min_length: z.number().int().optional(),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;

/** PATCH /security — only what is sent changes. */
export const updateSecuritySchema = z.object({
  domains: z.array(emailDomainSchema).max(20).optional(),
  restrict_members_to_domains: z.boolean().optional(),
  auto_join: z.boolean().optional(),
  auto_join_role: z.enum(AUTO_JOIN_ROLES).optional(),
  guest_domain_policy: z
    .object({
      mode: z.enum(GUEST_DOMAIN_MODES),
      domains: z.array(emailDomainSchema).max(50),
    })
    .optional(),
  two_factor: z
    .object({
      mode: z.enum(TWO_FACTOR_MODES),
      grace_days: z.number().int().min(0).max(TWO_FACTOR_MAX_GRACE_DAYS).optional(),
    })
    .optional(),
  ip_allowlist: z
    .object({
      enabled: z.boolean(),
      ranges: z.array(ipRangeSchema).max(IP_ALLOWLIST_MAX),
      exempt_user_ids: z.array(z.string().max(26)).max(IP_EXEMPT_MAX),
    })
    .partial()
    .optional(),
  support_access: z.object({ allow_edit: z.boolean(), max_hours: supportHoursSchema }).partial().optional(),
  /** null = back to the platform's default. */
  password_min_length: passwordMinLengthSchema.nullable().optional(),
  secret_max_verify_minutes: secretMaxVerifyMinutesSchema.optional(),
  sso: z
    .object({
      required: z.boolean(),
      providers: z.array(loginProviderSchema).max(10),
      domains: z.array(emailDomainSchema).max(20),
      exempt_admins: z.boolean(),
      google_domains: z.array(ssoGoogleDomainSchema).max(20),
      microsoft_tenants: z.array(ssoMicrosoftTenantSchema).max(20),
    })
    .partial()
    .optional(),
});
export type UpdateSecurity = z.infer<typeof updateSecuritySchema>;

/** A sign-in (Better Auth session) of a member of the account. Sessions are global per person (D12). */
export const accountSessionSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string(),
  user_email: z.string(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  created_at: z.string(),
  last_seen_at: z.string(),
  expires_at: z.string(),
  /** The session making this request. */
  current: z.boolean(),
  /** The person is also an active member of another account — signing out ends their sessions there too. */
  other_accounts: z.boolean(),
  /** The person is an admin of another account: only that account (or they) may sign them out (S-15). */
  admin_elsewhere: z.boolean(),
});
export type AccountSession = z.infer<typeof accountSessionSchema>;

export const signOutResultSchema = z.object({
  signed_out: z.number().int(),
  /** sign-out-all: sessions left alone because their person is an admin of another account (S-15). */
  skipped: z.number().int().optional(),
});
export type SignOutResult = z.infer<typeof signOutResultSchema>;

// ---- audit log (08 §11) ----
const isoDay = z.iso.date();

export const auditQuerySchema = z.object({
  actor_id: z.string().optional(),
  event: z.string().max(64).optional(),
  /** Inclusive days (YYYY-MM-DD, UTC). */
  from: isoDay.optional(),
  to: isoDay.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditEntrySchema = z.object({
  id: z.string(),
  created_at: z.string(),
  actor_id: z.string().nullable(),
  actor_name: z.string().nullable(),
  event: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  /** A person's name, a board's name… when the target is known. */
  target_name: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditPageSchema = z.object({
  data: z.array(auditEntrySchema),
  total: z.number().int(),
  page: z.number().int(),
  page_size: z.number().int(),
  /** Every event type the account's log holds (for the filter). */
  events: z.array(z.string()),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

// ---- usage (08 §8) ----
export const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

export const usageSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.number().int(),
  automation_runs: z.number().int(),
  automation_failures: z.number().int(),
  /** API calls are not counted per request (rate limits live in memory): null. */
  api_calls: z.number().int().nullable(),
  /** Tokens used in the period (by their last use). */
  tokens_used: z.number().int(),
  webhook_deliveries: z.number().int(),
  webhook_failures: z.number().int(),
  storage_bytes: z.number(),
  files: z.number().int(),
  items_total: z.number().int(),
  boards_total: z.number().int(),
  active_users: z.number().int(),
  members_total: z.number().int(),
  daily: z.array(
    z.object({ day: z.string(), automation_runs: z.number().int(), webhook_deliveries: z.number().int() }),
  ),
  top_automations: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      board_id: z.string().nullable(),
      board_name: z.string().nullable(),
      runs: z.number().int(),
      failures: z.number().int(),
      last_run_at: z.string().nullable(),
      is_active: z.boolean(),
    }),
  ),
  top_tokens: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      prefix: z.string(),
      user_name: z.string().nullable(),
      service: z.boolean(),
      last_used_at: z.string().nullable(),
    }),
  ),
});
export type Usage = z.infer<typeof usageSchema>;

// ---- tidy up (08 §9) ----
export const adminBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  kind: z.enum(['main', 'shareable', 'private']),
  created_by_name: z.string().nullable(),
  owners: z.array(z.object({ user_id: z.string(), name: z.string(), active: z.boolean() })),
  owner_teams: z.array(z.object({ team_id: z.string(), name: z.string() })),
  has_active_owner: z.boolean(),
  items_count: z.number().int(),
  /** The newest change to the board or its items. */
  updated_at: z.string(),
  archived_at: z.string().nullable(),
  /** False = private / shareable without a subscription: the admin sees the metadata only. */
  content_access: z.boolean(),
});
export type AdminBoard = z.infer<typeof adminBoardSchema>;

export const transferBoardSchema = z.object({
  to_user_id: z.string(),
  /** Keep today's owners as owners too (default: they become subscribers). */
  keep_current_owners: z.boolean().default(false),
});
export type TransferBoard = z.input<typeof transferBoardSchema>;

// ---- scheduled cleaning (M8 ד13, 08 §9) ----
/**
 * The account's cleaning rules, run daily by the worker job `tidy.scheduled_cleaning`. Rules that touch people's
 * content are off until an admin turns them on; purely technical retention (automatic doc versions, agent run
 * logs, expired OAuth codes and tokens) is on by default.
 */
export const TIDY_RULE_KEYS = [
  'archive_done_items',
  'archive_idle_boards',
  'empty_trash',
  'notifications_retention',
  'activity_retention',
  'doc_auto_versions',
  'agent_run_logs',
  'expired_oauth',
] as const;
export type TidyRuleKey = (typeof TIDY_RULE_KEYS)[number];

/** Per rule: on by default (technical), default days and the allowed range. */
export const TIDY_RULE_DEFS: Record<
  TidyRuleKey,
  { technical: boolean; days: number; min: number; max: number; workspaces?: true }
> = {
  archive_done_items: { technical: false, days: 30, min: 1, max: 3650, workspaces: true },
  archive_idle_boards: { technical: false, days: 180, min: 30, max: 3650, workspaces: true },
  // The trash empties itself after 30 days anyway (CLAUDE.md rule 3): this only makes it sooner.
  empty_trash: { technical: false, days: 7, min: 1, max: 29 },
  notifications_retention: { technical: false, days: 180, min: 30, max: 3650 },
  activity_retention: { technical: false, days: 365, min: 90, max: 3650 },
  doc_auto_versions: { technical: true, days: 90, min: 7, max: 3650 },
  agent_run_logs: { technical: true, days: 90, min: 30, max: 3650 },
  expired_oauth: { technical: true, days: 30, min: 1, max: 365 },
};

export const tidyRuleSchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(1).max(3650),
  /** archive_* rules: workspaces left alone. */
  exclude_workspace_ids: z.array(z.string()).max(200),
});
export type TidyRule = z.infer<typeof tidyRuleSchema>;
export type TidyRules = Record<TidyRuleKey, TidyRule>;

const partialRule = tidyRuleSchema.partial();

/** The rules with every default filled in (what is stored may be partial or missing). */
export const tidyRulesOf = (raw: unknown): TidyRules => {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as TidyRules;
  for (const key of TIDY_RULE_KEYS) {
    const def = TIDY_RULE_DEFS[key];
    const parsed = partialRule.safeParse(stored[key] ?? {});
    const v = parsed.success ? parsed.data : {};
    out[key] = {
      enabled: v.enabled ?? def.technical,
      days: Math.min(def.max, Math.max(def.min, v.days ?? def.days)),
      exclude_workspace_ids: def.workspaces ? (v.exclude_workspace_ids ?? []) : [],
    };
  }
  return out;
};

/** PUT /admin/tidy/rules — only the rules sent change (days checked against each rule's range). */
export const updateTidyRulesSchema = z
  .object({
    archive_done_items: partialRule.optional(),
    archive_idle_boards: partialRule.optional(),
    empty_trash: partialRule.optional(),
    notifications_retention: partialRule.optional(),
    activity_retention: partialRule.optional(),
    doc_auto_versions: partialRule.optional(),
    agent_run_logs: partialRule.optional(),
    expired_oauth: partialRule.optional(),
  })
  .superRefine((v, ctx) => {
    for (const key of TIDY_RULE_KEYS) {
      const days = v[key]?.days;
      const def = TIDY_RULE_DEFS[key];
      if (days !== undefined && (days < def.min || days > def.max))
        ctx.addIssue({ code: 'custom', path: [key, 'days'], message: `between ${def.min} and ${def.max}` });
    }
  });
export type UpdateTidyRules = z.infer<typeof updateTidyRulesSchema>;

export const tidyRuleResultSchema = z.object({
  rule: z.enum(TIDY_RULE_KEYS),
  count: z.number().int(),
  error: z.string().optional(),
});
export type TidyRuleResult = z.infer<typeof tidyRuleResultSchema>;

export const tidyRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  status: z.enum(['succeeded', 'partial', 'failed']),
  results: z.array(tidyRuleResultSchema),
  actor_name: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string(),
});
export type TidyRun = z.infer<typeof tidyRunSchema>;

/** GET /admin/tidy/rules */
export const tidySettingsSchema = z.object({
  rules: z.object({
    archive_done_items: tidyRuleSchema,
    archive_idle_boards: tidyRuleSchema,
    empty_trash: tidyRuleSchema,
    notifications_retention: tidyRuleSchema,
    activity_retention: tidyRuleSchema,
    doc_auto_versions: tidyRuleSchema,
    agent_run_logs: tidyRuleSchema,
    expired_oauth: tidyRuleSchema,
  }),
  last_run: tidyRunSchema.nullable(),
});
export type TidySettings = z.infer<typeof tidySettingsSchema>;

export const tidySampleSchema = z.object({
  rule: z.enum(TIDY_RULE_KEYS),
  type: z.string(),
  id: z.string(),
  name: z.string(),
});
export type TidySample = z.infer<typeof tidySampleSchema>;

/** POST /admin/tidy/preview — what a run would do now (nothing changes). */
export const tidyPreviewSchema = z.object({
  results: z.array(tidyRuleResultSchema),
  /** What the content rules would touch (archive_* / empty_trash), up to 50 per rule. */
  samples: z.array(tidySampleSchema),
});
export type TidyPreview = z.infer<typeof tidyPreviewSchema>;
