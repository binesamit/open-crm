// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DEFAULT_REGION } from '../locale';

/**
 * Errors & health hub: every failure the platform sees — automation runs, agents, AI calls, external
 * flows, webhooks, email / SMS, imports, background jobs, extension servers, the browser and the server's own code —
 * becomes one row of `error_events`, deduplicated by a fingerprint (count, first / last seen). Rows carry metadata
 * and a redacted message only: never item values, people's addresses, secrets or tokens. The owner console's
 * "Errors & health" section works them (status, assignee, tickets, alerts); an account's admins see their own on the
 * account's Health page. Every threshold, retention, source switch and alert is a setting (`errorHubSettingsSchema`).
 */

export const ERROR_SOURCES = [
  'automation',
  'agent',
  'ai',
  'flow',
  'webhook',
  'email',
  'sms',
  'import',
  'job',
  'extension',
  'client',
  'code',
] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const ERROR_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type ErrorSeverity = (typeof ERROR_SEVERITIES)[number];
export const severityRank = (s: ErrorSeverity) => ERROR_SEVERITIES.indexOf(s);
export const atLeast = (s: ErrorSeverity, min: ErrorSeverity) => severityRank(s) >= severityRank(min);

export const ERROR_STATUSES = ['new', 'acknowledged', 'resolved', 'ignored'] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];
/** Statuses still asking for attention (the default list, alerts, the account page's "open"). */
export const OPEN_ERROR_STATUSES: readonly ErrorStatus[] = ['new', 'acknowledged'];

/** Ids that link an event to what it is about — ids only, never names or values. */
export const ERROR_LINK_KEYS = [
  'board_id',
  'item_id',
  'automation_id',
  'run_id',
  'agent_id',
  'agent_run_id',
  'flow_connection_id',
  'flow_id',
  'flow_run_id',
  'webhook_id',
  'delivery_id',
  'import_job_id',
  'installation_id',
  'ai_connection_id',
  'job',
  'request_id',
  'page',
] as const;
export type ErrorLinkKey = (typeof ERROR_LINK_KEYS)[number];
export type ErrorLinks = Partial<Record<ErrorLinkKey, string>>;

// ---------------------------------------------------------------------------
// Redaction and fingerprints (one function for the api and the worker)
// ---------------------------------------------------------------------------

/**
 * Credentials that could ride along in an error text or a log line (docs/AI-SECURITY-REVIEW.md AI-RT7): AI provider
 * keys, our API / OAuth tokens and any bearer / basic value (CLAUDE.md rule 10). `apps/api/src/lib/scrub.ts` re-exports it.
 */
const SECRET = /\b(?:sk-ant-[\w-]{6,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|bos_(?:pat|svc|oat|ort)_[\w-]{6,})/g;
const AUTH = /\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi;
export const scrubSecrets = (s: string) => s.replace(SECRET, '[secret]').replace(AUTH, '$1 [secret]');

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;
const QUOTED = /"[^"\n]{1,200}"|'[^'\n]{1,200}'|“[^”\n]{1,200}”|«[^»\n]{1,200}»|`[^`\n]{1,200}`/g;
const LONG_TOKEN = /\b[A-Za-z0-9+/_=-]{32,}\b/g;
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
const KEY_VALUE = /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*\S+/gi;
export const MAX_ERROR_MESSAGE = 300;

/**
 * An error text made safe to keep and show to support (the plan's "no customer data contents"): credentials,
 * email addresses, query strings, quoted values (item names, cell values), long tokens and phone-like numbers are
 * masked, and the text is cut to `MAX_ERROR_MESSAGE` characters.
 */
export const redactErrorMessage = (raw: unknown): string => {
  const full = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw ?? '');
  // S-98: the patterns below are not linear on any input — cut first (with room for what the masks shorten).
  const text = full.slice(0, MAX_ERROR_MESSAGE * 8);
  return scrubSecrets(text)
    .replace(KEY_VALUE, '$1=[secret]')
    .replace(EMAIL, '[email]')
    .replace(URL_QUERY, '$1')
    .replace(QUOTED, '"…"')
    .replace(LONG_TOKEN, '[token]')
    .replace(PHONE, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE);
};

/** The message with its variable parts (ids, numbers) out — same error, same text. */
export const normalizeErrorMessage = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b[0-9a-hjkmnp-tv-z]{26}\b/gi, '#')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/\d+/g, '#');

