// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  ELSE_BRANCH,
  evaluateConditions,
  graphIssues,
  graphTrigger,
  matchTrigger,
  newId,
  outgoing,
  SCENARIO_EXCLUDED_ACTIONS,
  scenarioGraphSchema,
  subTriggerDepth,
  type AutomationEvent,
  type FilterGroup,
  type ScenarioGraph,
  type ScenarioNode,
  type ScenarioStep,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { items, scenarioRuns, scenarios } from '../../db/schema';
import { enqueueJob } from '../../lib/jobs';
import type { AppDeps } from '../../types';
import type { ActivityRow } from '../activity/activity.repo';
import { findBoard, listColumns, type BoardRow } from '../boards/boards.repo';
import type { AutomationRow } from '../automations/automations.repo';
import { accountEnv, automationActor, loadSnapshot, queryEnvOf } from '../automations/engine/context';
import { runAction, type RunCtx } from '../automations/engine/actions';
import { MAX_DEPTH, runContext } from '../automations/engine/runner';
import { eventDepth } from '../agents/triggers';
import { consume, entitlements, writesBlocked } from '../billing/entitlements';

export type ScenarioRow = typeof scenarios.$inferSelect;
export type ScenarioRunRow = typeof scenarioRuns.$inferSelect;

/** Errors in a row before a scenario switches itself off (as an automation). */
export const SCENARIO_MAX_ERRORS = 20;
export const SCENARIO_RUN_TASK = 'scenario.run';
export const SCENARIO_RESUME_TASK = 'scenario.resume';

export const graphOf = (s: Pick<ScenarioRow, 'graph'>): ScenarioGraph | null => {
  const parsed = scenarioGraphSchema.safeParse(s.graph);
  return parsed.success ? parsed.data : null;
};

/** The scenario as the automation context reads it: its owner acts, its name is `{automation.title}`. */
const asAutomation = (s: ScenarioRow, g: ScenarioGraph): AutomationRow =>
  ({
    id: s.id,
    accountId: s.accountId,
    boardId: s.boardId,
    title: s.name,
    ownerId: s.ownerId,
    createdBy: s.createdBy,
    recipe: { trigger: graphTrigger(g)?.trigger },
  }) as unknown as AutomationRow;

type ScenarioMeta = { scenario_id?: string; depth?: number; chain?: string[]; automation_id?: string | null };

const eventOf = (row: ActivityRow, sub: boolean): AutomationEvent => {
  const meta = (row.payload.meta ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    type: row.type,
    board_id: row.boardId,
    item_id: row.itemId,
    sub,
    column_key: (meta.column_key as string | undefined) ?? null,
    column_type: (meta.column_type as string | undefined) ?? null,
    before: row.payload.before,
    after: row.payload.after,
    meta,
    actor: {
      type: row.actorType,
      id: row.actorId,
      automation_id: (meta.automation as ScenarioMeta | undefined)?.automation_id ?? row.automationId ?? null,
      depth: eventDepth(row),
    },
  };
};

/**
 * One activity row → the runs of the board's active scenarios whose trigger matches (one per scenario × event; a
 * redelivered job adds nothing). A scenario never hears its own writes; a chain deeper than MAX_DEPTH is skipped.
 */
