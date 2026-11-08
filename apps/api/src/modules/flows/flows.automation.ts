// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { FLOW_TRIGGER_TYPES, flowPagePath, type FlowRun, newId, type Recipe, recipeSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers, automations, type flowConnections } from '../../db/schema';
import { enqueueJob } from '../../lib/jobs';
import type { AppDeps } from '../../types';
import { findAccountById } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { assertFeature } from '../billing/entitlements';
import type { Actor } from '../items/items.service';
import { canView, findRow } from './flows.service';
import { webOrigin } from '../platform/public-address';

/**
 * Automations on external flows ("when an external flow fails, let an automation run — and the
 * notification opens the flow here"). Automations stay board-bound (the person picks the board when building one);
 * the dispatch is account-wide: the flow connections' failure check (flows.check) records one `flow.failed` /
 * `flow.recovered` activity event per board whose active automation listens, carrying the flow (`meta.flow` — the
 * `{flow.*}` texts and the link to our flows screen) and the automations whose owner may see that connection
 * (`meta.automation_ids`; anyone else's automation never hears it). The ordinary dispatcher takes it from there.
 */
type Row = typeof flowConnections.$inferSelect;
type FlowEventType = 'flow.failed' | 'flow.recovered';

/** `meta.flow` of a flow event: the link fields + what `{flow.<field>}` reads (FLOW_TEMPLATE_FIELDS). */
export type FlowEventInfo = {
  connection_id: string;
  flow_id: string | null;
  run_id: string | null;
  name: string;
  id: string;
  platform: string;
  connection: string;
  status: 'failed' | 'recovered';
  error: string;
  step: string;
  run_url: string;
  url: string;
  started_at: string;
};

/** Events one pass may record per connection (a storm of failures never floods the boards). */
export const MAX_FLOW_EVENTS_PER_PASS = 20;

type Listener = { id: string; boardId: string; ownerId: string | null; trigger: Recipe['trigger'] };

const isFlowTrigger = (t: Recipe['trigger']): t is Extract<Recipe['trigger'], { type: 'flow_failed' }> =>
  (FLOW_TRIGGER_TYPES as readonly string[]).includes(t.type);

/** Active automations of the account with a flow trigger of this type on this connection (or any). */
const listeners = async (db: Db, accountId: string, connectionId: string, type?: string): Promise<Listener[]> => {
  const rows = await db
    .select({
      id: automations.id,
      boardId: automations.boardId,
      ownerId: automations.ownerId,
      createdBy: automations.createdBy,
      recipe: automations.recipe,
    })
    .from(automations)
    .where(and(eq(automations.accountId, accountId), eq(automations.isActive, true), isNull(automations.deletedAt)));
  const out: Listener[] = [];
  for (const r of rows) {
    const parsed = recipeSchema.safeParse(r.recipe);
    if (!r.boardId || !parsed.success) continue;
    const t = parsed.data.trigger;
    if (!isFlowTrigger(t) || (type && t.type !== type)) continue;
    if (t.connection !== 'any' && t.connection !== connectionId) continue;
    out.push({ id: r.id, boardId: r.boardId, ownerId: r.ownerId ?? r.createdBy, trigger: t });
  }
  return out;
};

/** Does any active automation listen to this connection's flows (of this trigger type)? */
export const hasFlowListeners = async (db: Db, accountId: string, connectionId: string, type?: string) =>
  (await listeners(db, accountId, connectionId, type)).length > 0;

/** May the automation's owner see the connection (an admin, or a member of a connection opened to members)? */
const ownerMaySee = async (db: Db, row: Row, ownerId: string | null) => {
  if (!ownerId) return false;
  const m = (
    await db
      .select({ role: accountMembers.role, status: accountMembers.status })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, row.accountId), eq(accountMembers.userId, ownerId)))
      .limit(1)
  )[0];
  if (m?.status !== 'active') return false;
  return canView({ ctx: { role: m.role } } as Actor, row);
};

/** The event's flow, as `{flow.*}` and the bell read it. */
export const flowEventInfo = (
  row: Pick<Row, 'id' | 'name' | 'platform'>,
  r: FlowRun,
  status: 'failed' | 'recovered',
  link: { origin: string; slug: string },
  flowName?: string | null,
): FlowEventInfo => ({
  connection_id: row.id,
  flow_id: r.flow_id,
  run_id: r.id,
  name: r.flow_name ?? flowName ?? r.flow_id ?? row.name,
  id: r.flow_id ?? '',
  platform: row.platform,
  connection: row.name,
  status,
  error: status === 'failed' ? (r.error ?? '').slice(0, 1000) : '',
  step: status === 'failed' ? (r.error_node ?? '').slice(0, 200) : '',
  run_url: r.open_url ?? '',
  url: `${link.origin}${flowPagePath(link.slug, { connection_id: row.id, flow_id: r.flow_id, run_id: r.id })}`,
  started_at: r.started_at ?? '',
});

/** Where our flows screen lives for this account (`{flow.url}`). */
export const flowLinkBase = async (deps: Pick<AppDeps, 'db' | 'env'>, accountId: string) => ({
  origin: await webOrigin(deps),
  slug: (await findAccountById(deps.db, accountId))?.slug ?? '',
});

/**
 * One activity event per (flow event × listening board), each listing the automations there that may hear it.
 * Returns the events recorded.
 */
export const dispatchFlowEvents = async (
  deps: Pick<AppDeps, 'db'>,
  row: Row,
  type: FlowEventType,
  infos: FlowEventInfo[],
) => {
  if (!infos.length) return 0;
  const trigger = type === 'flow.failed' ? 'flow_failed' : 'flow_recovered';
  const heard = await listeners(deps.db, row.accountId, row.id, trigger);
  const byBoard = new Map<string, string[]>();
  for (const l of heard) {
    if (!(await ownerMaySee(deps.db, row, l.ownerId))) continue;
    byBoard.set(l.boardId, [...(byBoard.get(l.boardId) ?? []), l.id]);
  }
  if (!byBoard.size) return 0;
  let n = 0;
  for (const info of infos.slice(0, MAX_FLOW_EVENTS_PER_PASS))
    for (const [boardId, ids] of byBoard) {
      const eventId = await recordEvent(deps.db, {
        accountId: row.accountId,
        type,
        actorId: null,
        actorType: 'system',
        boardId,
        itemId: null,
        batchId: newId(),
        meta: { flow: info, automation_ids: ids },
      });
      // The activity trigger (0046) queues `automation.dispatch` for item / cell / update events only; a flow event
      // queues its own (audit 2026-10-10, automations #1). Tests, with no queue, dispatch by hand.
      await enqueueJob(deps.db, 'automation.dispatch', { event_id: eventId, account_id: row.accountId });
      n += 1;
    }
  return n;
};

/**
 * Save-time checks of a recipe with a flow trigger (automations.service): the plan has flows, and a chosen
 * connection is one the person may see (404-like: `flow_connection_not_found`).
 */
export const flowRecipeIssues = async (db: Db, a: Actor, recipe: Recipe) => {
  const t = recipe.trigger;
  if (!isFlowTrigger(t)) return [];
  await assertFeature(db, a.ctx.accountId, 'flows');
  if (t.connection === 'any') return [];
  const row = await findRow(db, a.ctx.accountId, t.connection);
  return row && canView(a, row)
    ? []
    : [{ path: 'trigger.connection', code: 'flow_connection_not_found', detail: t.connection }];
};