/** FNV-1a, 64 bits (no crypto needed in the browser-safe package): 16 hex characters. */
export const fnv64 = (s: string) => {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
};

/** The link that tells two events of one source apart (the automation, the flow, the webhook …). */
const ENTITY_KEYS: ErrorLinkKey[] = [
  'automation_id',
  'agent_id',
  'flow_connection_id',
  'flow_id',
  'webhook_id',
  'installation_id',
  'ai_connection_id',
  'import_job_id',
  'job',
  'page',
];

/** One fingerprint per (source, code, normalized message, account, entity): identical failures share a row. */
export const errorFingerprint = (e: {
  source: ErrorSource;
  code: string;
  message: string;
  accountId: string | null;
  links?: ErrorLinks;
}) => {
  const entity = ENTITY_KEYS.map((k) => e.links?.[k] ?? '').join('|');
  return fnv64(
    [e.source, e.code, normalizeErrorMessage(e.message), e.accountId ?? '-', entity].join('\u0001'),
  ).padStart(16, '0');
};

// ---------------------------------------------------------------------------
// Settings (owner console → Errors & health → Settings)
// ---------------------------------------------------------------------------

/** Default severity of each source when the writer does not say otherwise. */
export const DEFAULT_SOURCE_SEVERITY: Record<ErrorSource, ErrorSeverity> = {
  automation: 'error',
  agent: 'error',
  ai: 'error',
  flow: 'error',
  webhook: 'warning',
  email: 'error',
  sms: 'error',
  import: 'error',
  job: 'error',
  extension: 'warning',
  client: 'warning',
  code: 'critical',
};

/**
 * Automation skips that are problems (decision 4: only real failures count). Everything else — a condition not
 * met, nothing to change, a loop guard on purpose — is a normal skip and never recorded.
 */
export const DEFAULT_PROBLEM_SKIPS = [
  'no_recipients',
  'no_phone',
  'agent_inactive',
  'not_agent_board',
  'unmappable',
  'not_available',
  'plan_read_only',
  'plan_suspended',
  'plan_limit_reached',
  'plan_feature_unavailable',
  'max_depth',
] as const;

const sourceSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  severity: z.enum(ERROR_SEVERITIES),
});
const sourcesShape = Object.fromEntries(
  ERROR_SOURCES.map((s) => [s, sourceSettingsSchema.default({ enabled: true, severity: DEFAULT_SOURCE_SEVERITY[s] })]),
) as Record<ErrorSource, z.ZodDefault<typeof sourceSettingsSchema>>;

export const ALERT_MODES = ['instant', 'digest'] as const;
export type AlertMode = (typeof ALERT_MODES)[number];
/** Who an alert reaches: the whole support team (staff + owners, decision 1), the platform owners, or chosen people. */
export const ALERT_AUDIENCES = ['support_team', 'owners', 'people'] as const;

const ruleId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
export const errorAlertRuleSchema = z.object({
  id: ruleId,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  /** Empty = every source. */
  sources: z.array(z.enum(ERROR_SOURCES)).max(ERROR_SOURCES.length).default([]),
  min_severity: z.enum(ERROR_SEVERITIES).default('error'),
  /** Only this account (null = all). */
  account_id: z.string().min(1).max(26).nullable().default(null),
  /** Fires when one error happened at least this many times in the window. */
  threshold: z.number().int().min(1).max(100_000).default(1),
  window_hours: z.number().int().min(1).max(168).default(1),
  mode: z.enum(ALERT_MODES).default('instant'),
  channels: z.object({ bell: z.boolean().default(true), email: z.boolean().default(true) }).default({
    bell: true,
    email: true,
  }),
  audience: z.enum(ALERT_AUDIENCES).default('support_team'),
  /** `audience: people` — these users (support staff or owners). */
  user_ids: z.array(z.string().min(1).max(26)).max(50).default([]),
});
export type ErrorAlertRule = z.infer<typeof errorAlertRuleSchema>;

export const DEFAULT_ALERT_RULES: ErrorAlertRule[] = [
  {
    id: 'critical',
    name: 'Critical',
    enabled: true,
    sources: [],
    min_severity: 'critical',
    account_id: null,
    threshold: 1,
    window_hours: 1,
    mode: 'instant',
    channels: { bell: true, email: true },
    audience: 'support_team',
    user_ids: [],
  },
  {
    id: 'spike',
    name: 'Spike',
    enabled: true,
    sources: [],
    min_severity: 'error',
    account_id: null,
    threshold: 20,
    window_hours: 1,
    mode: 'instant',
    channels: { bell: true, email: true },
    audience: 'support_team',
    user_ids: [],
  },
  {
    id: 'daily',
    name: 'Daily digest',
    enabled: true,
    sources: [],
    min_severity: 'warning',
    account_id: null,
    threshold: 1,
    window_hours: 24,
    mode: 'digest',
    channels: { bell: true, email: true },
    audience: 'support_team',
    user_ids: [],
  },
];

