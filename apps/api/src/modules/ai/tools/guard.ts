// SPDX-License-Identifier: AGPL-3.0-only
import { type AiSettings, type AiToolDef, AppError, PLAN_FEATURE_ACTIONS, type PlanFeatureKey } from '@bines/shared';
import type { AppDeps, SupportAccess } from '../../../types';
import { RateLimiter } from '../../../lib/rate-limit';
import { aiStatusError, closedError, entitlements, featureError, hasFeature } from '../../billing/entitlements';
import { getAutomation } from '../../automations/automations.service';
import type { Actor } from '../../items/items.service';
import { loadAiSettings } from '../ai.service';

/**
 * The one gate in front of every AI tool call (aiguard) — the MCP server, the agents' loop and the assistant (its
 * reads, its proposals and its approved actions) all ask it before a runner runs, so none of them can do what the
 * REST API would refuse:
 *
 * 1. remote support in `view` mode: read tools only (405 `support_read_only`);
 * 2. the plan's status (assertPlanStatusAllows semantics): `closed` / `suspended` run nothing (403 `account_closed`
 *    / 423 `plan_suspended`); `read_only` runs read tools only over MCP and nothing for agents / the assistant
 *    (423 `plan_read_only` — plan-lock);
 * 3. the plan's features (402 `plan_feature_unavailable`): the surface's own (agents / assistant = `ai`, the MCP
 *    server = `api`) and, for changes, the tool's (flows_* = `flows`, an automation with advanced actions …);
 * 4. a change rate shared by all three (429 `rate_limited`): per person, per AI-app connection, per agent and per
 *    account — the limits are account settings (Administration → AI ו-MCP).
 *
 * It runs again when an approved action finally executes (an agent resumed after an approval, the assistant's
 * "approve"), so a downgrade between the proposal and the approval is honoured. Surface `app`: an AI change asked
 * from the app's own screens over REST ("Ask the AI for a change" on a file) — the `ai` feature, the
 * same statuses and the same shared change rate.
 */
export type ToolSurface = 'mcp' | 'agent' | 'assistant' | 'app';

/** A refusal of the guard: `reason` is the stable code a run / an action records ("why it did not run"). */
export class ToolGuardError extends AppError {
  constructor(
    err: AppError,
    readonly reason: string,
  ) {
    super(err.code, err.message, err.details);
  }
}

/** Every change of AI in this process (one api instance, like the other limiters); keyed per scope. */
export const aiWriteLimiter = new RateLimiter(Number.MAX_SAFE_INTEGER, 60_000);

const SURFACE_FEATURE: Record<ToolSurface, PlanFeatureKey> = { mcp: 'api', agent: 'ai', assistant: 'ai', app: 'ai' };

const DASHBOARD_WRITE_TOOLS = new Set([
  'create_dashboard',
  'add_dashboard_widget',
  'update_dashboard_widget',
  'remove_dashboard_widget',
  'update_dashboard',
  'set_dashboard_layout',
  'duplicate_dashboard_widget',
  'duplicate_dashboard',
]);

/** The plan features a change by this tool needs, besides the surface's. */
const toolFeatures = async (
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  name: string,
  input: unknown,
): Promise<PlanFeatureKey[]> => {
  const x = (input ?? {}) as Record<string, unknown>;
  if (name.startsWith('flows_')) return ['flows'];
  // Like the dashboard routes (billing/feature-gates.ts): dashboards are a plan feature.
  if (DASHBOARD_WRITE_TOOLS.has(name)) return ['dashboards'];
  if (name === 'generate_image' || name === 'edit_file_image') return ['ai'];
  const actionsOf = (recipe: unknown) => {
    const actions = (recipe as { actions?: unknown } | null)?.actions;
    return Array.isArray(actions) ? (actions as { type?: unknown }[]) : [];
  };
  const featuresOf = (recipe: unknown) => [
    ...new Set(actionsOf(recipe).flatMap((a) => (typeof a?.type === 'string' && PLAN_FEATURE_ACTIONS[a.type]) || [])),
  ];
  if (name === 'create_automation') return featuresOf(x.recipe);
  // Switching on an automation whose actions the plan no longer includes.
  if (name === 'set_automation_active' && x.is_active === true && typeof x.automation_id === 'string') {
    const found = await getAutomation(deps.db, actor, x.automation_id).catch(() => null);
    return found ? featuresOf(found.recipe) : [];
  }
  return [];
};

