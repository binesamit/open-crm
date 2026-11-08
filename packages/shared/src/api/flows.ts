// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { flowDraftSchema } from '../flows/draft';

/**
 * "זרימות" — external automation platforms: an account's admins connect their n8n / Make / Zapier
 * account once (Administration → זרימות), then see every flow there, whether it runs, when it ran and where it
 * failed; switch flows on and off, run a failed run again, get an alert on a new failure, and let the AI draft a new
 * flow (created switched off, after a person approved it).
 *
 * One adapter per platform behind the same interface; what each platform's API lets us do is `FLOW_PLATFORM_CAPS`
 * (the UI and the AI tools read it — no platform name is checked anywhere else). Which platforms an account may
 * connect at all is the platform owner's setting (`platform_settings.flows.platforms`).
 */
export const FLOW_PLATFORMS = ['n8n', 'make', 'zapier'] as const;
export type FlowPlatform = (typeof FLOW_PLATFORMS)[number];

export type FlowPlatformCaps = {
  /** Switch a flow on / off. */
  toggle: boolean;
  /** Run a failed run again. */
  retry: boolean;
  /** Create a flow from a draft (always switched off) — the AI builder. */
  create: boolean;
  /**
   * Edit an existing flow with the AI: read its definition and save a change in the draft's safe
   * vocabulary. n8n only — a Make blueprint needs the "Bines OS" Make app first.
   */
  edit: boolean;
};

/**
 * - n8n: the public REST API (`/api/v1/workflows`, `/executions`, activate / deactivate, retry) — everything.
 * - Make: API v2 (`/scenarios`, `/start` / `/stop`, logs, replay) — no drafts yet: a Make blueprint needs the
 *   "Bines OS" Make app (the other half of the bridge), so the builder comes after it.
 * - Zapier: monitoring only — creating or switching Zaps needs Zapier's partner approval (plan, question 4).
 */
export const FLOW_PLATFORM_CAPS: Record<FlowPlatform, FlowPlatformCaps> = {
  n8n: { toggle: true, retry: true, create: true, edit: true },
  make: { toggle: true, retry: true, create: false, edit: false },
  zapier: { toggle: false, retry: false, create: false, edit: false },
};

export const FLOW_ALERT_CHANNELS = ['bell', 'bell_email', 'email'] as const;
export const FLOW_VISIBILITY = ['admins', 'members'] as const;

/** Everything an admin decides per connection — each with a default, nothing fixed in code. */
export const flowConnectionSettingsSchema = z.object({
  /** Who sees this connection's flows (read only): admins, or every member too (never viewers / guests). */
  visibility: z.enum(FLOW_VISIBILITY).default('admins'),
  /** May the AI (assistant, agents, AI apps over MCP) draft new flows here? Each draft waits for a person. */
  ai_create: z.boolean().default(true),
  /**
   * May the AI switch flows on / off and run a failed run again ? Each call waits for a person's
   * approval.
   */
  ai_operate: z.boolean().default(true),
  /** May the AI edit existing flows (saved switched off unless the person says otherwise)? Each edit waits too. */
  ai_edit: z.boolean().default(true),
  /** The AI connection + model the "new flow with AI" dialog uses (null = the assistant's, AI settings). */
  ai_connection_id: z.string().max(26).nullable().default(null),
  ai_model: z.string().max(80).nullable().default(null),
  /** A new failed run → an alert. */
  alert_on_failure: z.boolean().default(true),
  /** Who hears it (user ids; empty = every admin of the account). */
  alert_recipients: z.array(z.string().max(26)).max(50).default([]),
  /** Where: the bell, the bell + email, or email only (email follows each person's notification settings). */
  alert_channel: z.enum(FLOW_ALERT_CHANNELS).default('bell'),
  /** How often the platform is checked for new failures. */
  check_every_minutes: z.number().int().min(5).max(1440).default(15),
  /** Calls to the platform per hour (screens, AI tools and checks together) — a runaway loop stops here. */
  max_calls_per_hour: z.number().int().min(10).max(10_000).default(600),
  /**
   * Our share of the platform account's per-minute limit (Make limits API calls per
   * organization per minute, by plan, and every system connected to that account draws from the same limit). One budget
   * shared by every path here — the screens, the runs drawer, the failure check, flow automations, the AI tools. After a
   * "too many requests" the connection slows itself below it and comes back gradually (flows.limits.ts).
   */
  max_calls_per_minute: z.number().int().min(1).max(1000).default(30),
  /** The share (%) of that budget the background work (the failure check, loading the list's stats) may use. */
  background_share_percent: z.number().int().min(10).max(100).default(75),
  /** How long the flows list is kept before the platform is asked again (seconds; 0 = always ask). */
  cache_list_seconds: z.number().int().min(0).max(3600).default(120),
  /** How long one flow's stats (last run, failures of the week) are kept (seconds). */
  cache_stats_seconds: z.number().int().min(0).max(86_400).default(300),
  /** How long a flow's run history is kept (seconds). */
  cache_runs_seconds: z.number().int().min(0).max(3600).default(60),
  /** "Refresh" asks the platform again at most once per this many seconds (sooner → the kept answer). */
  refresh_min_seconds: z.number().int().min(0).max(3600).default(30),
  /** The list's per-flow stats load in the background: how many at a time … */
  stats_concurrency: z.number().int().min(1).max(4).default(1),
  /** … and at least this long between two background calls (ms). */
  stats_pacing_ms: z.number().int().min(0).max(10_000).default(400),
  /** The platform said "too many requests" without saying until when: wait this long before calling it again. */
  backoff_default_seconds: z.number().int().min(5).max(3600).default(60),
});
export type FlowConnectionSettings = z.infer<typeof flowConnectionSettingsSchema>;

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }, 'url_invalid');