/** A mute: alerts that match stay quiet until `until` (events are still recorded). Empty fields match anything. */
export const errorMuteSchema = z.object({
  id: ruleId,
  source: z.enum(ERROR_SOURCES).nullable().default(null),
  account_id: z.string().min(1).max(26).nullable().default(null),
  /** Case-insensitive text the message or code contains. */
  text: z.string().trim().max(120).nullable().default(null),
  until: z.iso.datetime({ offset: true }),
});
export type ErrorMute = z.infer<typeof errorMuteSchema>;

const retentionSchema = z.object({
  info: z.number().int().min(1).max(3650).default(14),
  warning: z.number().int().min(1).max(3650).default(30),
  error: z.number().int().min(1).max(3650).default(90),
  critical: z.number().int().min(1).max(3650).default(90),
});

const alertsSettingsSchema = z.object({
  rules: z
    .array(errorAlertRuleSchema)
    .max(30)
    .default(() => DEFAULT_ALERT_RULES.map((r) => ({ ...r }))),
  /** Digest rules are sent once a day at this hour, in this zone. */
  digest_hour: z.number().int().min(0).max(23).default(8),
  timezone: z.string().min(1).max(64).default(DEFAULT_REGION.timezone),
  mutes: z.array(errorMuteSchema).max(100).default([]),
});

const adminAlertsSchema = z.object({
  enabled: z.boolean().default(false),
  min_severity: z.enum(ERROR_SEVERITIES).default('error'),
  threshold: z.number().int().min(1).max(100_000).default(5),
  window_hours: z.number().int().min(1).max(168).default(1),
});
const accountPageSchema = z.object({
  enabled: z.boolean().default(true),
  sources: z
    .array(z.enum(ERROR_SOURCES))
    .default(['automation', 'agent', 'ai', 'flow', 'webhook', 'email', 'sms', 'import', 'extension']),
  admin_alerts: adminAlertsSchema.default(() => adminAlertsSchema.parse({})),
});

export const errorHubSettingsSchema = z.object({
  sources: z.object(sourcesShape).default(() => z.object(sourcesShape).parse({})),
  /** Automation skips that count as problems (the rest are normal and never recorded). */
  problem_skips: z
    .array(z.string().regex(/^[a-z0-9_]{1,60}$/))
    .max(100)
    .default([...DEFAULT_PROBLEM_SKIPS]),
  /** Days a row is kept after it was last seen, by severity. */
  retention_days: retentionSchema.default(() => retentionSchema.parse({})),
  /** An open error with no new occurrence for this long resolves itself (0 = never); a new one reopens it. */
  auto_resolve_hours: z.number().int().min(0).max(8760).default(72),
  /** The async writer: pending distinct errors before new ones are dropped (and counted), and its flush interval. */
  writer: z
    .object({
      max_queue: z.number().int().min(10).max(100_000).default(2000),
      flush_seconds: z.number().int().min(1).max(60).default(3),
    })
    .default({ max_queue: 2000, flush_seconds: 3 }),
  /** Browser errors sent automatically (decision 5): a share of them, scrubbed, at most so many per person an hour. */
  client: z
    .object({
      enabled: z.boolean().default(true),
      sample_rate: z.number().min(0).max(1).default(0.25),
      per_user_per_hour: z.number().int().min(1).max(1000).default(20),
    })
    .default({ enabled: true, sample_rate: 0.25, per_user_per_hour: 20 }),
  /** The "Spikes" view: the last hour at least `factor` × the day's hourly average, and at least `min_count`. */
  spike: z
    .object({
      factor: z.number().min(1).max(100).default(3),
      min_count: z.number().int().min(1).max(100_000).default(10),
    })
    .default({ factor: 3, min_count: 10 }),
  alerts: alertsSettingsSchema.default(() => alertsSettingsSchema.parse({})),
  /**
   * The account's own Health page (decision 2: "first to us"): shown to its admins with the sources chosen here;
   * alerts to the account's admins are off until the owner turns them on.
   */
  account_page: accountPageSchema.default(() => accountPageSchema.parse({})),
  /** GlitchTip (code errors): its address and organization — "open in GlitchTip" searches by the request id. */
  glitchtip: z
    .object({
      base_url: z.url().max(300).nullable().default(null),
      organization: z
        .string()
        .regex(/^[\w.-]{1,80}$/)
        .nullable()
        .default(null),
    })
    .default({ base_url: null, organization: null }),
});
export type ErrorHubSettings = z.infer<typeof errorHubSettingsSchema>;

