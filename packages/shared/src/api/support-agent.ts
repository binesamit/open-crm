// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * The support agent: an AI that investigates an error or a support ticket for the platform's
 * support staff. It reads (the error, the ticket, the code on GitHub at the production build, safe database
 * descriptions, the help articles), writes a report, and proposes actions that wait for a person. A later step —
 * "approve development" — lets a person send it to write the fix on its own branch and open a draft PR.
 */

/** Every branch the agent may create starts with this — enforced in code, never configurable. */
export const SUPPORT_AGENT_BRANCH_PREFIX = 'agent/';

export const SUPPORT_AGENT_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'stopped'] as const;
export type SupportAgentRunStatus = (typeof SUPPORT_AGENT_RUN_STATUSES)[number];

export const SUPPORT_AGENT_ACTION_KINDS = [
  'resolve_error',
  'mute_error',
  'reply_to_customer',
  'open_ops_task',
] as const;
export type SupportAgentActionKind = (typeof SUPPORT_AGENT_ACTION_KINDS)[number];

export const SUPPORT_AGENT_CONFIDENCE = ['low', 'medium', 'high'] as const;

const githubRepo = z
  .string()
  .trim()
  .max(140)
  .regex(/^$|^[\w.-]+\/[\w.-]+$/, 'owner/name');

/**
 * Log providers the agent can read (phase 3): Railway (the environment's logs through its GraphQL API) and
 * Sentry-compatible (Sentry or GlitchTip: issues and their latest event). New providers are new kinds here plus an
 * adapter — never a special case in the tools.
 */
export const SUPPORT_LOG_KINDS = ['railway', 'sentry'] as const;
export type SupportLogKind = (typeof SUPPORT_LOG_KINDS)[number];

const sourceName = z.string().trim().min(1).max(60);
/** A stored log source. The token is sealed (never leaves the server). */
export const logSourceSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(SUPPORT_LOG_KINDS),
  name: sourceName,
  token_enc: z.string().nullable().default(null),
  token_hint: z.string().nullable().default(null),
  /** railway: the environment whose logs are read; optionally one service only. */
  environment_id: z.string().max(80).nullable().default(null),
  service_id: z.string().max(80).nullable().default(null),
  /** sentry: the server (https://sentry.io or a GlitchTip address), the organisation and the project slugs. */
  base_url: z.string().max(300).nullable().default(null),
  org: z.string().max(100).nullable().default(null),
  project: z.string().max(100).nullable().default(null),
});
export type SupportLogSource = z.infer<typeof logSourceSchema>;

/** A log source as the console sees it (no token). */
export const logSourceDtoSchema = logSourceSchema.omit({ token_enc: true }).extend({ has_token: z.boolean() });
export type SupportLogSourceDto = z.infer<typeof logSourceDtoSchema>;

/** Add (no id) or change (id) a log source; `token` null removes it, absent keeps it. */
export const logSourceInputSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  kind: z.enum(SUPPORT_LOG_KINDS),
  name: sourceName,
  token: z.string().trim().min(8).max(500).nullable().optional(),
  environment_id: z.string().trim().max(80).nullable().optional(),
  service_id: z.string().trim().max(80).nullable().optional(),
  base_url: z.string().trim().url().max(300).nullable().optional(),
  org: z.string().trim().max(100).nullable().optional(),
  project: z.string().trim().max(100).nullable().optional(),
});
export type SupportLogSourceInput = z.infer<typeof logSourceInputSchema>;

/**
 * An ops-task type: where an approved "open an ops task" proposal lands — a board (and group) of an
 * account, per kind of issue (code, billing, anything the staff name). The agent picks the type by its name and hint;
 * one type is the default for anything else.
 */
export const opsTaskTypeSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  /** When the agent should choose it (shown to the agent). */
  hint: z.string().trim().max(300).default(''),
  account_id: z.string(),
  board_id: z.string(),
  /** null = the board's first group. */
  group_id: z.string().nullable().default(null),
  is_default: z.boolean().default(false),
});
export type OpsTaskType = z.infer<typeof opsTaskTypeSchema>;

/** An ops-task type as the settings form sends it: no id = a new one. The list is replaced as a whole. */
export const opsTaskTypeInputSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(60),
  hint: z.string().trim().max(300).optional(),
  account_id: z.string().length(26),
  board_id: z.string().length(26),
  group_id: z.string().length(26).nullable().optional(),
  is_default: z.boolean().optional(),
});
export type OpsTaskTypeInput = z.infer<typeof opsTaskTypeInputSchema>;