/** A Make zone: `eu1`, `us2`, `eu1.make.celonis` … — the host is `<zone>.make.com`. */
export const makeZoneSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{2,12}(\.[a-z0-9-]{2,30}){0,2}$/, 'flow_make_zone_invalid');

const secret = z.string().trim().min(8).max(4000);

/** The platform part of a new connection: where it lives + its secret (sealed at rest, never sent back). */
export const flowConnectionTargetSchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('n8n'), base_url: httpsUrl, api_key: secret }),
  z.object({
    platform: z.literal('make'),
    zone: makeZoneSchema,
    team_id: z.number().int().positive(),
    api_token: secret,
  }),
  /** An OAuth access token of Zapier's Workflow API (scopes `zap:all` + `zap:runs`). */
  z.object({ platform: z.literal('zapier'), access_token: secret }),
]);
export type FlowConnectionTarget = z.infer<typeof flowConnectionTargetSchema>;

export const createFlowConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    target: flowConnectionTargetSchema,
    settings: flowConnectionSettingsSchema.partial().default({}),
  })
  .meta({ id: 'CreateFlowConnection' });

export const updateFlowConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** Omitted = keep where it lives and its secret. Sent = the whole target again (the secret too). */
    target: flowConnectionTargetSchema.optional(),
    settings: flowConnectionSettingsSchema.partial().optional(),
    enabled: z.boolean().optional(),
  })
  .meta({ id: 'UpdateFlowConnection' });

/**
 * Why we are not calling the platform right now: it answered "too many requests" (`platform` — no call goes out until
 * `until`, on any path), or the connection's own per-minute budget is used up (`budget`). `reason` = the platform's text.
 * `slowed_to`: after the platform's "too many requests" the connection calls at most this many times a minute for now
 * (below the setting — the account's limit is shared with whatever else uses it), coming back gradually.
 */
export const flowLimitSchema = z
  .object({
    until: z.string(),
    by: z.enum(['platform', 'budget']),
    reason: z.string().nullable(),
    slowed_to: z.number().int().nullable().optional(),
  })
  .meta({ id: 'FlowLimit' });
export type FlowLimit = z.infer<typeof flowLimitSchema>;

export const flowConnectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    platform: z.enum(FLOW_PLATFORMS),
    /** n8n: the instance URL; Make: `https://<zone>.make.com`; Zapier: its API. */
    base_url: z.string(),
    zone: z.string().nullable(),
    team_id: z.number().nullable(),
    /** `…abcd` of the saved key — never the key. Null for people who only view. */
    secret_hint: z.string().nullable(),
    enabled: z.boolean(),
    status: z.enum(['unknown', 'ok', 'error']),
    last_error: z.string().nullable(),
    /**
     * Connected, but a part does not work (e.g. the run history: the platform refused the logs call) — the platform's
     * reason. Null when all is well.
     */
    warning: z.string().nullable(),
    checked_at: z.string().nullable(),
    caps: z.object({ toggle: z.boolean(), retry: z.boolean(), create: z.boolean(), edit: z.boolean() }),
    /** Null for people who only view (members, when the connection is open to them). */
    settings: flowConnectionSettingsSchema.nullable(),
    /** May the caller change things here (admins)? */
    can_manage: z.boolean(),
    /** Not calling the platform right now (its "too many requests", or this connection's per-minute budget). */
    limited: flowLimitSchema.nullable(),
    created_at: z.string(),
  })
  .meta({ id: 'FlowConnection' });
export type FlowConnection = z.infer<typeof flowConnectionSchema>;

