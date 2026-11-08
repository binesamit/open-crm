// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { accountSettingsSchema, AppError, dateInZone, type CalendarConfig, type QueryEnv } from '@bines/shared';
import type { Db } from '../../../db/client';
import { accountCalendar } from '../../../lib/account-calendar';
import type { SessionUser } from '../../../types';
import { findAccountById, findMembership, getAccountSettings } from '../../accounts/accounts.repo';
import { findBoard, listColumns, type BoardRow, type ColumnRow } from '../../boards/boards.repo';
import { findItem, findItemEvenDeleted, type ItemRow } from '../../items/items.repo';
import { calculatorFor, itemDto, type Actor } from '../../items/items.service';
import { accountTeams } from '../../items/query.repo';
import { findUserById } from '../../users/users.repo';
import type { AutomationRow } from '../automations.repo';
import { assertAccountOpen } from '../../billing/entitlements';

/** What every activity row written by a run carries (payload.meta.automation; the DB trigger stamps it). */
export type RunScope = {
  /** null for a scenario's run (phase 3): its writes are stamped with `scenario_id` instead. */
  automation_id: string | null;
  scenario_id?: string;
  run_id: string;
  depth: number;
  chain: string[];
};

/**
 * The services act for the automation as its **owner**, with the owner's rights (04 §4.2: never silently as
 * admin). An owner who left the account (or none) cannot run anything.
 */
export const automationActor = async (db: Db, automation: AutomationRow, runId: string): Promise<Actor> => {
  const ownerId = automation.ownerId ?? automation.createdBy;
  if (!ownerId) throw new AppError('forbidden', 'automation_has_no_owner');
  const [account, membership, user] = await Promise.all([
    findAccountById(db, automation.accountId),
    findMembership(db, automation.accountId, ownerId),
    findUserById(db, ownerId),
  ]);
  if (!account || !membership || membership.status !== 'active' || !user)
    throw new AppError('forbidden', 'automation_owner_inactive');
  if (account.status === 'suspended') throw new AppError('account_suspended', 'Account is suspended');
  // plan-lock: a closed account runs nothing in the background (403 account_closed).
  await assertAccountOpen(db, account.id);
  const session: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerified,
    isPlatformOwner: false, // a background actor never opens the owner console (S-59)
    // The owner's profile; what a run writes is formatted in the account's region (lib/region `actorRegion`).
    locale: user.locale,
    timezone: user.timezone,
  };
  return {
    ctx: { account, accountId: account.id, role: membership.role, membershipId: membership.id },
    user: session,
    requestId: `run:${runId}`,
    automation: { id: automation.id, title: automation.title, runId },
  };
};

/**
 * Another member acting inside the automation's run (a timer action's `who`): their own role and
 * rights, the run's attribution. `skip` = why they cannot: not an active member, or a guest / viewer.
 */
export const memberActor = async (
  db: Db,
  base: Actor,
  userId: string,
): Promise<{ actor: Actor; skip?: undefined } | { actor?: undefined; skip: string }> => {
  if (userId === base.user.id) return { actor: base };
  const [membership, user] = await Promise.all([
    findMembership(db, base.ctx.accountId, userId),
    findUserById(db, userId),
  ]);
  if (!membership || membership.status !== 'active' || !user) return { skip: 'not_an_active_member' };
  if (membership.role === 'guest') return { skip: 'guest' };
  if (membership.role === 'viewer') return { skip: 'no_edit_rights' };
  return {
    actor: {
      ...base,
      ctx: { ...base.ctx, role: membership.role, membershipId: membership.id },
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: !!user.emailVerified,
        isPlatformOwner: false, // a background actor never opens the owner console (S-59)
        locale: user.locale,
        timezone: user.timezone,
      },
    },
  };
};

/**
 * Runs `fn` in a transaction whose activity rows are the automation's (migration 0017 trigger). Services called
 * with this `tx` open savepoints inside it, so the setting covers everything they write.
 */
export const inRunScope = <T>(db: Db, scope: RunScope, fn: (tx: Db) => Promise<T>) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('bines.automation', ${JSON.stringify(scope)}, true)`);
    return fn(tx);
  });

export type AccountEnv = {
  timezone: string;
  weekend: 'fri_sat' | 'sat_sun';
  firstDay: number;
  today: string;
  /** The account calendar: working days skip its holidays and days off. */
  calendar: CalendarConfig;
};

export const accountEnv = async (db: Db, accountId: string, now = new Date()): Promise<AccountEnv> => {
  const settings = accountSettingsSchema.parse(await getAccountSettings(db, accountId));
  const locale = settings.locale;
  return {
    timezone: locale.timezone,
    weekend: locale.weekend,
    firstDay: locale.first_day,
    today: dateInZone(now, locale.timezone),
    calendar: await accountCalendar(db, accountId, settings),
  };
};

export const queryEnvOf = async (
  db: Db,
  accountId: string,
  columns: ColumnRow[],
  env: AccountEnv,
): Promise<QueryEnv> => ({
  ...env,
  columns: columns.map((c) => ({ id: c.key, type: c.type, settings: c.settings as Record<string, unknown> })),
  meId: null,
  teams: await accountTeams(db, accountId),
});

export type ItemSnapshot = ReturnType<typeof itemDto>;

/** A fresh item with every cell computed, as the owner sees it (04 §5.3 step 3); null = gone. */
export type Snapshot = { row: ItemRow; item: ItemSnapshot; board: BoardRow; columns: ColumnRow[] };

export const loadSnapshot = async (
  db: Db,
  a: Actor,
  itemId: string,
  /** `gone`: a trashed item is loaded too (an `item_deleted` run keeps the item's name and cells). */
  opts: { gone?: boolean } = {},
): Promise<Snapshot | null> => {
  const row = opts.gone
    ? await findItemEvenDeleted(db, a.ctx.accountId, itemId)
    : await findItem(db, a.ctx.accountId, itemId);
  if (!row) return null;
  const board = await findBoard(db, a.ctx.accountId, row.boardId);
  if (!board) return null;
  const columns = await listColumns(db, board.id);
  const calc = await calculatorFor(db, a, [itemId]);
  return { row, item: itemDto(calc, row, columns), board, columns };
};
