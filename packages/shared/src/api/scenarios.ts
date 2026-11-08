// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { scenarioGraphSchema } from '../scenarios/graph';

/** phase 3 — the scenarios API (a board's graph automations). */
export const createScenarioSchema = z.object({
  name: z.string().trim().min(1).max(120),
  graph: scenarioGraphSchema.optional(),
});

export const updateScenarioSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  graph: scenarioGraphSchema.optional(),
});

export const setScenarioActiveSchema = z.object({ active: z.boolean() });
export const testScenarioSchema = z.object({ item_id: z.string().min(1) });

export const scenarioIssueSchema = z.object({
  node_id: z.string().optional(),
  edge_id: z.string().optional(),
  code: z.string(),
});

export const scenarioSchema = z.object({
  id: z.string(),
  board_id: z.string(),
  name: z.string(),
  graph: scenarioGraphSchema,
  is_active: z.boolean(),
  owner_id: z.string().nullable(),
  /** The owner, a board owner or an admin may change it (others see it). */
  can_manage: z.boolean(),
  deactivated_reason: z.string().nullable(),
  issues: z.array(scenarioIssueSchema),
  last_run: z.object({ id: z.string(), status: z.string(), created_at: z.string() }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ScenarioDto = z.infer<typeof scenarioSchema>;

export const scenarioStepSchema = z.object({
  node_id: z.string(),
  kind: z.string(),
  status: z.enum(['ok', 'skipped', 'error', 'waiting']),
  at: z.string(),
  duration_ms: z.number(),
  /** A router: the branches taken. */
  branches: z.array(z.string()).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});
export type ScenarioStep = z.infer<typeof scenarioStepSchema>;

export const scenarioRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  skip_reason: z.string().nullable(),
  item_id: z.string().nullable(),
  item_name: z.string().nullable(),
  error: z.string().nullable(),
  steps: z.array(scenarioStepSchema),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type ScenarioRunDto = z.infer<typeof scenarioRunSchema>;
