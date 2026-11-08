// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { actionDescriptionSchema } from '../ai/describe';
import { patchOf } from '../account/settings';
import { AI_TOOLS, type AiToolDef } from '../ai/tools';
import { isAgentAvatarValue } from '../avatars';
import { agentWebSearchSchema } from './web-search';

/**
 * Agents (the planning notes "AGENTS-MCP" מ6–מ7, D26): every agent is built in the UI — profile, AI connection + model,
 * allowed tools, boards, approval policy and limits. Nothing about a particular agent lives in code; starter
 * templates are editable data (`seed/agents/*.json`), loaded into an account only when an admin asks.
 */

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** learner = every write waits for a person; autonomous = only sensitive tools (and the ones listed) wait. */
export const AGENT_APPROVAL_MODES = ['learner', 'autonomous'] as const;
export type AgentApprovalMode = (typeof AGENT_APPROVAL_MODES)[number];

/** What the agent may do on a board: read it, or read and change its items. */
export const AGENT_BOARD_LEVELS = ['view', 'edit'] as const;
export type AgentBoardLevel = (typeof AGENT_BOARD_LEVELS)[number];

export const AGENT_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** How a run started: "run now", an automation's `run_agent` (a scheduled one = `schedule`), a mention, an assignment. */
/** `chat`: one message in the AI panel's chat with the agent. */
export const AGENT_RUN_TRIGGERS = ['manual', 'automation', 'mention', 'assign', 'schedule', 'chat'] as const;
export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];

/** Hard caps a person cannot raise past (plan §5 step 7). */
export const AGENT_LIMIT_MAX = { steps: 50, usd: 50, runsPerDay: 1000 } as const;

