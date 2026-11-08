// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { isAccountMember } from '../items/items.repo';
import {
  findTeam,
  findTeamByName,
  insertTeam,
  listTeamRows,
  setTeamMembers,
  teamMemberRows,
  updateTeamRow,
} from './teams.repo';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Teams (05 §7 `create_teams`: admins). Everyone but guests sees them — people filters, "assigned to me" and
 * board visibility count a user's teams. Membership is a plain list of account members.
 */
export const listTeams = async (db: Db, a: Actor) => {
  if (a.ctx.role === 'guest') return [];
  const [rows, members] = await Promise.all([listTeamRows(db, a.ctx.accountId), teamMemberRows(db, a.ctx.accountId)]);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    member_ids: members.filter((m) => m.teamId === t.id).map((m) => m.userId),
  }));
};

const teamDto = async (db: Db, a: Actor, id: string) => (await listTeams(db, a)).find((t) => t.id === id)!;

const assertMembers = async (db: Db, a: Actor, userIds: string[]) => {
  if (!(await isAccountMember(db, a.ctx.accountId, userIds))) throw new AppError('invalid_value', 'Unknown member');
};

export const createTeam = async (
  db: Db,
  a: Actor,
  input: { name: string; color?: string | null; member_ids?: string[] },
) => {
  assertAccountAdmin(a.ctx);
  if (await findTeamByName(db, a.ctx.accountId, input.name)) throw new AppError('conflict', 'team_name_taken');
  const ids = [...new Set(input.member_ids ?? [])];
  await assertMembers(db, a, ids);
  const id = newId();
  await db.transaction(async (tx) => {
    await insertTeam(tx, {
      id,
      accountId: a.ctx.accountId,
      name: input.name,
      color: input.color ?? null,
      createdBy: a.user.id,
    });
    await setTeamMembers(tx, a.ctx.accountId, id, ids);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'team.created',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id, name: input.name, member_ids: ids },
    });
  });
  return teamDto(db, a, id);
};

export const updateTeam = async (
  db: Db,
  a: Actor,
  id: string,
  input: { name?: string; color?: string | null; member_ids?: string[] },
) => {
  assertAccountAdmin(a.ctx);
  const team = await findTeam(db, a.ctx.accountId, id);
  if (!team) throw new AppError('not_found', 'Team not found');
  if (input.name) {
    const clash = await findTeamByName(db, a.ctx.accountId, input.name);
    if (clash && clash.id !== id) throw new AppError('conflict', 'team_name_taken');
  }
  const ids = input.member_ids ? [...new Set(input.member_ids)] : undefined;
  if (ids) await assertMembers(db, a, ids);
  const before = await teamDto(db, a, id);
  await db.transaction(async (tx) => {
    if (input.name || input.color !== undefined) {
      await updateTeamRow(tx, id, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      });
    }
    if (ids) await setTeamMembers(tx, a.ctx.accountId, id, ids);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'team.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      before,
      after: { id, ...input },
    });
  });
  return teamDto(db, a, id);
};

export const deleteTeam = async (db: Db, a: Actor, id: string) => {
  assertAccountAdmin(a.ctx);
  const team = await findTeam(db, a.ctx.accountId, id);
  if (!team) throw new AppError('not_found', 'Team not found');
  await db.transaction(async (tx) => {
    await updateTeamRow(tx, id, { deletedAt: new Date() });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'team.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id, name: team.name },
    });
  });
};