/** An ops-task type with the names the console shows (missing = its account, board or group is gone). */
export const opsTaskTypeDtoSchema = opsTaskTypeSchema.extend({
  account_name: z.string(),
  board_name: z.string(),
  group_name: z.string().nullable(),
  missing: z.boolean(),
});
export type OpsTaskTypeDto = z.infer<typeof opsTaskTypeDtoSchema>;

/** GET /platform/support-agent/ops-boards?account_id= — the boards (and their groups) an ops-task type may use. */
export const opsBoardsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      workspace: z.string(),
      groups: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});
export type OpsBoards = z.infer<typeof opsBoardsSchema>;

/** Stored settings (platform_settings row `support_agent`). Tokens are sealed and never leave the server. */
export const supportAgentSettingsSchema = z.object({
  /** The kill switch: off = no new run starts, a running one stops at its next step. */
  enabled: z.boolean().default(false),
  /**
   * The AI connection the agent calls (the product owner 2026-10-12: "from the AI connections, not keys again")
   * one of an account's existing connections (Administration → AI), chosen by an admin of that account — calls are
   * priced and logged there like any AI feature. null = the help center's platform AI (Support → Knowledge → AI),
   * as before.
   */
  ai_connection: z.object({ account_id: z.string(), connection_id: z.string() }).nullable().default(null),
  /**
   * the platform's own (internal) accounts — marked here by the owner or a lead. With `only` on, the picker
   * lists just their connections (so a customer account's key is never chosen by mistake); off = every account where
   * the person choosing is an admin, as before.
   */
  internal_accounts: z
    .object({
      only: z.boolean().default(false),
      account_ids: z.array(z.string()).max(200).default([]),
    })
    .default({ only: false, account_ids: [] }),
  /** The model on that connection; null = the connection's default. */
  model: z.string().max(120).nullable().default(null),
  effort: z.enum(['low', 'medium', 'high']).default('medium'),
  max_steps: z.number().int().min(5).max(80).default(30),
  max_usd_per_run: z.number().min(0.05).max(50).default(2),
  max_usd_per_month: z.number().min(1).max(5000).default(50),
  github: z
    .object({
      /** `owner/name` of the one repository the agent reads. */
      repo: githubRepo.default(''),
      read_token_enc: z.string().nullable().default(null),
      read_token_hint: z.string().nullable().default(null),
      /** "Approve development": a separate token with Contents + Pull requests write, this repository only. */
      write_token_enc: z.string().nullable().default(null),
      write_token_hint: z.string().nullable().default(null),
      /** Where pull requests go — never written by the agent (protect it on GitHub too). */
      base_branch: z
        .string()
        .trim()
        .regex(/^[\w./-]{1,100}$/)
        .default('main'),
    })
    .default({
      repo: '',
      read_token_enc: null,
      read_token_hint: null,
      write_token_enc: null,
      write_token_hint: null,
      base_branch: 'main',
    }),
  /** Who may approve development (the owner always may). */
  develop_roles: z.array(z.enum(['owner', 'lead', 'agent'])).default(['owner', 'lead']),
  /** Phase 3: where the agent reads logs — any number of sources, each of a provider kind (none = no log tool). */
  log_sources: z.array(logSourceSchema).max(10).default([]),
  /**
   * Phase 3: read-only SQL — off unless the platform owner turns it on. A read-only transaction, 5 seconds, 200 rows,
   * secret columns refused, an account's values only with access to it (like every other tool).
   */
  sql: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  /**
   * Phase 3: investigate new errors by itself — off by default. Only the severities chosen, at most `max_per_day`,
   * as the person who turned it on (their access decides what it may see).
   */
  auto: z
    .object({
      enabled: z.boolean().default(false),
      severities: z.array(z.enum(['warning', 'error', 'critical'])).default(['critical']),
      max_per_day: z.number().int().min(1).max(200).default(10),
      run_as: z.string().nullable().default(null),
    })
    .default({ enabled: false, severities: ['critical'], max_per_day: 10, run_as: null }),
  /** the ops-task types (none = the agent cannot propose an ops task). */
  ops_tasks: z.array(opsTaskTypeSchema).max(20).default([]),
});
export type SupportAgentSettings = z.infer<typeof supportAgentSettingsSchema>;