export const agentLimitsSchema = z.object({
  /** Model calls per run. */
  max_steps: z.number().int().min(1).max(AGENT_LIMIT_MAX.steps).default(25),
  /** USD per run (real cost from each call's usage). */
  max_usd_per_run: z.number().min(0.01).max(AGENT_LIMIT_MAX.usd).default(1),
  /** Runs a day (UTC day) — dry runs not counted. */
  max_runs_per_day: z.number().int().min(1).max(AGENT_LIMIT_MAX.runsPerDay).default(50),
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

/**
 * When the agent acts on its own (מ8, "מתי הסוכן פועל"): a mention of it in an update starts a run (`mention`, the
 * update is the request — as data), assigning it in a people column starts a run (`assign`, optionally only in the
 * listed column keys). `board_ids` narrows both to some of its boards (empty = all its boards). Guests never
 * trigger it unless `allow_guests` — and then every write of that run waits for a person. Automations start it
 * with the `run_agent` action (schedules too). `chat`: people may pick it in the AI panel and chat
 * with it — on by default; every change it proposes there waits for the person's approval.
 */
export const AGENT_TRIGGER_DEFAULTS = {
  mention: false,
  chat: true,
  assign: false,
  assign_columns: [] as string[],
  board_ids: [] as string[],
  allow_guests: false,
  mention_prompt: '',
  assign_prompt: '',
};
export const agentTriggersSchema = z
  .object({
    mention: z.boolean().default(false),
    chat: z.boolean().default(true),
    assign: z.boolean().default(false),
    assign_columns: z.array(z.string().max(64)).max(20).default([]),
    board_ids: z.array(z.string().min(1).max(26)).max(50).default([]),
    allow_guests: z.boolean().default(false),
    /** The task given on a mention (empty = the built-in one: read the update and answer it). */
    mention_prompt: z.string().max(4000).default(''),
    /** The task given on an assignment (empty = the built-in one: do your job on the item). */
    assign_prompt: z.string().max(4000).default(''),
  })
  .default(AGENT_TRIGGER_DEFAULTS);
export type AgentTriggers = z.infer<typeof agentTriggersSchema>;
/**
 * A new agent (product decision): it answers when mentioned unless the account's AI settings say otherwise
 * (`settings.ai.agent_mention_default`, on by default). Existing agents keep what they have.
 */
export const newAgentTriggerDefaults = (mention = true): AgentTriggers => ({ ...AGENT_TRIGGER_DEFAULTS, mention });

export const agentBoardSchema = z.object({
  board_id: z.string().min(1).max(26),
  level: z.enum(AGENT_BOARD_LEVELS).default('view'),
});

/** The tools an agent may be given: the registry minus what only makes sense for a person. */
export const AGENT_TOOL_NAMES = AI_TOOLS.filter((x) => x.name !== 'whoami').map((x) => x.name);

/** A tool always waits for a person in every mode (deleting, sending outside, calling outside). */
export const isSensitiveTool = (tool: Pick<AiToolDef, 'risk' | 'annotations'>) =>
  tool.risk === 'sensitive' || tool.annotations.openWorldHint;

/**
 * Does this call wait for a person? learner: every non-read tool; autonomous: sensitive tools and the write tools
 * the agent's editor marked "with approval". Read tools never wait.
 */
export const needsApproval = (
  tool: Pick<AiToolDef, 'name' | 'risk' | 'annotations'>,
  agent: { approval_mode: AgentApprovalMode; approval_tools: string[] },
) => {
  if (tool.risk === 'read') return false;
  if (isSensitiveTool(tool)) return true;
  return agent.approval_mode === 'learner' || agent.approval_tools.includes(tool.name);
};

const agentFields = {
  name: z.string().trim().min(1).max(80),
  /**
   * The agent's avatar: one of our animals (`animal:<id>:<background>`), "animal:auto" (its own AI
   * picks one when it is created), or one emoji / a couple of letters.
   */
  avatar: z.string().trim().max(16).refine(isAgentAvatarValue, { message: 'invalid_avatar' }).nullable().default(null),
  /** One line: what the agent is for. */
  role: z.string().trim().max(200).default(''),
  /** The SOP — what to do, how, what never to do. */
  instructions: z.string().max(20_000).default(''),
  connection_id: z.string().min(1).max(26),
  model: z.string().min(1).max(80),
  effort: z.enum(AGENT_EFFORTS).default('medium'),
  tools: z.array(z.string().max(64)).max(64).default([]),
  /** Write tools that wait for approval even in autonomous mode. */
  approval_tools: z.array(z.string().max(64)).max(64).default([]),
  boards: z.array(agentBoardSchema).max(50).default([]),
  approval_mode: z.enum(AGENT_APPROVAL_MODES).default('learner'),
  limits: agentLimitsSchema.default({ max_steps: 25, max_usd_per_run: 1, max_runs_per_day: 50 }),
  triggers: agentTriggersSchema,
  is_active: z.boolean().default(true),
  /**
   * "web search" — on by an admin = approved at once; by anyone else = asked, waiting for an admin.
   * Off revokes it. Takes effect only when the platform allows it and the account has a search service key.
   */
  web_search: z.boolean().default(false),
};

/**
 * A new agent's triggers: `mention` left out = the account's default (`settings.ai.agent_mention_default`, on unless
 * an admin turned it off); everything else as in `agentTriggersSchema`.
 */
const newAgentTriggersSchema = agentTriggersSchema.unwrap().extend({ mention: z.boolean().optional() }).optional();

export const createAgentSchema = z
  .object({ ...agentFields, triggers: newAgentTriggersSchema })
  .meta({ id: 'CreateAgent' });
export type CreateAgent = z.input<typeof createAgentSchema>;

export const updateAgentSchema = patchOf(z.object(agentFields)).meta({ id: 'UpdateAgent' });
export type UpdateAgent = z.infer<typeof updateAgentSchema>;

/**
 * "Improve with AI" in the agent editor: the editor's current, unsaved state — the model rewrites the
 * instructions from it and nothing is stored; the person accepts (or edits) the rewrite and saves as usual.
 * `agent_id` = an existing agent (its manager only); none = a new one (whoever may create agents).
 */
export const improveAgentInstructionsSchema = z
  .object({
    agent_id: z.string().min(1).max(26).optional(),
    connection_id: agentFields.connection_id,
    model: z.string().min(1).max(80).optional(),
    name: z.string().trim().max(80).default(''),
    role: agentFields.role,
    instructions: agentFields.instructions,
    tools: agentFields.tools,
    boards: agentFields.boards,
    /** What the person wants changed ("shorter", "more polite to customers" …); empty = make it clearer and fuller. */
    request: z.string().trim().max(1000).default(''),
  })
  .meta({ id: 'ImproveAgentInstructions' });
export type ImproveAgentInstructions = z.input<typeof improveAgentInstructionsSchema>;

export const improvedAgentInstructionsSchema = z
  .object({ instructions: z.string() })
  .meta({ id: 'ImprovedAgentInstructions' });
export type ImprovedAgentInstructions = z.infer<typeof improvedAgentInstructionsSchema>;

export const agentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    avatar: z.string().nullable(),
    role: z.string(),
    instructions: z.string(),
    connection_id: z.string().nullable(),
    connection_name: z.string().nullable(),
    model: z.string(),
    effort: z.enum(AGENT_EFFORTS),
    tools: z.array(z.string()),
    approval_tools: z.array(z.string()),
    boards: z.array(z.object({ board_id: z.string(), level: z.enum(AGENT_BOARD_LEVELS), name: z.string().nullable() })),
    approval_mode: z.enum(AGENT_APPROVAL_MODES),
    limits: agentLimitsSchema,
    triggers: z.object({
      mention: z.boolean(),
      chat: z.boolean(),
      assign: z.boolean(),
      assign_columns: z.array(z.string()),
      board_ids: z.array(z.string()),
      allow_guests: z.boolean(),
      mention_prompt: z.string(),
      assign_prompt: z.string(),
    }),
    /** Knowledge sources (מ9) and how many are indexed. */
    knowledge: z.object({ sources: z.number().int(), ready: z.number().int() }),
    /** Web search: off / asked / approved, and by whom. */
    web_search: agentWebSearchSchema,
    is_active: z.boolean(),
    /** The agent's own service identity: what the activity log shows. */
    user_id: z.string(),
    template_key: z.string().nullable(),
    created_by: z.string().nullable(),
    created_by_name: z.string().nullable(),
    revision: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    stats: z.object({
      runs_7d: z.number().int(),
      cost_month_usd: z.number(),
      pending_approvals: z.number().int(),
      last_run_at: z.string().nullable(),
    }),
  })
  .meta({ id: 'Agent' });
