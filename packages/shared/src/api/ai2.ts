// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { actionDescriptionSchema } from '../ai/describe';

/**
 * AI columns (מ11) and the AI assistant panel (מ12) — HTTP shapes. the planning notes "AGENTS-MCP", D26.
 */

// ---- AI columns ----

export const AI_RUN_MODES = ['items', 'empty', 'all'] as const;
export const aiColumnRunRequestSchema = z.object({
  /** items = the given item ids (a cell button, the batch bar); empty = items whose cell is empty; all = every item. */
  mode: z.enum(AI_RUN_MODES).default('items'),
  item_ids: z.array(z.string().min(1).max(64)).max(1000).optional(),
  /**
   * Image output (round 4): for items that already have designs, this run saves a new version of
   * each (`version`) or another design (`add`); unset = the column's `image_on_rerun`.
   */
  on_existing: z.enum(['version', 'add']).optional(),
  /**
   * Image output (the images queue): "complete the missing images" — only the designs of these items
   * that failed, or that are pending with no run left to make them; designs already made are never made (or charged)
   * again. Items with nothing missing are skipped.
   */
  only_missing: z.boolean().optional(),
});
export type AiColumnRunRequest = z.infer<typeof aiColumnRunRequestSchema>;

export const AI_RUN_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export const aiColumnRunSchema = z
  .object({
    id: z.string(),
    board_id: z.string(),
    column_id: z.string(),
    status: z.enum(AI_RUN_STATUSES),
    /** auto = started by a change of an input column. */
    trigger: z.enum(['manual', 'auto']),
    /**
     * What the counts count: `cell` (text output — cells filled) or `image` (image output — designs: `total` to make,
     * `done` made, `failed` not made; an item that could not run at all counts as one failed). Image runs are queued:
     * the answer comes `running` and the designs are made one after the other.
     */
    unit: z.enum(['cell', 'image']),
    total: z.number().int(),
    done: z.number().int(),
    failed: z.number().int(),
    /** Items left out: not visible / not editable for the person, or the cell was empty-mode and filled. */
    skipped: z.number().int(),
    cost_usd: z.number(),
    /** Why the run stopped early: limit_items, limit_run_usd, limit_column_usd, ai_budget_exceeded, ai_disabled… */
    stopped: z.string().nullable(),
    /** Every write of the run, one undoable batch (null when nothing was written). */
    batch_id: z.string().nullable(),
    errors: z.array(z.object({ item_id: z.string(), error: z.string() })),
    created_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .meta({ id: 'AiColumnRun' });
export type AiColumnRun = z.infer<typeof aiColumnRunSchema>;

export const aiColumnInfoSchema = z
  .object({
    /** A connection + model are chosen and AI is on in the account. */
    ready: z.boolean(),
    reason: z.string().nullable(),
    month_usd: z.number(),
    max_usd_per_month: z.number().nullable(),
    runs: z.array(aiColumnRunSchema),
  })
  .meta({ id: 'AiColumnInfo' });
export type AiColumnInfo = z.infer<typeof aiColumnInfoSchema>;

/** The AI connections anyone setting up an AI column may pick (names only — never a key). */
export const aiConnectionOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  default_model: z.string().nullable(),
});

// ---- the assistant ----

/** `plan_status`: the account's plan status stops AI (read-only, suspended, closed — `statusBlocksAi`). */
export const ASSISTANT_UNAVAILABLE = [
  'ai_disabled',
  'assistant_disabled',
  'not_configured',
  'role',
  'plan_status',
] as const;
export const assistantStatusSchema = z
  .object({
    available: z.boolean(),
    reason: z.enum(ASSISTANT_UNAVAILABLE).nullable(),
    model: z.string().nullable(),
    /** Admins get a link to Administration → AI ו-MCP. */
    can_configure: z.boolean(),
  })
  .meta({ id: 'AssistantStatus' });
export type AssistantStatus = z.infer<typeof assistantStatusSchema>;

export const ASSISTANT_ACTION_STATUSES = ['pending', 'done', 'rejected', 'failed'] as const;
export const assistantActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  title: z.string(),
  /** One line a person reads before approving. */
  preview: z.string(),
  /** The change in words, with names resolved (sync-ai) — shown instead of the JSON. */
  description: actionDescriptionSchema.nullable().optional(),
  input: z.unknown(),
  status: z.enum(ASSISTANT_ACTION_STATUSES),
  batch_id: z.string().nullable(),
  error: z.string().nullable(),
});
export type AssistantAction = z.infer<typeof assistantActionSchema>;