export const dispatchScenarios = async (deps: AppDeps, row: ActivityRow, own: BoardRow): Promise<string[]> => {
  const { db } = deps;
  const listening = own.parentBoardId ?? own.id;
  const list = await db
    .select()
    .from(scenarios)
    .where(
      and(
        eq(scenarios.accountId, row.accountId),
        eq(scenarios.boardId, listening),
        eq(scenarios.isActive, true),
        isNull(scenarios.deletedAt),
      ),
    );
  if (!list.length) return [];
  const sub = !!own.parentBoardId;
  const ev = eventOf(row, sub);
  const meta = (ev.meta?.automation ?? {}) as ScenarioMeta;
  const depth = (ev.actor.depth ?? 0) + 1;
  const chain = (meta.chain ?? []).concat(meta.scenario_id ? [meta.scenario_id] : []);
  const columns = (await listColumns(db, own.id)).map((c) => ({
    id: c.key,
    type: c.type,
    settings: c.settings as Record<string, unknown>,
  }));
  const ids: string[] = [];
  for (const s of list) {
    if (meta.scenario_id === s.id) continue; // never its own writes
    const g = graphOf(s);
    const t = g ? graphTrigger(g) : null;
    if (!g || !t || graphIssues(g).length) continue;
    if (!matchTrigger(t.trigger, ev, { automationId: s.id, columns })) continue;
    const wantDepth = sub ? subTriggerDepth(t.trigger) : null;
    if (wantDepth !== null && ev.item_id) {
      const d = (await db.select({ d: items.depth }).from(items).where(eq(items.id, ev.item_id)).limit(1))[0]?.d;
      if (d !== wantDepth) continue;
    }
    const tooDeep = depth > MAX_DEPTH || chain.includes(s.id);
    const id = newId();
    const inserted = await db
      .insert(scenarioRuns)
      .values({
        id,
        accountId: s.accountId,
        scenarioId: s.id,
        eventId: row.id,
        itemId: ev.item_id,
        status: tooDeep ? 'skipped' : 'pending',
        skipReason: tooDeep ? (depth > MAX_DEPTH ? 'max_depth' : 'cycle') : null,
        depth,
        chain,
        ...(tooDeep ? { finishedAt: new Date() } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: scenarioRuns.id });
    if (!inserted.length || tooDeep) continue;
    ids.push(id);
    if (!(await enqueueJob(db, SCENARIO_RUN_TASK, { run_id: id }))) await executeScenarioRun(deps, id);
  }
  return ids;
};

const appendSteps = (db: Db, runId: string, steps: ScenarioStep[]) =>
  steps.length
    ? db
        .update(scenarioRuns)
        .set({ steps: sql`${scenarioRuns.steps} || ${JSON.stringify(steps)}::jsonb` })
        .where(eq(scenarioRuns.id, runId))
    : Promise.resolve();

const errorText = (e: unknown) => (e instanceof AppError ? e.message : ((e as Error)?.message ?? 'error'));

/** What happened to the nodes of one pass: steps, and the waits it scheduled. */
type Pass = { steps: ScenarioStep[]; waits: { token: string; at: Date; nodes: string[] }[] };

/**
 * Walks the graph from `start` (depth first, in edge order): a filter stops its path when its conditions fail, a
 * router goes on along the branches that match (or "otherwise"), an action runs through the automation services (an
 * error stops its path; a move the status workflow blocks is skipped), a wait schedules the rest of its path.
 */
const walk = async (ctx: RunCtx, g: ScenarioGraph, start: string[], pass: Pass) => {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const env = await accountEnv(ctx.db, ctx.a.ctx.accountId);
  const matches = async (c: FilterGroup | undefined) => {
    if (!c || !ctx.snap) return { matched: !c?.rules.length, failed_rule: null as string | null };
    const qenv = await queryEnvOf(ctx.db, ctx.a.ctx.accountId, ctx.snap.columns, env);
    const r = evaluateConditions(c, ctx.snap.item, qenv);
    return r.matched ? { matched: true, failed_rule: null } : { matched: false, failed_rule: r.failed_rule };
  };
  const visit = async (nodeId: string): Promise<void> => {
    const n = byId.get(nodeId) as ScenarioNode | undefined;
    if (!n) return;
    const started = Date.now();
    const step = (s: Omit<ScenarioStep, 'node_id' | 'kind' | 'at' | 'duration_ms'>): ScenarioStep => ({
      node_id: n.id,
      kind: n.kind,
      at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      ...s,
    });
    const next = (branch?: (b: string | undefined) => boolean) =>
      outgoing(g, n.id)
        .filter((e) => !branch || branch(e.branch))
        .map((e) => e.to);
    if (n.kind === 'filter') {
      let r;
      try {
        r = await matches(n.conditions);
      } catch (e) {
        pass.steps.push(step({ status: 'error', error: errorText(e) }));
        return;
      }
      if (!r.matched) {
        pass.steps.push(step({ status: 'skipped', reason: `conditions${r.failed_rule ? `:${r.failed_rule}` : ''}` }));
        return;
      }
      pass.steps.push(step({ status: 'ok' }));
      for (const m of next()) await visit(m);
      return;
    }
    if (n.kind === 'router') {
      const taken: string[] = [];
      try {
        for (const b of n.branches) {
          if (n.mode === 'first' && taken.length) break;
          if ((await matches(b.conditions)).matched) taken.push(b.id);
        }
      } catch (e) {
        pass.steps.push(step({ status: 'error', error: errorText(e) }));
        return;
      }
      if (!taken.length) taken.push(ELSE_BRANCH);
      pass.steps.push(step({ status: 'ok', branches: taken }));
      for (const m of next((b) => !!b && taken.includes(b))) await visit(m);
      return;
    }
    if (n.kind === 'wait') {
      const nodes = next();
      const at = new Date(Date.now() + n.minutes * 60_000);
      pass.steps.push(step({ status: 'waiting', output: { until: at.toISOString() } }));
      if (nodes.length) pass.waits.push({ token: newId(), at, nodes });
      return;
    }
    if (n.kind === 'action') {
      if (SCENARIO_EXCLUDED_ACTIONS.has(n.action.type)) {
        pass.steps.push(step({ status: 'skipped', reason: 'not_available' }));
        return;
      }
      try {
        ctx.a.notes = [];
        const out = await runAction(ctx, n.action);
        if (out.status === 'ok') pass.steps.push(step({ status: 'ok', output: out.output ?? null }));
        else if (out.status === 'skipped') {
          pass.steps.push(step({ status: 'skipped', reason: out.reason }));
          return;
        } else {
          pass.steps.push(step({ status: 'error', error: out.error }));
          return;
        }
      } catch (e) {
        if (e instanceof AppError && e.code === 'workflow_blocked')
          pass.steps.push(step({ status: 'skipped', reason: e.message }));
        else pass.steps.push(step({ status: 'error', error: errorText(e) }));
        return;
      }
      for (const m of next()) await visit(m);
      return;
    }
    // The trigger: on to what follows it.
    for (const m of next()) await visit(m);
  };
  for (const id of start) await visit(id);
};

const contextFor = async (deps: AppDeps, s: ScenarioRow, g: ScenarioGraph, run: ScenarioRunRow) => {
  const auto = asAutomation(s, g);
  const a = await automationActor(deps.db, auto, run.id);
  const board = await findBoard(deps.db, s.accountId, s.boardId);
  if (!board) throw new AppError('not_found', 'board_gone');
  const trigger = graphTrigger(g)?.trigger.type;
  const goneOk = trigger === 'item_deleted' || trigger === 'item_archived';
  const snap = run.itemId ? await loadSnapshot(deps.db, a, run.itemId, { gone: goneOk }) : null;
  const env = await accountEnv(deps.db, s.accountId);
  const ctx = await runContext(deps, {
    automation: auto,
    a,
    board,
    snap,
    row: undefined,
    run: { id: run.id, depth: run.depth, chain: run.chain },
    env,
  });
  // Its writes are the scenario's: no automation id (the stamp's FK-free `scenario_id` keeps loops out).
  ctx.scope = { automation_id: null, scenario_id: s.id, run_id: run.id, depth: run.depth, chain: run.chain };
  ctx.eventId = run.eventId;
  return ctx;
};

/** Ends a run once nothing waits: its status from all its steps; the scenario's error count follows. */
const settle = async (db: Db, runId: string) => {
  const [run] = await db.select().from(scenarioRuns).where(eq(scenarioRuns.id, runId)).limit(1);
  if (!run || (run.resumeNodes as string[]).length) return run ?? null;
  const steps = run.steps as ScenarioStep[];
  const errors = steps.filter((s) => s.status === 'error').length;
  const oks = steps.filter((s) => s.status === 'ok' && s.kind === 'action').length;
  const status = errors ? (oks ? 'partial' : 'failed') : oks ? 'succeeded' : 'skipped';
  await db
    .update(scenarioRuns)
    .set({
      status,
      finishedAt: new Date(),
      ...(status === 'skipped' ? { skipReason: 'nothing_to_do' } : {}),
      ...(errors ? { error: steps.find((s) => s.error)?.error ?? null } : {}),
    })
    .where(eq(scenarioRuns.id, runId));
  if (errors) {
    const [s] = await db
      .update(scenarios)
      .set({ consecutiveErrors: sql`${scenarios.consecutiveErrors} + 1` })
      .where(eq(scenarios.id, run.scenarioId))
      .returning();
    if (s && s.consecutiveErrors >= SCENARIO_MAX_ERRORS)
      await db
        .update(scenarios)
        .set({ isActive: false, deactivatedReason: 'too_many_errors' })
        .where(eq(scenarios.id, s.id));
  } else await db.update(scenarios).set({ consecutiveErrors: 0 }).where(eq(scenarios.id, run.scenarioId));
  return { ...run, status };
};

/** Schedules the waits of a pass (each a job at its time; without a queue — tests — it goes on right away). */
const scheduleWaits = async (deps: AppDeps, runId: string, waits: Pass['waits']) => {
  if (!waits.length) return;
  await deps.db
    .update(scenarioRuns)
    .set({
      status: 'waiting',
      resumeNodes: sql`${scenarioRuns.resumeNodes} || ${JSON.stringify(waits.map((w) => w.token))}::jsonb`,
      resumeAt: waits.reduce((m, w) => (w.at > m ? w.at : m), waits[0]!.at),
    })
    .where(eq(scenarioRuns.id, runId));
  for (const w of waits) {
    const payload = { run_id: runId, token: w.token, nodes: w.nodes };
    if (!(await enqueueJob(deps.db, SCENARIO_RESUME_TASK, payload, { runAt: w.at })))
      await resumeScenarioRun(deps, payload);
  }
};

const fail = async (db: Db, runId: string, reason: string, status: 'failed' | 'skipped' = 'failed') => {
  await db
    .update(scenarioRuns)
    .set({ status, finishedAt: new Date(), ...(status === 'skipped' ? { skipReason: reason } : { error: reason }) })
    .where(eq(scenarioRuns.id, runId));
  return null;
};

/** `scenario.run`: claim the pending run, then walk the graph from its trigger. */
export const executeScenarioRun = async (deps: AppDeps, runId: string, opts: { test?: boolean } = {}) => {
  const { db } = deps;
  const [run] = await db
    .update(scenarioRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(scenarioRuns.id, runId), eq(scenarioRuns.status, 'pending')))
    .returning();
  if (!run) return null;
  const [s] = await db.select().from(scenarios).where(eq(scenarios.id, run.scenarioId)).limit(1);
  if (!s || s.deletedAt || (!s.isActive && !opts.test)) return fail(db, run.id, 'inactive', 'skipped');
  const g = graphOf(s);
  const t = g ? graphTrigger(g) : null;
  if (!g || !t) return fail(db, run.id, 'invalid_graph');
  const plan = await entitlements(db, run.accountId);
  if (writesBlocked(plan.status)) return fail(db, run.id, 'plan_read_only', 'skipped');
  try {
    await consume(db, run.accountId, 'automation_runs', 1);
  } catch (e) {
    if (e instanceof AppError && e.code === 'plan_limit_reached')
      return fail(db, run.id, 'plan_limit_reached', 'skipped');
    throw e;
  }
  let ctx: RunCtx;
  try {
    ctx = await contextFor(deps, s, g, run);
  } catch (e) {
    return fail(db, run.id, errorText(e));
  }
  if (run.itemId && !ctx.snap) return fail(db, run.id, 'item_gone', 'skipped');
  const pass: Pass = { steps: [], waits: [] };
  try {
    await walk(ctx, g, [t.id], pass);
  } catch (e) {
    pass.steps.push({
      node_id: t.id,
      kind: 'trigger',
      status: 'error',
      at: new Date().toISOString(),
      duration_ms: 0,
      error: errorText(e),
    });
  }
  await appendSteps(db, run.id, pass.steps);
  await scheduleWaits(deps, run.id, pass.waits);
  return settle(db, run.id);
};