export type Agent = z.infer<typeof agentSchema>;

export const startAgentRunSchema = z
  .object({
    /** What the agent should do now (the "run now" box). */
    prompt: z.string().trim().min(1).max(8000),
    /** An item the run is about (its name and id are given to the agent). */
    item_id: z.string().max(26).nullable().optional(),
    /** Simulation: read tools run, write tools answer "would do …" and change nothing; not counted in the day quota. */
    dry_run: z.boolean().default(false),
  })
  .meta({ id: 'StartAgentRun' });
export type StartAgentRun = z.input<typeof startAgentRunSchema>;

export const agentRunSchema = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    agent_name: z.string().nullable(),
    trigger: z.string(),
    prompt: z.string().nullable(),
    item_id: z.string().nullable(),
    dry_run: z.boolean(),
    status: z.enum(AGENT_RUN_STATUSES),
    skip_reason: z.string().nullable(),
    error: z.string().nullable(),
    final_text: z.string().nullable(),
    model: z.string().nullable(),
    steps: z.number().int(),
    tool_calls: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cache_read_tokens: z.number().int(),
    cost_usd: z.number(),
    requested_by: z.string().nullable(),
    requested_by_name: z.string().nullable(),
    created_at: z.string(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    undone_at: z.string().nullable(),
    /** Writes the run made that can still be undone together. */
    changes: z.number().int(),
  })
  .meta({ id: 'AgentRun' });
export type AgentRun = z.infer<typeof agentRunSchema>;