/** A file attached to a chat message: pasted or chosen, uploaded like any file (POST /files/presign). */
export const assistantFileSchema = z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number() });
export type AssistantFile = z.infer<typeof assistantFileSchema>;

/** At most this many files on one chat message. */
export const MAX_ASSISTANT_FILES = 10;

/**
 * What a chat message may point at with "@" ("choose items or boards… to be specific, from
 * anywhere"): an item, a board, a document or a dashboard the person can open. The answer gets it as exact context.
 */
export const ASSISTANT_REF_TYPES = ['item', 'board', 'doc', 'dashboard'] as const;
export type AssistantRefType = (typeof ASSISTANT_REF_TYPES)[number];
export const assistantRefInputSchema = z.object({
  type: z.enum(ASSISTANT_REF_TYPES),
  id: z.string().min(1).max(64),
});
/** A pointed-at thing as the message shows it: its name when sent, and an item's board (to open it). */
export const assistantRefSchema = assistantRefInputSchema.extend({ name: z.string(), board_id: z.string().nullable() });
export type AssistantRef = z.infer<typeof assistantRefSchema>;
/** At most this many "@" references on one chat message. */
export const MAX_ASSISTANT_REFS = 10;

export const assistantMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    /** Read tools the assistant used for this answer (names). */
    reads: z.array(z.string()),
    actions: z.array(assistantActionSchema),
    cost_usd: z.number(),
    error: z.string().nullable(),
    created_at: z.string(),
    /** Files the person attached to this message — open one with GET /files/{id}. */
    files: z.array(assistantFileSchema),
    /** What the person pointed at with "@" in this message. */
    refs: z.array(assistantRefSchema),
    /** Guided tours the assistant offered ("show me") — a button each. */
    tours: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
  })
  .meta({ id: 'AssistantMessage' });
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const assistantConversationSchema = z
  .object({
    id: z.string(),
    board_id: z.string().nullable(),
    item_id: z.string().nullable(),
    /** a chat opened on a document or a dashboard, and a chat with one of the account's agents. */
    doc_id: z.string().nullable(),
    dashboard_id: z.string().nullable(),
    agent_id: z.string().nullable(),
    title: z.string(),
    cost_usd: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: 'AssistantConversation' });
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;

/**
 * Where a chat is about (the panel opens anywhere): one of an item (its board follows), a board, a
 * document or a dashboard — none = the whole account. `agent_id`: chat with that agent instead of the assistant.
 */
export const assistantContextSchema = z.object({
  board_id: z.string().min(1).max(64).optional(),
  item_id: z.string().min(1).max(64).optional(),
  doc_id: z.string().min(1).max(64).optional(),
  dashboard_id: z.string().min(1).max(64).optional(),
  agent_id: z.string().min(1).max(64).optional(),
});
export type AssistantContext = z.infer<typeof assistantContextSchema>;

/** An agent the person may chat with in the panel. */
export const assistantAgentSchema = z
  .object({ id: z.string(), name: z.string(), avatar: z.string().nullable(), role: z.string() })
  .meta({ id: 'AssistantAgent' });
export type AssistantAgent = z.infer<typeof assistantAgentSchema>;
/**
 * A message: its words and / or files the person uploaded first (images the model sees, documents it
 * reads) — at least one of the two.
 */
export const assistantSendSchema = z
  .object({
    text: z.string().trim().max(8000).default(''),
    file_ids: z.array(z.string().min(1).max(64)).max(MAX_ASSISTANT_FILES).default([]),
    /** things pointed at with "@" — each one the person can open (else 404 before the stream). */
    refs: z.array(assistantRefInputSchema).max(MAX_ASSISTANT_REFS).default([]),
  })
  .refine((v) => v.text.length > 0 || v.file_ids.length > 0 || v.refs.length > 0, {
    message: 'text, files or references required',
    path: ['text'],
  });
export const assistantDecideSchema = z.object({
  approve: z.array(z.string()).max(50).default([]),
  reject: z.array(z.string()).max(50).default([]),
});
export const assistantDecisionSchema = z.object({
  /** One batch for every approved action — undo it with POST /activity/batches/{id}/undo. */
  batch_id: z.string().nullable(),
  message: assistantMessageSchema,
});

/** Server-sent events of POST …/messages (text/event-stream). */
export type AssistantStreamEvent =
  | { type: 'user'; message: AssistantMessage }
  | { type: 'delta'; text: string }
  | { type: 'read'; tool: string }
  | { type: 'action'; action: AssistantAction }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; code: string; message?: AssistantMessage };
