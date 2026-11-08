// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { recipeSchema } from '../automations/schema';
import { templateSlotSchema } from '../automations/recipe-template';

/** Automations API (06 §2.16, 04 §8). The body's `recipe` may use the seed shorthands (04 §1.4). */
export const automationSchema = z
  .object({
    id: z.string(),
    board_id: z.string(),
    title: z.string(),
    recipe: recipeSchema,
    is_active: z.boolean(),
    owner_id: z.string().nullable(),
    seed_key: z.string().nullable(),
    note: z.string().nullable(),
    deactivated_reason: z.string().nullable(),
    run_count: z.number().int(),
    last_run_at: z.string().nullable(),
    last_error_at: z.string().nullable(),
    revision: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    /** Whether I may edit / switch / delete it (its owner, a board owner or an admin, with automation.manage). */
    can_manage: z.boolean(),
  })
  .meta({ id: 'Automation' });
export type Automation = z.infer<typeof automationSchema>;

export const recipeIssueSchema = z.object({ path: z.string(), code: z.string(), detail: z.string().optional() });

export const automationSavedSchema = automationSchema.extend({
  /** Data loss or template paths the board does not have — saved anyway (04 §6.2). */
  warnings: z.array(recipeIssueSchema),
});

export const createAutomationSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  recipe: z.record(z.string(), z.unknown()),
  is_active: z.boolean().default(true),
});

export const updateAutomationSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  recipe: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
  owner_id: z.string().optional(),
});

export const automationListSchema = z.object({ data: z.array(automationSchema) });

export const runLogEntrySchema = z
  .object({
    index: z.number().int(),
    type: z.string(),
    status: z.enum(['ok', 'skipped', 'error']),
    duration_ms: z.number(),
    output: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
    code: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .loose();

export const automationRunSchema = z
  .object({
    id: z.string(),
    automation_id: z.string(),
    event_id: z.string().nullable(),
    event_type: z.string().nullable(),
    item_id: z.string().nullable(),
    status: z.enum(['pending', 'running', 'succeeded', 'partial', 'failed', 'skipped']),
    skip_reason: z.string().nullable(),
    error: z.string().nullable(),
    depth: z.number().int(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    created_at: z.string(),
    log: z.array(runLogEntrySchema),
  })
  .meta({ id: 'AutomationRun' });
export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationRunsQuerySchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'partial', 'failed', 'skipped']).optional(),
  item_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().optional(),
});

/** "Run a test" (04 §8.4): dry run = what would happen, nothing written. */
export const testAutomationSchema = z.object({ item_id: z.string().optional(), dry_run: z.boolean().default(true) });

export const automationTestResultSchema = z.object({
  conditions: z.object({ matched: z.boolean(), failed_rule: z.string().nullable() }),
  actions: z.array(
    z.object({
      index: z.number().int(),
      type: z.string(),
      /** Every template of the action rendered for this item. */
      rendered: z.record(z.string(), z.unknown()),
      would_write: z.boolean(),
      skipped: z.string().optional(),
    }),
  ),
  /** dry_run false: the real run that was queued. */
  run_id: z.string().optional(),
});
export type AutomationTestResult = z.infer<typeof automationTestResultSchema>;

/**
 * the builder's preview of a `set_computed` expression — computed (nothing written) on a few items of
 * the board, or of its sub-board (`level: sub`, a subitem trigger), or on one item. Read as the person asking.
 */
export const computedPreviewSchema = z.object({
  expression: z.string().trim().min(1).max(2000),
  level: z.enum(['main', 'sub']).default('main'),
  item_id: z.string().optional(),
  /** The column it would write: the result is shown as that column shows it. */
  column: z.string().max(50).optional(),
  round: z.number().int().min(0).max(10).optional(),
});
export const computedPreviewResultSchema = z.object({
  samples: z.array(
    z.object({
      item_id: z.string(),
      name: z.string(),
      ok: z.boolean(),
      /** The result as the column shows it (or as computed when no column is given). */
      text: z.string().nullable(),
      /** Why there is no result: `missing_value`, `no_result`, `not_a_value`. */
      reason: z.string().optional(),
    }),
  ),
  /** The expression cannot run: `expression_invalid`, `column_not_found` … with what it is about. */
  error: z.object({ code: z.string(), detail: z.string().optional() }).optional(),
});
export type ComputedPreviewResult = z.infer<typeof computedPreviewResultSchema>;

/** Account-wide view (04 §8.2–8.3): every automation I can see, with its board and last 7 days. */
export const accountAutomationSchema = automationSchema.extend({
  board_name: z.string(),
  runs_7d: z.number().int(),
  errors_7d: z.number().int(),
});
export type AccountAutomation = z.infer<typeof accountAutomationSchema>;

export const automationUsageSchema = z.object({
  /** Last 30 days, oldest first: runs by outcome and the actions they carried out. */
  days: z.array(
    z.object({
      day: z.string(),
      succeeded: z.number().int(),
      partial: z.number().int(),
      failed: z.number().int(),
      skipped: z.number().int(),
      actions: z.number().int(),
    }),
  ),
  active: z.number().int(),
  total: z.number().int(),
  needs_fixing: z.number().int(),
  /** Scheduled fires due in the next 24 hours. */
  scheduled_24h: z.number().int(),
});
export type AutomationUsage = z.infer<typeof automationUsageSchema>;

// ---- account automation templates ("save as template") ----

const slotOptionSchema = z.object({ value: z.string(), title: z.string() });

/** An account template: a recipe whose board references are slots, picked again when it is installed. */
export const automationTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    recipe: z.record(z.string(), z.unknown()),
    slots: z.array(templateSlotSchema),
    /** The template's sentence with its slots' original titles (read-only preview). */
    sentence: z.string(),
    source_automation_id: z.string().nullable(),
    pack_key: z.string().nullable(),
    created_by: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: 'AutomationTemplate' });
export type AutomationTemplateDto = z.infer<typeof automationTemplateSchema>;

export const automationTemplateListSchema = z.object({
  data: z.array(automationTemplateSchema),
  /** Whether I may save, edit and delete templates (admins; members when the account allows it). */
  can_manage: z.boolean(),
});
export type AutomationTemplateList = z.infer<typeof automationTemplateListSchema>;

export const saveAutomationTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(48).optional(),
});

export const updateAutomationTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.string().trim().max(48).nullable().optional(),
});

/** Install form: the target board, and picks for slots (slot id → column key / group id / label text / text). */
export const templateProposalQuerySchema = z.object({ board_id: z.string().min(1).max(26) });

export const templateProposalSchema = z.object({
  board_id: z.string(),
  slots: z.array(
    templateSlotSchema.extend({
      /** The pick proposed on this board (same type, same title first); null = nothing fits, must be chosen. */
      value: z.string().nullable(),
      options: z.array(slotOptionSchema),
    }),
  ),
  /** The board has no sub-board yet, and the template needs one (add a subitem first). */
  needs_subitems: z.boolean(),
});
export type TemplateProposal = z.infer<typeof templateProposalSchema>;

export const installAutomationTemplateSchema = z.object({
  board_id: z.string().min(1).max(26),
  mapping: z.record(z.string(), z.string()).default({}),
  title: z.string().trim().min(1).max(255).optional(),
  is_active: z.boolean().default(false),
});