/** An AI connection the agent may use: one in an account where the person choosing is an admin. */
export const supportAgentConnectionSchema = z.object({
  account_id: z.string(),
  account_name: z.string(),
  connection_id: z.string(),
  name: z.string(),
  provider: z.string(),
  /** Whether its account is marked internal (see `internal_accounts`). */
  internal: z.boolean(),
});
export type SupportAgentConnection = z.infer<typeof supportAgentConnectionSchema>;

export const supportAgentConnectionsSchema = z.object({
  data: z.array(supportAgentConnectionSchema),
  /** Whether the help center's platform AI is set (the fallback when no connection is chosen). */
  help_center: z.boolean(),
  /** The accounts where this person is an admin — the ones they may mark internal. */
  accounts: z.array(z.object({ id: z.string(), name: z.string(), internal: z.boolean() })),
});
export type SupportAgentConnections = z.infer<typeof supportAgentConnectionsSchema>;

export const supportAgentSettingsDtoSchema = supportAgentSettingsSchema
  .omit({ github: true, ai_connection: true, log_sources: true, ops_tasks: true })
  .extend({
    log_sources: z.array(logSourceDtoSchema),
    ops_tasks: z.array(opsTaskTypeDtoSchema),
    /** Whether this person may turn read-only SQL on or off (the platform owner only). */
    may_sql: z.boolean(),
    /** The chosen connection, with its names (null = the help center's platform AI). Missing = it was deleted. */
    ai_connection: supportAgentConnectionSchema.omit({ internal: true }).extend({ missing: z.boolean() }).nullable(),
    github: z.object({
      repo: z.string(),
      has_read_token: z.boolean(),
      read_token_hint: z.string().nullable(),
      has_write_token: z.boolean(),
      write_token_hint: z.string().nullable(),
      base_branch: z.string(),
    }),
    /** Whether this person may approve development (their role is in `develop_roles` and a write token is set). */
    may_develop: z.boolean(),
    /** Whether the agent has an AI to call: the chosen connection, else the help center's platform AI. */
    ai_ready: z.boolean(),
    /** Whether this person may change the settings (the owner and support leads). */
    can_edit: z.boolean(),
    /** What this month's runs cost so far (USD). */
    month_usd: z.number(),
  });
export type SupportAgentSettingsDto = z.infer<typeof supportAgentSettingsDtoSchema>;

export const updateSupportAgentSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** An existing AI connection (the person must be an admin of its account); null = the help center's AI. */
    ai_connection: z.object({ account_id: z.string().length(26), connection_id: z.string().length(26) }).nullable(),
    /** The internal-accounts marker: `only` on / off and the marked accounts (replaced as a whole). */
    internal_accounts: z.object({
      only: z.boolean(),
      account_ids: z.array(z.string().length(26)).max(200),
    }),
    model: z.string().trim().max(120).nullable(),
    effort: z.enum(['low', 'medium', 'high']),
    max_steps: z.number().int().min(5).max(80),
    max_usd_per_run: z.number().min(0.05).max(50),
    max_usd_per_month: z.number().min(1).max(5000),
    github_repo: githubRepo,
    /** A new read-only token; null removes it; absent keeps it. */
    github_read_token: z.string().trim().min(10).max(400).nullable(),
    /** A new write token (development); null removes it; absent keeps it. */
    github_write_token: z.string().trim().min(10).max(400).nullable(),
    github_base_branch: z
      .string()
      .trim()
      .regex(/^[\w./-]{1,100}$/),
    develop_roles: z.array(z.enum(['owner', 'lead', 'agent'])).max(3),
    /** Add or change one log source. */
    log_source: logSourceInputSchema,
    /** Remove one log source by id. */
    remove_log_source: z.string().min(1).max(40),
    /** Read-only SQL on / off (the platform owner only). */
    sql_enabled: z.boolean(),
    /** Investigate new errors by itself; turning it on runs as the person who did. */
    auto: z.object({
      enabled: z.boolean(),
      severities: z
        .array(z.enum(['warning', 'error', 'critical']))
        .min(1)
        .max(3),
      max_per_day: z.number().int().min(1).max(200),
    }),
    /** The ops-task types, replaced as a whole (each in an account where this person is an admin). */
    ops_tasks: z.array(opsTaskTypeInputSchema).max(20),
  })
  .partial();
