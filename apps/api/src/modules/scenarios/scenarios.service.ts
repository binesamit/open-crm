// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  AppError,
  canBoard,
  graphIssues,
  newId,
  validateConditions,
  type ScenarioDto,
  type ScenarioGraph,
  type ScenarioRunDto,
  type ScenarioStep,
} from '@bines/shared';
import type { z } from 'zod';
import type { createScenarioSchema, updateScenarioSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { items, scenarioRuns, scenarios } from '../../db/schema';
import type { AppDeps } from '../../types';
import { assertBoard, isOwnerOrAdmin, loadBoardAccess, type BoardAccess } from '../boards/boards.access';
import { listColumns } from '../boards/boards.repo';
import { accountEnv, queryEnvOf } from '../automations/engine/context';
import type { Actor } from '../items/items.service';
import { recordEvent } from '../activity/activity.repo';
import { executeScenarioRun, graphOf, type ScenarioRow } from './engine';

/**
 * phase 3 — scenarios of a board: who sees them (`automation.read`), who changes them (`automation.manage`
 * and it is theirs — or they own the board / are an admin). A scenario runs with its owner's rights, so whoever saves
 * a change becomes its owner: nobody's rights are used for steps they did not write.
 */
const EMPTY_GRAPH: ScenarioGraph = { nodes: [], edges: [] };

const loadAccess = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'automation.read');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'scenarios_live_on_the_main_board');
  return access;
};

const mayManage = (access: BoardAccess, a: Actor, row: Pick<ScenarioRow, 'ownerId'> | null) =>
  canBoard(access.perm, 'automation.manage').ok && (!row || row.ownerId === a.user.id || isOwnerOrAdmin(access));

const assertManage = (access: BoardAccess, a: Actor, row: Pick<ScenarioRow, 'ownerId'> | null) => {
  if (!mayManage(access, a, row)) throw new AppError('forbidden', 'scenario_not_yours');
};

/** Filters' and branches' conditions must plan against the board's columns (a typo'd column answers 422). */
const checkConditions = async (db: Db, accountId: string, boardId: string, g: ScenarioGraph) => {
  const conds = g.nodes.flatMap((n) =>
    n.kind === 'filter' ? [n.conditions] : n.kind === 'router' ? n.branches.flatMap((b) => b.conditions ?? []) : [],
  );
  if (!conds.length) return;
  const env = await queryEnvOf(db, accountId, await listColumns(db, boardId), await accountEnv(db, accountId));
  for (const c of conds) validateConditions(c, env);
};

const dto = (
  s: ScenarioRow,
  access: BoardAccess,
  a: Actor,
  last: { id: string; status: string; createdAt: Date } | undefined,
): ScenarioDto => {
  const g = graphOf(s) ?? EMPTY_GRAPH;
  return {
    id: s.id,
    board_id: s.boardId,
    name: s.name,
    graph: g,
    is_active: s.isActive,
    owner_id: s.ownerId,
    can_manage: mayManage(access, a, s),
    deactivated_reason: s.deactivatedReason,
    issues: graphIssues(g),
    last_run: last ? { id: last.id, status: last.status, created_at: last.createdAt.toISOString() } : null,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
};

const findScenario = async (db: Db, a: Actor, id: string) => {
  const [s] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, id), eq(scenarios.accountId, a.ctx.accountId), isNull(scenarios.deletedAt)))
    .limit(1);
  if (!s) throw new AppError('not_found', 'Scenario not found');
  return { s, access: await loadAccess(db, a, s.boardId) };
};

const lastRuns = async (db: Db, ids: string[]) => {
  const out = new Map<string, { id: string; status: string; createdAt: Date }>();
  if (!ids.length) return out;
  const rows = await db
    .select({
      id: scenarioRuns.id,
      scenarioId: scenarioRuns.scenarioId,
      status: scenarioRuns.status,
      createdAt: scenarioRuns.createdAt,
    })
    .from(scenarioRuns)
    .where(inArray(scenarioRuns.scenarioId, ids))
    .orderBy(desc(scenarioRuns.createdAt))
    .limit(500);
  for (const r of rows) if (!out.has(r.scenarioId)) out.set(r.scenarioId, r);
  return out;
};

export const listScenarios = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadAccess(db, a, boardId);
  const rows = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.boardId, boardId), isNull(scenarios.deletedAt)))
    .orderBy(scenarios.createdAt);
  const last = await lastRuns(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((s) => dto(s, access, a, last.get(s.id)));
};

export const getScenario = async (db: Db, a: Actor, id: string) => {
  const { s, access } = await findScenario(db, a, id);
  return dto(s, access, a, (await lastRuns(db, [s.id])).get(s.id));
};

const audit = (db: Db, a: Actor, s: Pick<ScenarioRow, 'id' | 'boardId' | 'name'>, type: string, meta = {}) =>
  recordEvent(db, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: s.boardId,
    meta: { scenario_id: s.id, name: s.name, ...meta },
  });

