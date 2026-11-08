// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  AppError,
  newId,
  type OpsBoards,
  type OpsTaskType,
  type OpsTaskTypeDto,
  type OpsTaskTypeInput,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { supportAgentRuns } from '../../db/schema';
import { accounts, boards, groups, supportAgentActions } from '../../db/schema';
import { st } from '../../lib/i18n';
import type { AccountContext, AppDeps, SessionUser } from '../../types';
import { findAccountById, findMembership } from '../accounts/accounts.repo';
import { assertAccountOpen } from '../billing/entitlements';
import { readableBoardIds } from '../boards/boards.access';
import { listAccountBoards, listGroups, listWorkspaces } from '../boards/boards.repo';
import { createItem } from '../items/items.service';
import { webOrigin } from '../platform/public-address';
import { insertMessage } from '../tickets/tickets.repo';
import { createUpdate } from '../updates/updates.service';
import { findUserById } from '../users/users.repo';
import { ticketOfRun } from './tools';

/**
 * Ops tasks: the support agent proposes a task for the operations team; a person approves it and the
 * task opens on the board its type names — as that person, through the same item services as the app (their access
 * to the account and the board decides, nothing is bypassed). The types are settings, never hard-coded.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger'>;
type RunRow = typeof supportAgentRuns.$inferSelect;

/** A person as a member of an account (active only), for the item services. */
const memberIn = async (db: Db, userId: string, accountId: string, admin = false) => {
  const [account, membership, user] = await Promise.all([
    findAccountById(db, accountId),
    findMembership(db, accountId, userId),
    findUserById(db, userId),
  ]);
  if (!account || account.deletedAt || !user) throw new AppError('not_found', 'Account not found');
  if (membership?.status !== 'active' || (admin && membership.role !== 'admin'))
    throw new AppError('forbidden', admin ? 'support_agent_ops_needs_admin' : 'support_agent_ops_not_member');
  const ctx: AccountContext = {
    account,
    accountId,
    role: membership.role,
    membershipId: membership.id,
    boardLimit: null,
  };
  const session: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerified,
    isPlatformOwner: false, // acts as a member of the account, like anyone there
    locale: user.locale,
    timezone: user.timezone,
  };
  return { ctx, user: session };
};

/** GET /platform/support-agent/ops-boards — the top-level boards I can read in an account where I am an admin. */
export const opsBoards = async (db: Db, userId: string, accountId: string): Promise<OpsBoards> => {
  const a = await memberIn(db, userId, accountId, true);
  const all = (await listAccountBoards(db, accountId)).filter((b) => !b.parentBoardId);
  const readable = await readableBoardIds(
    db,
    a.ctx,
    a.user,
    all.map((b) => b.id),
  );
  const ws = new Map((await listWorkspaces(db, accountId)).map((w) => [w.id, w.name]));
  const mine = all.filter((b) => readable.has(b.id));
  return {
    data: await Promise.all(
      mine.map(async (b) => ({
        id: b.id,
        name: b.name,
        workspace: ws.get(b.workspaceId) ?? '',
        groups: (await listGroups(db, b.id)).map((g) => ({ id: g.id, name: g.title })),
      })),
    ),
  };
};

/**
 * The types as saved: each board readable by this person in an account where they are an admin (so nobody points
 * the agent at a board they could not open), the group on that board, exactly one default.
 */
