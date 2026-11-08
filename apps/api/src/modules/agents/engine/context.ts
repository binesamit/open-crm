// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { AppError, canEditAllItems } from '@bines/shared';
import type { Db } from '../../../db/client';
import type { AccountContext, SessionUser } from '../../../types';
import { findAccountById, findMembership } from '../../accounts/accounts.repo';
import { loadBoardAccess, readableBoardIds } from '../../boards/boards.access';
import type { Actor } from '../../items/items.service';
import { findUserById } from '../../users/users.repo';
import { type AgentRow, agentBoardRows, findRunById, upsertAgentBoard } from '../agents.repo';
import { assertAccountOpen } from '../../billing/entitlements';

type AgentRunRow = NonNullable<Awaited<ReturnType<typeof findRunById>>>;

/** What every activity row written by an agent run carries (payload.meta.agent; the 0028 trigger stamps it). */
export type AgentScope = {
  agent_id: string;
  run_id: string;
  step: number;
  tool: string;
  /** The run's trigger-chain depth (מ8): what its writes trigger runs one deeper; past 5 nothing runs. */
  depth?: number;
};

const session = (user: NonNullable<Awaited<ReturnType<typeof findUserById>>>, service: boolean): SessionUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: !!user.emailVerified,
  isPlatformOwner: false,
  locale: user.locale,
  timezone: user.timezone,
  ...(service ? { isService: true } : {}),
});

/** The person who created the agent, as an actor — an agent never does more than they can (plan §3.3). */
export const creatorActor = async (db: Db, agent: AgentRow): Promise<Actor> => {
  if (!agent.createdBy) throw new AppError('forbidden', 'agent_creator_inactive');
  const [account, membership, user] = await Promise.all([
    findAccountById(db, agent.accountId),
    findMembership(db, agent.accountId, agent.createdBy),
    findUserById(db, agent.createdBy),
  ]);
  if (!account || !membership || membership.status !== 'active' || !user)
    throw new AppError('forbidden', 'agent_creator_inactive');
  if (membership.role === 'guest' || membership.role === 'viewer')
    throw new AppError('forbidden', 'agent_creator_cannot_edit');
  if (account.status === 'suspended') throw new AppError('account_suspended', 'Account is suspended');
  // plan-lock: a closed account runs nothing in the background (403 account_closed).
  await assertAccountOpen(db, account.id);
  return {
    ctx: { account, accountId: account.id, role: membership.role, membershipId: membership.id },
    user: session(user, false),
  };
};

/**
 * The boards the agent may touch now: its subscriptions ∩ what its creator can still read; a board its creator can
 * no longer edit (every item of — AI-RT1) drops to "view" for the agent (the subscription is lowered, so the services enforce it).
 */
export const effectiveAgentBoards = async (db: Db, agent: AgentRow, creator: Actor) => {
  const rows = await agentBoardRows(db, agent.accountId, agent.userId);
  const readable = await readableBoardIds(
    db,
    creator.ctx,
    creator.user,
    rows.map((r) => r.boardId),
  );
  const out: string[] = [];
  for (const r of rows) {
    if (!readable.has(r.boardId)) continue;
    out.push(r.boardId);
    if (r.level === 'contributor') {
      const access = await loadBoardAccess(db, creator.ctx, creator.user, r.boardId).catch(() => null);
      if (!access || !canEditAllItems(access.perm)) {
        await upsertAgentBoard(db, {
          accountId: agent.accountId,
          boardId: r.boardId,
          userId: agent.userId,
          level: 'viewer',
          addedBy: creator.user.id,
        });
      }
    }
  }
  return out;
};

type RunMeta = { guest?: boolean; untrusted_requester?: boolean; board_scope?: unknown };

/** A run started by a guest or by someone who may not edit the board (AI-RT10): its requester can't be trusted. */
export const isRestrictedRun = (run: Pick<AgentRunRow, 'meta'>) => {
  const meta = (run.meta ?? {}) as RunMeta;
  return !!(meta.guest || meta.untrusted_requester);
};

/** The boards a restricted run may read: the board it was started on (S-66); null = not restricted. */
export const restrictedRunBoards = (run: Pick<AgentRunRow, 'meta'>): string[] | null => {
  if (!isRestrictedRun(run)) return null;
  const scope = ((run.meta ?? {}) as RunMeta).board_scope;
  return Array.isArray(scope) ? scope.filter((x): x is string => typeof x === 'string') : [];
};

/**
 * The services act for an agent as its own service user (`users.is_service`, account role member) with a board
 * limit = its boards (the rest of the account does not exist for it — like a board-limited token, 06 §1.2). The
 * account comes from the agent row, never from the model (plan §8).
 */
export const agentActor = async (db: Db, agent: AgentRow, runId: string): Promise<Actor> => {
  const creator = await creatorActor(db, agent);
  const [membership, user] = await Promise.all([
    findMembership(db, agent.accountId, agent.userId),
    findUserById(db, agent.userId),
  ]);
  if (!membership || membership.status !== 'active' || !user) throw new AppError('forbidden', 'agent_user_inactive');
  let boardLimit = await effectiveAgentBoards(db, agent, creator);
  // S-66: a run that a guest or someone who may not edit the board started reads only that board — the agent's
  // other boards (and its creator's role) are not theirs to see through its answer.
  const run = await findRunById(db, runId);
  const scope = run ? restrictedRunBoards(run) : null;
  if (scope) boardLimit = boardLimit.filter((id) => scope.includes(id));
  const ctx: AccountContext = {
    account: creator.ctx.account,
    accountId: agent.accountId,
    role: membership.role,
    membershipId: membership.id,
    boardLimit,
  };
  return {
    ctx,
    user: session(user, true),
    requestId: `agent:${runId}`,
    agent: { id: agent.id, name: agent.name, runId },
  };
};

/**
 * Runs `fn` in a transaction whose activity rows are the agent's (migration 0028 trigger): actor_type agent,
 * batch = the run. A failing tool call rolls back whole.
 */
export const inAgentScope = <T>(db: Db, scope: AgentScope, fn: (tx: Db) => Promise<T>) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('bines.agent', ${JSON.stringify(scope)}, true)`);
    return fn(tx);
  });