/** PATCH: top-level parts are replaced whole when sent (each part is small; the console sends the edited part). */
export const updateErrorHubSettingsSchema = z
  .object({
    sources: z.object(sourcesShape).partial(),
    problem_skips: z.array(z.string().regex(/^[a-z0-9_]{1,60}$/)).max(100),
    retention_days: retentionSchema.partial(),
    auto_resolve_hours: z.number().int().min(0).max(8760),
    writer: z.object({
      max_queue: z.number().int().min(10).max(100_000),
      flush_seconds: z.number().int().min(1).max(60),
    }),
    client: z.object({
      enabled: z.boolean(),
      sample_rate: z.number().min(0).max(1),
      per_user_per_hour: z.number().int().min(1).max(1000),
    }),
    spike: z.object({ factor: z.number().min(1).max(100), min_count: z.number().int().min(1).max(100_000) }),
    alerts: z.object({
      rules: z.array(errorAlertRuleSchema).max(30),
      digest_hour: z.number().int().min(0).max(23),
      timezone: z.string().min(1).max(64),
      mutes: z.array(errorMuteSchema).max(100),
    }),
    account_page: z.object({
      enabled: z.boolean(),
      sources: z.array(z.enum(ERROR_SOURCES)),
      admin_alerts: z.object({
        enabled: z.boolean(),
        min_severity: z.enum(ERROR_SEVERITIES),
        threshold: z.number().int().min(1).max(100_000),
        window_hours: z.number().int().min(1).max(168),
      }),
    }),
    glitchtip: z.object({
      base_url: z.url().max(300).nullable(),
      organization: z
        .string()
        .regex(/^[\w.-]{1,80}$/)
        .nullable(),
    }),
  })
  .partial();
export type UpdateErrorHubSettings = z.infer<typeof updateErrorHubSettingsSchema>;

/** "Open in GlitchTip": the organization's issues searched by the request id (null when GlitchTip is not set). */
export const glitchtipUrl = (s: ErrorHubSettings['glitchtip'], requestId: string | undefined | null) => {
  if (!s.base_url || !s.organization || !requestId) return null;
  return `${s.base_url.replace(/\/+$/, '')}/${s.organization}/issues?query=${encodeURIComponent(`request_id:${requestId}`)}`;
};

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
const ref = z.object({ id: z.string(), name: z.string() });