export type GuardCall = {
  surface: ToolSurface;
  actor: Actor;
  /** The tool as this call is treated (`callTool`): its risk decides read vs change. */
  tool: Pick<AiToolDef, 'name' | 'risk'>;
  input: unknown;
  /** Extra rate scopes of the caller (the MCP connection's token id). */
  rateKeys?: string[];
  /** false = a check only (a proposal waiting for a person): no change is counted. */
  count?: boolean;
  /** The caller's support grant when it is not on the actor (the MCP principal). */
  support?: SupportAccess | null;
  /** The account's AI settings when the caller has them already. */
  ai?: AiSettings;
};

const refuse = (err: AppError, reason: string = err.code): never => {
  throw new ToolGuardError(err, reason);
};

/** Throws a ToolGuardError when the call may not run now; counts a change against the shared rate. */
export const guardToolCall = async (deps: Pick<AppDeps, 'db'>, g: GuardCall): Promise<void> => {
  const accountId = g.actor.ctx.accountId;
  const change = g.tool.risk !== 'read';
  // 1. Remote support: `view` reads only.
  const support = g.support ?? g.actor.ctx.support ?? null;
  if (change && support?.mode === 'view') refuse(new AppError('support_read_only', 'Support access is view only'));
  // 2. The plan's status.
  const { status } = await entitlements(deps.db, accountId);
  if (status === 'closed') refuse(closedError());
  if (status === 'suspended')
    refuse(new AppError('plan_suspended', 'The account’s subscription is suspended', { upgrade: true }));
  // plan-lock: the account's own AI (agents, the assistant) does not run at all while read-only — not even
  // its reads. An AI app over MCP reads like any API client.
  if (g.surface !== 'mcp' && status === 'read_only') refuse(aiStatusError(status)!);
  if (change && status === 'read_only')
    refuse(new AppError('plan_read_only', 'The account’s subscription is read-only', { upgrade: true }));
  // 3. The plan's features: the surface's always; the tool's for changes (what exists stays readable).
  const features = [
    SURFACE_FEATURE[g.surface],
    ...(change ? await toolFeatures(deps, g.actor, g.tool.name, g.input) : []),
  ];
  for (const f of new Set(features)) if (!(await hasFeature(deps.db, accountId, f))) refuse(featureError(f));
  // 4. The shared change rate.
  if (!change || g.count === false) return;
  const ai = g.ai ?? (await loadAiSettings(deps.db, accountId));
  const scopes: [string, number][] = [
    [`account:${accountId}`, ai.account_write_rate_per_minute],
    [`user:${accountId}:${g.actor.user.id}`, ai.write_rate_per_minute],
    ...(g.actor.agent ? [[`agent:${g.actor.agent.id}`, ai.write_rate_per_minute] as [string, number]] : []),
    ...(g.rateKeys ?? []).map((k) => [`${k}`, ai.write_rate_per_minute] as [string, number]),
  ];
  const wait = Math.max(...scopes.map(([k, limit]) => aiWriteLimiter.waitFor(k, limit)));
  if (wait > 0)
    refuse(
      new AppError('rate_limited', 'Too many changes in a minute — wait and retry', { retry_after_ms: wait }),
      'ai_write_rate_limited',
    );
  for (const [k, limit] of scopes) aiWriteLimiter.take(k, limit);
};

/** The code a run / an action records for an error: the guard's reason, else the error's code. */
export const refusalReason = (err: unknown) =>
  err instanceof ToolGuardError ? err.reason : err instanceof AppError ? err.code : 'internal';
