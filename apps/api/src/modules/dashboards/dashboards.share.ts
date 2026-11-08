// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type DashboardLevel, type inviteToDashboardSchema, isId, newId } from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AppDeps, Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { readableBoardIds } from '../boards/boards.access';
import { boardsByIds } from '../boards/boards.repo';
import { inviteNewPeople } from '../invitations/invitations.service';
import { auditGuestShare, type CanOpen, notifyShared } from '../sharing/sharing';
import { assertDashboard, loadDashboardAccess } from './dashboards.access';
import { insertDashboardMembers, listDashboardMembers } from './dashboards.repo';

/** The dashboards module's loader as a yes / no (a notification only reaches who can open the dashboard now). */
export const canOpenDashboard =
  (dashboardId: string): CanOpen =>
  async (db, ctx, user) => {
    try {
      await loadDashboardAccess(db, ctx, user, dashboardId);
      return true;
    } catch {
      return false;
    }
  };

// --- a guest never learns about boards they may not read ----
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every id-looking string and record key in a settings tree (board ids live in arrays, values and `keys` maps). */
const collectIds = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') {
    if (isId(v)) out.add(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collectIds(x, out);
  } else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (isId(k)) out.add(k);
      collectIds(x, out);
    }
  }
};

/**
 * The boards of the account that these settings name and the actor may not read. Only guests are scrubbed (a
 * dashboard shared outside the account must not tell its guests which other boards exist); account members keep
 * the full settings, as before.
 */
export const hiddenBoardsIn = async (db: Db, a: Actor, values: unknown[]): Promise<Set<string>> => {
  if (a.ctx.role !== 'guest') return new Set();
  const ids = new Set<string>();
  for (const v of values) collectIds(v, ids);
  if (!ids.size) return new Set();
  const boards = await boardsByIds(db, a.ctx.accountId, [...ids]);
  const readable = await readableBoardIds(
    db,
    a.ctx,
    a.user,
    boards.map((b) => b.id),
  );
  return new Set(boards.filter((b) => !readable.has(b.id)).map((b) => b.id));
};

/** The settings without any trace of `hidden` boards: dropped from arrays and maps, a value naming one → null. */
export const scrubBoards = <T>(v: T, hidden: Set<string>): T => {
  if (!hidden.size) return v;
  if (typeof v === 'string') return (hidden.has(v) ? null : v) as T;
  if (Array.isArray(v))
    return v.filter((x) => !(typeof x === 'string' && hidden.has(x))).map((x) => scrubBoards(x, hidden)) as T;
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!hidden.has(k)) out[k] = scrubBoards(x, hidden);
    // A "board view" widget of a hidden board: its view (and the board's name in it) goes too.
    if (typeof v.board_id === 'string' && hidden.has(v.board_id) && 'view_id' in out) out.view_id = null;
    return out as T;
  }
  return v;
};

/**
 * A guest editor saves settings they only saw scrubbed: what named hidden boards in the saved version is kept, so
 * an edit by a guest never drops a source, a column choice or a filter of a board they cannot see.
 */
export const keepHiddenBoards = <T>(next: T, prev: unknown, hidden: Set<string>): T => {
  if (!hidden.size) return next;
  if (Array.isArray(next) && Array.isArray(prev)) {
    const lost = prev.filter((x) => typeof x === 'string' && hidden.has(x) && !next.includes(x));
    return [...next, ...lost] as T;
  }
  if (isObject(next) && isObject(prev)) {
    const out: Record<string, unknown> = { ...next };
    for (const [k, pv] of Object.entries(prev)) {
      if (hidden.has(k)) out[k] = pv;
      else if (k in out) out[k] = keepHiddenBoards(out[k], pv, hidden);
    }
    if (typeof prev.board_id === 'string' && hidden.has(prev.board_id) && (out.board_id ?? null) === null) {
      out.board_id = prev.board_id;
      if ('view_id' in prev) out.view_id = prev.view_id;
    }
    return out as T;
  }
  if ((next === null || next === undefined) && typeof prev === 'string' && hidden.has(prev)) return prev as T;
  return next;
};

// ---- invite ----
/**
 * POST /dashboards/:id/invite — share a dashboard by email (like a board's / doc's invite): people already in the
 * account join it at once at the chosen level (unless already invited); new people get an account invitation that
 * adds them when they accept. Guests only on a shareable dashboard, never as owners (an owner invite = editor).
 * Owners of the dashboard and admins (`dashboard.manage`); a guest never invites.
 */
export const inviteToDashboard = async (
  deps: Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>,
  a: Actor,
  dashboardId: string,
  input: z.infer<typeof inviteToDashboardSchema>,
) => {
  const { db } = deps;
  const access = await loadDashboardAccess(db, a.ctx, a.user, dashboardId);
  assertDashboard(access, 'dashboard.manage');
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'guest_restricted');
  const d = access.dashboard;
  if (input.role === 'guest' && d.kind !== 'shareable')
    throw new AppError('invalid_value', 'guest_needs_shareable_dashboard');

  const res = await inviteNewPeople(deps, a.ctx, a.user, {
    emails: input.emails,
    role: input.role,
    message: input.message,
    sendEmail: input.send_email,
    dashboardIds: [dashboardId],
    dashboardLevel: input.level,
  });
  const errors = [...res.errors];
  const added: { email: string; user_id: string; level: DashboardLevel; guest: boolean }[] = [];
  const already = new Set((await listDashboardMembers(db, dashboardId)).flatMap((m) => (m.userId ? [m.userId] : [])));
  const object = { type: 'dashboard' as const, id: d.id, name: d.name };
  await db.transaction(async (tx) => {
    for (const p of res.existing) {
      if (already.has(p.userId)) {
        errors.push({ email: p.email, code: 'already_member' });
        continue;
      }
      const guest = p.role === 'guest';
      if (guest && d.kind !== 'shareable') {
        errors.push({ email: p.email, code: 'guest_needs_shareable_dashboard' });
        continue;
      }
      const level: DashboardLevel = guest && input.level === 'owner' ? 'editor' : input.level;
      await insertDashboardMembers(tx, [
        { id: newId(), dashboardId, accountId: a.ctx.accountId, userId: p.userId, level, addedBy: a.user.id },
      ]);
      added.push({ email: p.email, user_id: p.userId, level, guest });
    }
    if (!added.length) return;
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'dashboard.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id: dashboardId, added: added.map((x) => ({ user_id: x.user_id, level: x.level })) },
      meta: { dashboard_id: dashboardId, access_changed: true },
    });
    await auditGuestShare(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      object,
      added: added.filter((x) => x.guest).map((x) => ({ userId: x.user_id, level: x.level })),
      via: 'invite',
    });
    await notifyShared(
      tx,
      a.ctx.account,
      object,
      a.user.id,
      added.map((x) => x.user_id),
      canOpenDashboard(dashboardId),
    );
  });
  return {
    invited: res.invited.map((i) => ({ email: i.email, ...(i.url ? { url: i.url } : {}) })),
    added: added.map(({ email, user_id }) => ({ email, user_id })),
    errors,
  };
};