/** `scenario.resume`: a wait is over — go on with the nodes after it (the run's item read fresh). */
export const resumeScenarioRun = async (deps: AppDeps, p: { run_id: string; token: string; nodes: string[] }) => {
  const { db } = deps;
  // Take the token: a redelivered job finds it gone and does nothing.
  const taken = await db
    .update(scenarioRuns)
    .set({ resumeNodes: sql`${scenarioRuns.resumeNodes} - ${p.token}::text` })
    .where(and(eq(scenarioRuns.id, p.run_id), sql`${scenarioRuns.resumeNodes} ? ${p.token}::text`))
    .returning();
  const run = taken[0];
  if (!run) return null;
  const [s] = await db.select().from(scenarios).where(eq(scenarios.id, run.scenarioId)).limit(1);
  const g = s ? graphOf(s) : null;
  if (!s || s.deletedAt || !s.isActive || !g) {
    await appendSteps(db, run.id, []);
    return settle(db, run.id);
  }
  const pass: Pass = { steps: [], waits: [] };
  try {
    const ctx = await contextFor(deps, s, g, run);
    await walk(ctx, g, p.nodes, pass);
  } catch (e) {
    pass.steps.push({
      node_id: p.nodes[0] ?? '',
      kind: 'wait',
      status: 'error',
      at: new Date().toISOString(),
      duration_ms: 0,
      error: errorText(e),
    });
  }
  await appendSteps(db, run.id, pass.steps);
  await scheduleWaits(deps, run.id, pass.waits);
  return settle(db, run.id);
};