export const agentRunStepSchema = z
  .object({
    seq: z.number().int(),
    /** prompt = what the run was given; model = one model answer; tool = one tool call and its result. */
    kind: z.enum(['prompt', 'model', 'tool']),
    text: z.string().nullable(),
    tool: z.string().nullable(),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    is_error: z.boolean(),
    /** For a tool step: ran / dry_run / rejected / expired / blocked / waiting. */
    outcome: z.string().nullable(),
    /** A tool step in words, with names resolved for the reader (sync-ai); null for other steps. */
    description: actionDescriptionSchema.nullable().optional(),
    cost_usd: z.number(),
    created_at: z.string(),
  })
  .meta({ id: 'AgentRunStep' });
export type AgentRunStep = z.infer<typeof agentRunStepSchema>;

export const agentApprovalSchema = z
  .object({
    id: z.string(),
    agent_id: z.string(),
    agent_name: z.string().nullable(),
    run_id: z.string(),
    tool: z.string(),
    input: z.unknown(),
    preview: z.string(),
    /** What the agent wants to do, in words, with names resolved for the reader (sync-ai). */
    description: actionDescriptionSchema.nullable().optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'expired']),
    reason: z.string().nullable(),
    decided_by_name: z.string().nullable(),
    decided_at: z.string().nullable(),
    expires_at: z.string(),
    created_at: z.string(),
  })
  .meta({ id: 'AgentApproval' });
export type AgentApproval = z.infer<typeof agentApprovalSchema>;

export const agentRunDetailSchema = z
  .object({
    run: agentRunSchema,
    steps: z.array(agentRunStepSchema),
    approvals: z.array(agentApprovalSchema),
  })
  .meta({ id: 'AgentRunDetail' });
export type AgentRunDetail = z.infer<typeof agentRunDetailSchema>;

export const decideApprovalSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'DecideAgentApproval' });
export type DecideApproval = z.infer<typeof decideApprovalSchema>;

/** A starter template (`seed/agents/<key>.json`): editable data, never a code path. */
export const agentTemplateSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    name: z.string().min(1).max(80),
    avatar: z.string().max(16).refine(isAgentAvatarValue).nullable().default(null),
    role: z.string().max(200).default(''),
    instructions: z.string().max(20_000).default(''),
    effort: z.enum(AGENT_EFFORTS).default('medium'),
    tools: z.array(z.string().max(64)).max(64).default([]),
    approval_mode: z.enum(AGENT_APPROVAL_MODES).default('learner'),
    limits: agentLimitsSchema.partial().default({}),
  })
  .meta({ id: 'AgentTemplate' });
export type AgentTemplate = z.infer<typeof agentTemplateSchema>;

/** Days an approval waits before it expires (the run then continues as if it was rejected). */
export const AGENT_APPROVAL_TTL_HOURS = 72;

// ---- the directory: agents as "digital workers" in mention lists and people pickers (מ8) ----

export const agentDirectoryEntrySchema = z
  .object({
    id: z.string(),
    /** The agent's service user: the id a mention / a people cell stores. */
    user_id: z.string(),
    name: z.string(),
    avatar: z.string().nullable(),
    role: z.string(),
    /** Mentioning it in an update starts a run. */
    mention: z.boolean(),
    /** Assigning it in a people column starts a run. */
    assign: z.boolean(),
    /** Boards (of the ones I can see) where it acts; it is offered only there. */
    board_ids: z.array(z.string()),
  })
  .meta({ id: 'AgentDirectoryEntry' });
export type AgentDirectoryEntry = z.infer<typeof agentDirectoryEntrySchema>;

/**
 * Why an agent the reader could mention does not act now — the mention list shows it disabled with the
 * reason: its mention trigger is off, it is paused, it is on none of the boards the reader can see (on a board it
 * is not on, the list says "not on this board" from `board_ids`), guests may not call it, or its AI connection is
 * gone, or the account's plan status stops all AI (`plan_status`).
 */