export const normalizeOpsTypes = async (
  db: Db,
  userId: string,
  cur: OpsTaskType[],
  input: OpsTaskTypeInput[],
): Promise<OpsTaskType[]> => {
  const out: OpsTaskType[] = [];
  const boardsOf = new Map<string, OpsBoards>();
  for (const t of input) {
    const old = t.id ? cur.find((c) => c.id === t.id) : undefined;
    // An unchanged place may stay even when this person is not an admin there (another lead set it).
    const samePlace =
      old && old.account_id === t.account_id && old.board_id === t.board_id && old.group_id === (t.group_id ?? null);
    if (!samePlace) {
      if (!boardsOf.has(t.account_id)) boardsOf.set(t.account_id, await opsBoards(db, userId, t.account_id));
      const board = boardsOf.get(t.account_id)!.data.find((b) => b.id === t.board_id);
      if (!board) throw new AppError('invalid_value', 'support_agent_ops_board');
      if (t.group_id && !board.groups.some((g) => g.id === t.group_id))
        throw new AppError('invalid_value', 'support_agent_ops_group');
    }
    out.push({
      id: old?.id ?? newId(),
      name: t.name,
      hint: t.hint ?? old?.hint ?? '',
      account_id: t.account_id,
      board_id: t.board_id,
      group_id: t.group_id ?? null,
      is_default: !!t.is_default,
    });
  }
  const names = out.map((t) => t.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new AppError('invalid_value', 'support_agent_ops_names');
  const firstDefault = out.findIndex((t) => t.is_default);
  return out.map((t, i) => ({ ...t, is_default: i === (firstDefault >= 0 ? firstDefault : 0) }));
};

/** The types with the names the console shows. */
export const opsTypesDto = async (db: Db, types: OpsTaskType[]): Promise<OpsTaskTypeDto[]> => {
  if (!types.length) return [];
  const [accs, bds, grs] = await Promise.all([
    db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(and(inArray(accounts.id, [...new Set(types.map((t) => t.account_id))]), isNull(accounts.deletedAt))),
    db
      .select({ id: boards.id, name: boards.name, accountId: boards.accountId })
      .from(boards)
      .where(
        and(
          inArray(
            boards.id,
            types.map((t) => t.board_id),
          ),
          isNull(boards.deletedAt),
        ),
      ),
    db
      .select({ id: groups.id, name: groups.title, boardId: groups.boardId })
      .from(groups)
      .where(
        and(
          inArray(groups.id, types.flatMap((t) => (t.group_id ? [t.group_id] : [])).concat([''])),
          isNull(groups.deletedAt),
        ),
      ),
  ]);
  return types.map((t) => {
    const acc = accs.find((a) => a.id === t.account_id);
    const board = bds.find((b) => b.id === t.board_id && b.accountId === t.account_id);
    const group = t.group_id ? grs.find((g) => g.id === t.group_id && g.boardId === t.board_id) : null;
    return {
      ...t,
      account_name: acc?.name ?? '',
      board_name: board?.name ?? '',
      group_name: group?.name ?? null,
      missing: !acc || !board || (!!t.group_id && !group),
    };
  });
};

/** The type a proposal names (by id or name), else the default. */
export const pickOpsType = (types: OpsTaskType[], want?: string | null) =>
  (want ? types.find((t) => t.id === want || t.name.toLowerCase() === want.toLowerCase()) : undefined) ??
  types.find((t) => t.is_default) ??
  types[0];

/** Where the console shows the run's error or ticket. */
export const consoleLink = async (deps: Pick<AppDeps, 'db' | 'env'>, run: RunRow) => {
  const origin = await webOrigin(deps);
  if (run.errorEventId) return `${origin}/owner?section=errors&error=${run.errorEventId}`;
  const ticketId = await ticketOfRun(deps.db, run);
  return ticketId ? `${origin}/owner?section=support&ticket=${ticketId}` : null;
};

export type OpsTaskResult = { item_id: string; url: string; account_id: string; board_id: string; type: string };

/**
 * Opens the task as the approving person: the item on the type's board (and group), then its description as the
 * item's first update — the agent's text, why, the link to the error / ticket and the PR when there is one.
 */
export const openOpsTask = async (
  deps: Deps,
  user: SessionUser,
  run: RunRow,
  type: OpsTaskType,
  task: { title: string; body: string; reason: string },
  locale: 'he' | 'en',
): Promise<OpsTaskResult> => {
  const a = await memberIn(deps.db, user.id, type.account_id);
  await assertAccountOpen(deps.db, type.account_id);
  const actor = { ...a, requestId: `support-agent:${run.id}` };
  const item = await createItem(deps.db, actor, type.board_id, {
    name: task.title,
    ...(type.group_id ? { group_id: type.group_id } : {}),
  });
  const link = await consoleLink(deps, run);
  const body = [
    task.body,
    '',
    `${st('supportAgent.ops.why', undefined, locale)}: ${task.reason}`,
    link ? `${st('supportAgent.ops.source', undefined, locale)}: ${link}` : null,
    run.devPrUrl ? `${st('supportAgent.ops.pr', undefined, locale)}: ${run.devPrUrl}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
  await createUpdate(deps.db, actor, item.id, { body });
  const url = `${await webOrigin(deps)}/a/${a.ctx.account.slug}/b/${type.board_id}/i/${item.id}`;
  const ticketId = await ticketOfRun(deps.db, run);
  if (ticketId)
    await insertMessage(deps.db, {
      ticketId,
      authorId: null,
      authorName: st('supportAgent.name', undefined, locale),
      kind: 'system',
      visibility: 'internal',
      body: `${st('supportAgent.ops.opened', { type: type.name }, locale)}\n${url}`,
    });
  return { item_id: item.id, url, account_id: type.account_id, board_id: type.board_id, type: type.name };
};

/** A draft PR opened after the task: its link on every task the run opened (as the person who approved each). */
export const notePrOnOpsTasks = async (deps: Deps, run: RunRow, locale: 'he' | 'en') => {
  if (!run.devPrUrl) return;
  const done = await deps.db
    .select()
    .from(supportAgentActions)
    .where(
      and(
        eq(supportAgentActions.runId, run.id),
        eq(supportAgentActions.kind, 'open_ops_task'),
        eq(supportAgentActions.status, 'approved'),
      ),
    );
  for (const act of done) {
    const task = (act.payload as { task?: OpsTaskResult }).task;
    if (!task || !act.decidedBy) continue;
    try {
      const a = await memberIn(deps.db, act.decidedBy, task.account_id);
      await createUpdate(deps.db, { ...a, requestId: `support-agent:${run.id}` }, task.item_id, {
        body: `${st('supportAgent.ops.pr', undefined, locale)}: ${run.devPrUrl}`,
      });
    } catch (err) {
      deps.logger.warn({ err, runId: run.id, itemId: task.item_id }, 'support agent: PR note on the ops task failed');
    }
  }
};