export const createScenario = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof createScenarioSchema>,
) => {
  const access = await loadAccess(db, a, boardId);
  assertManage(access, a, null);
  const graph = input.graph ?? EMPTY_GRAPH;
  await checkConditions(db, a.ctx.accountId, boardId, graph);
  const id = newId();
  await db.insert(scenarios).values({
    id,
    accountId: a.ctx.accountId,
    boardId,
    name: input.name,
    graph: graph as never,
    ownerId: a.user.id,
    createdBy: a.user.id,
  });
  await audit(db, a, { id, boardId, name: input.name }, 'scenario.created');
  return getScenario(db, a, id);
};

/** A change makes the saver its owner; a graph with issues cannot stay on (it is switched off). */
export const updateScenario = async (db: Db, a: Actor, id: string, input: z.infer<typeof updateScenarioSchema>) => {
  const { s, access } = await findScenario(db, a, id);
  assertManage(access, a, s);
  if (input.graph) await checkConditions(db, a.ctx.accountId, s.boardId, input.graph);
  const broken = input.graph ? graphIssues(input.graph).length > 0 : false;
  await db
    .update(scenarios)
    .set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.graph ? { graph: input.graph as never } : {}),
      ownerId: a.user.id,
      ...(broken && s.isActive ? { isActive: false, deactivatedReason: 'graph_issues' } : {}),
      updatedAt: new Date(),
    })
    .where(eq(scenarios.id, id));
  await audit(db, a, s, 'scenario.updated');
  return getScenario(db, a, id);
};

export const setScenarioActive = async (db: Db, a: Actor, id: string, active: boolean) => {
  const { s, access } = await findScenario(db, a, id);
  assertManage(access, a, s);
  if (active) {
    const g = graphOf(s);
    const issues = g ? graphIssues(g) : [{ code: 'invalid_graph' }];
    if (issues.length) throw new AppError('validation_failed', 'scenario_has_issues', { issues });
  }
  await db
    .update(scenarios)
    .set({
      isActive: active,
      deactivatedReason: null,
      consecutiveErrors: 0,
      // Switching on is running as me.
      ...(active ? { ownerId: a.user.id } : {}),
      updatedAt: new Date(),
    })
    .where(eq(scenarios.id, id));
  await audit(db, a, s, active ? 'scenario.activated' : 'scenario.deactivated');
  return getScenario(db, a, id);
};

export const deleteScenario = async (db: Db, a: Actor, id: string) => {
  const { s, access } = await findScenario(db, a, id);
  assertManage(access, a, s);
  await db.update(scenarios).set({ deletedAt: new Date(), isActive: false }).where(eq(scenarios.id, id));
  await audit(db, a, s, 'scenario.deleted');
};

const runDto = (r: typeof scenarioRuns.$inferSelect, itemName: string | null): ScenarioRunDto => ({
  id: r.id,
  status: r.status,
  skip_reason: r.skipReason,
  item_id: r.itemId,
  item_name: itemName,
  error: r.error,
  steps: r.steps as ScenarioStep[],
  created_at: r.createdAt.toISOString(),
  finished_at: r.finishedAt?.toISOString() ?? null,
});

export const listScenarioRuns = async (db: Db, a: Actor, id: string, limit = 50) => {
  const { s } = await findScenario(db, a, id);
  const rows = await db
    .select({ run: scenarioRuns, itemName: items.name })
    .from(scenarioRuns)
    .leftJoin(items, eq(items.id, scenarioRuns.itemId))
    .where(eq(scenarioRuns.scenarioId, s.id))
    .orderBy(desc(scenarioRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => runDto(r.run, r.itemName));
};

/**
 * "Run a test on an item": a real run of the scenario on this item now (its actions do happen), even while it is
 * off — the run log shows each step. Needs a graph without issues.
 */
export const testScenario = async (deps: AppDeps, a: Actor, id: string, itemId: string) => {
  const { db } = deps;
  const { s, access } = await findScenario(db, a, id);
  assertManage(access, a, s);
  const g = graphOf(s);
  const issues = g ? graphIssues(g) : [{ code: 'invalid_graph' }];
  if (issues.length) throw new AppError('validation_failed', 'scenario_has_issues', { issues });
  const [item] = await db
    .select({ id: items.id, boardId: items.boardId })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.accountId, a.ctx.accountId), isNull(items.deletedAt)))
    .limit(1);
  if (!item || item.boardId !== s.boardId) throw new AppError('bad_request', 'item_not_on_board');
  const runId = newId();
  await db
    .insert(scenarioRuns)
    .values({ id: runId, accountId: s.accountId, scenarioId: s.id, itemId, status: 'pending' });
  // A test waits for its answer (a queued run would leave the dialog guessing); it runs even while the scenario is
  // off, as the scenario's owner.
  await executeScenarioRun(deps, runId, { test: true });
  const [row] = await db
    .select({ run: scenarioRuns, itemName: items.name })
    .from(scenarioRuns)
    .leftJoin(items, eq(items.id, scenarioRuns.itemId))
    .where(eq(scenarioRuns.id, runId));
  return runDto(row!.run, row!.itemName);
};