export type UpdateSupportAgentSettings = z.infer<typeof updateSupportAgentSettingsSchema>;

export const supportAgentReportSchema = z.object({
  /** Two or three sentences: what happened. */
  summary: z.string().trim().min(1).max(2000),
  root_cause: z.string().trim().min(1).max(4000),
  evidence: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().max(2000).default(''),
        /** `path/to/file.ts:120`, an error / record id, or a URL. */
        ref: z.string().trim().max(300).optional(),
      }),
    )
    .max(20)
    .default([]),
  impact: z.string().trim().max(2000).default(''),
  proposed_fix: z.string().trim().max(4000).default(''),
  confidence: z.enum(SUPPORT_AGENT_CONFIDENCE),
});
export type SupportAgentReport = z.infer<typeof supportAgentReportSchema>;

export const startSupportAgentRunSchema = z
  .object({
    error_id: z.string().length(26).optional(),
    ticket_id: z.string().length(26).optional(),
    /** What to look at, on top of the error / ticket (optional). */
    prompt: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.error_id || v.ticket_id, { message: 'error_or_ticket' });
export type StartSupportAgentRun = z.infer<typeof startSupportAgentRunSchema>;

export const supportAgentStepSchema = z.object({
  seq: z.number(),
  /** `investigate`, or `develop` (the steps after a person approved development). */
  phase: z.enum(['investigate', 'develop']),
  kind: z.enum(['prompt', 'model', 'tool']),
  tool: z.string().nullable(),
  /** The tool's input (what it was asked to read) — never a token. */
  input: z.unknown().nullable(),
  is_error: z.boolean(),
  /** The model's text in this turn (its reasoning out loud), when any. */
  text: z.string().nullable(),
  created_at: z.string(),
});

export const supportAgentActionSchema = z.object({
  id: z.string(),
  kind: z.enum(SUPPORT_AGENT_ACTION_KINDS),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'approved', 'rejected']),
  decided_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
});
export type SupportAgentAction = z.infer<typeof supportAgentActionSchema>;

export const supportAgentRunSchema = z.object({
  id: z.string(),
  status: z.enum(SUPPORT_AGENT_RUN_STATUSES),
  trigger: z.string(),
  error_id: z.string().nullable(),
  ticket_id: z.string().nullable(),
  account_id: z.string().nullable(),
  prompt: z.string(),
  model: z.string().nullable(),
  report: supportAgentReportSchema.nullable(),
  final_text: z.string().nullable(),
  error: z.string().nullable(),
  steps: z.number(),
  tool_calls: z.number(),
  cost_usd: z.number(),
  code_ref: z.string().nullable(),
  requested_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  /** The development step: null (not asked) → approved → running → opened (a draft PR) | failed. */
  dev_status: z.enum(['approved', 'running', 'opened', 'failed']).nullable(),
  dev_approved_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  dev_branch: z.string().nullable(),
  dev_pr_url: z.string().nullable(),
  dev_error: z.string().nullable(),
});
export type SupportAgentRun = z.infer<typeof supportAgentRunSchema>;

export const approveDevelopmentSchema = z.object({
  /** What to do / not do, on top of the report's proposed fix (optional). */
  instructions: z.string().trim().max(4000).optional(),
});
export type ApproveDevelopment = z.infer<typeof approveDevelopmentSchema>;

export const supportAgentRunDetailSchema = supportAgentRunSchema.extend({
  step_list: z.array(supportAgentStepSchema),
  actions: z.array(supportAgentActionSchema),
});
export type SupportAgentRunDetail = z.infer<typeof supportAgentRunDetailSchema>;

export const decideSupportAgentActionSchema = z.object({
  approve: z.boolean(),
  /** A reply to the customer as the person edited it (`reply_to_customer`), or the task's description (`open_ops_task`). */
  body: z.string().trim().min(1).max(20000).optional(),
  /** `open_ops_task`: the task's name and type as the person changed them. */
  title: z.string().trim().min(1).max(200).optional(),
  ops_type: z.string().min(1).max(40).optional(),
});
export type DecideSupportAgentAction = z.infer<typeof decideSupportAgentActionSchema>;