export const AGENT_UNAVAILABLE_REASONS = [
  'mention_off',
  'inactive',
  'not_on_board',
  'guests_not_allowed',
  'no_connection',
  // plan-lock: the account is read-only / suspended / closed — no AI at all.
  'plan_status',
] as const;
export type AgentUnavailableReason = (typeof AGENT_UNAVAILABLE_REASONS)[number];

export const agentUnavailableEntrySchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    name: z.string(),
    avatar: z.string().nullable(),
    role: z.string(),
    reason: z.enum(AGENT_UNAVAILABLE_REASONS),
  })
  .meta({ id: 'AgentUnavailableEntry' });
export type AgentUnavailableEntry = z.infer<typeof agentUnavailableEntrySchema>;

/** GET /agents/directory: the agents that act (`data`), and the others the reader could mention (`unavailable`). */
export const agentDirectorySchema = z
  .object({
    data: z.array(agentDirectoryEntrySchema),
    unavailable: z.array(agentUnavailableEntrySchema),
  })
  .meta({ id: 'AgentDirectory' });
export type AgentDirectory = z.infer<typeof agentDirectorySchema>;

/** Agent events that reach every open screen of the account over `/me/events` (the type only), for the lists. */
export const AGENT_LIVE_EVENTS: ReadonlySet<string> = new Set(['agent.created', 'agent.updated', 'agent.deleted']);

/** Automations that run an agent (the "when the agent acts" tab lists them). */
export const agentAutomationRefSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    board_id: z.string().nullable(),
    board_name: z.string().nullable(),
    is_active: z.boolean(),
  })
  .meta({ id: 'AgentAutomationRef' });
export type AgentAutomationRef = z.infer<typeof agentAutomationRefSchema>;

// ---- knowledge base (מ9) ----

export const AGENT_KNOWLEDGE_KINDS = ['file', 'doc', 'board', 'note'] as const;
export type AgentKnowledgeKind = (typeof AGENT_KNOWLEDGE_KINDS)[number];
export const AGENT_KNOWLEDGE_STATUSES = ['indexing', 'ready', 'error'] as const;

/** Caps: sources per agent, a file's size, the text kept from one source, one chunk, search answers. */
export const KNOWLEDGE_LIMITS = {
  sources: 50,
  fileBytes: 20 * 1024 * 1024,
  textChars: 1_000_000,
  noteChars: 50_000,
  chunkChars: 1200,
  chunkOverlap: 150,
  searchResults: 8,
} as const;

/** The file types a knowledge file may have (by extension; the text is extracted on the server). */
export const KNOWLEDGE_FILE_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'] as const;

export const addAgentKnowledgeSchema = z
  .discriminatedUnion('kind', [
    /** One of my finished uploads (PDF / DOCX / TXT / MD). */
    z.object({ kind: z.literal('file'), file_id: z.string().min(1).max(26) }),
    /** A doc I can read. */
    z.object({ kind: z.literal('doc'), doc_id: z.string().min(1).max(26) }),
    /** A board I can read: the agent reads it with its tools (as structured data), never as a text dump. */
    z.object({ kind: z.literal('board'), board_id: z.string().min(1).max(26) }),
    /** A text written here. */
    z.object({
      kind: z.literal('note'),
      title: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.noteChars),
    }),
  ])
  .meta({ id: 'AddAgentKnowledge' });
export type AddAgentKnowledge = z.infer<typeof addAgentKnowledgeSchema>;

export const agentKnowledgeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(AGENT_KNOWLEDGE_KINDS),
    title: z.string(),
    status: z.enum(AGENT_KNOWLEDGE_STATUSES),
    error: z.string().nullable(),
    chunks: z.number().int(),
    chars: z.number().int(),
    file_id: z.string().nullable(),
    doc_id: z.string().nullable(),
    board_id: z.string().nullable(),
    /** The text was cut at the cap. */
    truncated: z.boolean(),
    created_at: z.string(),
    indexed_at: z.string().nullable(),
  })
  .meta({ id: 'AgentKnowledge' });
export type AgentKnowledge = z.infer<typeof agentKnowledgeSchema>;