export const errorEventSchema = z.object({
  id: z.string(),
  account: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  source: z.enum(ERROR_SOURCES),
  code: z.string(),
  severity: z.enum(ERROR_SEVERITIES),
  message: z.string(),
  links: z.record(z.string(), z.string()),
  count: z.number().int(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  status: z.enum(ERROR_STATUSES),
  assignee: ref.nullable(),
  muted_until: z.string().nullable(),
  resolved_at: z.string().nullable(),
  reopened_count: z.number().int(),
  ticket: z.object({ id: z.string(), number: z.number().int() }).nullable(),
  note: z.string().nullable(),
  /** Occurrences in the last hour (the list's "now" column; spikes). */
  last_hour: z.number().int(),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

export const ERROR_VIEWS = ['all', 'recurring', 'spikes'] as const;
export type ErrorView = (typeof ERROR_VIEWS)[number];

export const errorFilterSchema = z.object({
  view: z.enum(ERROR_VIEWS).optional(),
  /** Comma lists. */
  source: z.string().max(200).optional(),
  severity: z.string().max(60).optional(),
  status: z.string().max(60).optional(),
  account_id: z.string().max(26).optional(),
  /** A user id, `me` or `none`. */
  assignee: z.string().max(26).optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});
export type ErrorFilter = z.infer<typeof errorFilterSchema>;

export const errorListSchema = z.object({ data: z.array(errorEventSchema), total: z.number().int() });

export const errorAccountSummarySchema = z.object({
  account: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  open: z.number().int(),
  critical: z.number().int(),
  occurrences_24h: z.number().int(),
  last_seen_at: z.string().nullable(),
});
export const errorAccountsSchema = z.object({ data: z.array(errorAccountSummarySchema) });

/** One step of an automation / agent run as support may see it: types, statuses and codes — never values. */
export const errorTraceStepSchema = z.object({
  index: z.number().int(),
  type: z.string(),
  status: z.string(),
  code: z.string().nullable(),
  reason: z.string().nullable(),
  duration_ms: z.number().nullable(),
});

export const errorDetailSchema = z.object({
  event: errorEventSchema,
  /** Occurrences per hour, the last 24 hours (oldest first). */
  hourly: z.array(z.object({ hour: z.string(), count: z.number().int() })),
  /**
   * Opening the account's data needs an active support grant (or a membership): `granted` says whether this person
   * has one now; the trace and the "open in the account" link come only then.
   */
  access: z.object({ granted: z.boolean(), mode: z.enum(['member', 'view', 'edit']).nullable() }),
  trace: z.array(errorTraceStepSchema).nullable(),
  /** Where the error opens inside the account (only with access). */
  open_path: z.string().nullable(),
  glitchtip_url: z.string().nullable(),
});
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const updateErrorEventSchema = z
  .object({
    status: z.enum(ERROR_STATUSES),
    assignee_id: z.string().min(1).max(26).nullable(),
    muted_until: z.iso.datetime({ offset: true }).nullable(),
    note: z.string().max(2000).nullable(),
  })
  .partial();

export const errorTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  /** Extra words for the internal note (the error's summary and link are added). */
  note: z.string().max(4000).optional(),
});
export const attachErrorSchema = z.object({ ticket_number: z.number().int().min(1) });

export const errorAlertSchema = z.object({
  id: z.string(),
  rule_id: z.string(),
  rule_name: z.string(),
  mode: z.enum(['instant', 'digest', 'account']),
  total: z.number().int(),
  events: z.array(
    z.object({
      id: z.string(),
      source: z.enum(ERROR_SOURCES),
      severity: z.enum(ERROR_SEVERITIES),
      code: z.string(),
      message: z.string(),
      count: z.number().int(),
      account_name: z.string().nullable(),
    }),
  ),
  created_at: z.string(),
  read: z.boolean(),
});
export type ErrorAlert = z.infer<typeof errorAlertSchema>;
export const errorAlertListSchema = z.object({ data: z.array(errorAlertSchema), unread: z.number().int() });

export const errorHubConfigSchema = z.object({
  role: z.enum(['owner', 'lead', 'agent']),
  /** Leads and the owner change the settings; agents read them. */
  can_edit_settings: z.boolean(),
  settings: errorHubSettingsSchema,
  agents: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.string() })),
  accounts: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
  /** Errors the writer had to drop since the process started (queue full). */
  dropped: z.number().int(),
});
export type ErrorHubConfig = z.infer<typeof errorHubConfigSchema>;

/** The account's Health page: its own errors, without what only support sees (assignee, notes, tickets). */
export const accountErrorSchema = z.object({
  id: z.string(),
  source: z.enum(ERROR_SOURCES),
  code: z.string(),
  severity: z.enum(ERROR_SEVERITIES),
  message: z.string(),
  links: z.record(z.string(), z.string()),
  count: z.number().int(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  state: z.enum(['open', 'resolved']),
});
export type AccountError = z.infer<typeof accountErrorSchema>;
export const accountHealthSchema = z.object({
  enabled: z.boolean(),
  open: z.number().int(),
  occurrences_24h: z.number().int(),
  data: z.array(accountErrorSchema),
});
export type AccountHealth = z.infer<typeof accountHealthSchema>;
export const accountHealthFilterSchema = z.object({
  state: z.enum(['open', 'resolved', 'all']).optional(),
  source: z.enum(ERROR_SOURCES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** POST /client-errors: what the browser sends (already scrubbed there; scrubbed again here). */
export const clientErrorReportSchema = z.object({
  errors: z
    .array(
      z.object({
        message: z.string().min(1).max(1000),
        source: z.string().max(300).optional(),
        area: z.string().max(40).optional(),
      }),
    )
    .min(1)
    .max(10),
  /** The account the page belongs to (`/a/<slug>/…`); kept only when the person is in it. */
  account_slug: z.string().max(63).optional(),
});
export const clientErrorAnswerSchema = z.object({
  accepted: z.number().int(),
  enabled: z.boolean(),
  sample_rate: z.number(),
});