export const FLOW_RUN_STATUSES = [
  'success',
  'error',
  'warning',
  'running',
  'waiting',
  'canceled',
  'skipped',
  'other',
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export const flowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    active: z.boolean(),
    /** active / inactive, or error when the last run failed (or the platform marks the flow invalid). */
    status: z.enum(['active', 'inactive', 'error']),
    updated_at: z.string().nullable(),
    last_run_at: z.string().nullable(),
    last_run_status: z.enum(FLOW_RUN_STATUSES).nullable(),
    /** Failed runs in the last 7 days (null when the platform cannot tell cheaply). */
    errors_7d: z.number().nullable(),
    /**
     * Set when this flow's run stats could not be read (the list itself still works): a code (`flow_stats_unavailable`)
     * and the platform's reason. Last run and failures are then null.
     */
    warning: z.string().nullable().optional(),
    warning_detail: z.string().nullable().optional(),
    /** Opens the flow in the platform's own editor. */
    open_url: z.string().nullable(),
    tags: z.array(z.string()),
    /**
     * Its stats are not here yet (platforms that load them per flow — Make): ask `POST …/flows/stats` for the flows on
     * screen. Absent / false = the stats fields are what the platform said.
     */
    stats_pending: z.boolean().optional(),
    /**
     * When its stats were read (platforms that load them per flow). Kept stats are shown whatever their age — the failure
     * check refreshes them in the background and "refresh" asks again — so opening the screen does not ask the platform
     * once per flow.
     */
    stats_at: z.string().nullable().optional(),
  })
  .meta({ id: 'Flow' });
export type Flow = z.infer<typeof flowSchema>;

/** One flow's stats, loaded on their own (`POST /flow-connections/{id}/flows/stats`). */
export const flowStatsSchema = flowSchema
  .pick({ last_run_at: true, last_run_status: true, errors_7d: true, warning: true, warning_detail: true })
  .extend({ status: z.enum(['active', 'inactive', 'error']).optional() })
  .meta({ id: 'FlowStats' });
export type FlowStats = z.infer<typeof flowStatsSchema>;

export const flowStatsRequestSchema = z.object({
  flow_ids: z.array(z.string().max(64)).min(1).max(25),
  refresh: z.boolean().default(false),
});

export const flowStatsAnswerSchema = z
  .object({
    data: z.record(z.string(), flowStatsSchema),
    /** Asked for, not loaded now (the budget or the platform's limit): ask again after `limited.until`. */
    pending: z.array(z.string()),
    limited: flowLimitSchema.nullable(),
  })
  .meta({ id: 'FlowStatsAnswer' });

export const flowListAnswerSchema = z
  .object({
    data: z.array(flowSchema),
    /** When the platform was last asked for this list (it is kept a while — `cache_list_seconds`). */
    fetched_at: z.string().nullable(),
    limited: flowLimitSchema.nullable(),
  })
  .meta({ id: 'FlowList' });

/** `?refresh=1` asks the platform again now (at most once per `refresh_min_seconds`). */
export const flowRefreshQuerySchema = z.object({
  refresh: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export const flowRunSchema = z
  .object({
    id: z.string(),
    flow_id: z.string().nullable(),
    flow_name: z.string().nullable(),
    status: z.enum(FLOW_RUN_STATUSES),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    duration_ms: z.number().nullable(),
    /** The platform's error message (its text — shown as text, never as HTML). */
    error: z.string().nullable(),
    /** Where it failed (the node / module), when the platform says. */
    error_node: z.string().nullable(),
    mode: z.string().nullable(),
    can_retry: z.boolean(),
    open_url: z.string().nullable(),
  })
  .meta({ id: 'FlowRun' });
export type FlowRun = z.infer<typeof flowRunSchema>;

export const flowRunsQuerySchema = z.object({
  flow_id: z.string().max(64).optional(),
  status: z.enum(['error', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  refresh: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export const setFlowActiveSchema = z.object({ active: z.boolean() });

/** POST /flow-connections/{id}/drafts — the AI turns a request in words into a draft (nothing is created yet). */
export const aiFlowDraftRequestSchema = z.object({ request: z.string().trim().min(3).max(4000) });

export const flowDraftAnswerSchema = z
  .object({
    draft: flowDraftSchema,
    /** One line per node for the person (i18n key + values). */
    lines: z.array(z.object({ key: z.string(), vars: z.record(z.string(), z.union([z.string(), z.number()])) })),
    /** The model's notes to the person (what to connect in the platform before switching it on). */
    notes: z.string().nullable(),
  })
  .meta({ id: 'FlowDraftAnswer' });
export type FlowDraftAnswer = z.infer<typeof flowDraftAnswerSchema>;

/** POST /flow-connections/{id}/flows — the person approved the draft: create it, switched off. */
export const createFlowFromDraftSchema = z.object({ draft: flowDraftSchema });

/**
 * Where a flow opens in our flows screen: the bell's flow notifications, `{flow.url}` in automations
 * and the assistant link here. `/a/<slug>/flows?connection=…&flow=…&run=…` — the screen opens that flow's runs.
 */
export const flowPagePath = (
  slug: string,
  f: { connection_id: string; flow_id?: string | null; run_id?: string | null },
) => {
  const q = new URLSearchParams({ connection: f.connection_id });
  if (f.flow_id) q.set('flow', f.flow_id);
  if (f.run_id) q.set('run', f.run_id);
  return `/a/${encodeURIComponent(slug)}/flows?${q}`;
};

/** A flow notification's link data (the bell opens `flowPagePath`). */
export const flowLinkSchema = z.object({
  connection_id: z.string(),
  flow_id: z.string().nullable(),
  run_id: z.string().nullable(),
});
export type FlowLink = z.infer<typeof flowLinkSchema>;
