// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { AppError } from '@bines/shared';
import type { Db } from '../../db/client';
import type { SessionUser } from '../../types';
import { findAccountById, findMembership } from '../accounts/accounts.repo';
import type { Actor } from '../items/items.service';
import { findUserById } from '../users/users.repo';
import { assertAccountOpen } from '../billing/entitlements';

/**
 * What every activity row of an AI write carries (payload.meta.ai — migration 0038 trigger). `batch_id` makes a
 * whole column run, or every action approved together in the assistant, one undoable action.
 */
export type AiScope = {
  source: 'column' | 'assistant';
  batch_id: string;
  column_id?: string;
  run_id?: string;
  conversation_id?: string;
  message_id?: string;
  /** approved in a chat with this agent (it proposed; the person approved and it ran as them). */
  agent_id?: string;
};

/** Runs `fn` in a transaction whose activity rows are marked as AI writes of the person (and batched). */
export const inAiScope = <T>(db: Db, scope: AiScope, fn: (tx: Db) => Promise<T>) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('bines.ai', ${JSON.stringify(scope)}, true)`);
    return fn(tx);
  });

/**
 * A person as an actor outside a request (a queued column run, an auto-run): their membership as it is now — a
 * person who left the account, or a suspended account, runs nothing. `via` (S-64): the run was asked through an API
 * token / MCP connection — it keeps that token's board limit (only those boards and their sub-boards exist) and
 * its scopes.
 */
export const personActor = async (
  db: Db,
  accountId: string,
  userId: string,
  requestId: string,
  via: { boardLimit?: string[] | null; tokenScopes?: string[] | null } = {},
): Promise<Actor> => {
  const [account, membership, user] = await Promise.all([
    findAccountById(db, accountId),
    findMembership(db, accountId, userId),
    findUserById(db, userId),
  ]);
  if (!account || !membership || membership.status !== 'active' || !user)
    throw new AppError('forbidden', 'ai_actor_inactive');
  if (account.status === 'suspended') throw new AppError('account_suspended', 'Account is suspended');
  // plan-lock: a closed account runs nothing in the background (403 account_closed).
  await assertAccountOpen(db, account.id);
  const session: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerified,
    isPlatformOwner: false, // a background actor never opens the owner console (S-59)
    locale: user.locale,
    timezone: user.timezone,
  };
  return {
    ctx: {
      account,
      accountId: account.id,
      role: membership.role,
      membershipId: membership.id,
      boardLimit: via.boardLimit ?? null,
      tokenScopes: via.tokenScopes ?? null,
    },
    user: session,
    requestId,
  };
};
