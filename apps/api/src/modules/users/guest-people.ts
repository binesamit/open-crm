// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { boardMembershipsOf, listBoardMembers, listBoardTeams } from '../boards/boards.repo';
import { cellsByItemIds, listBoardItems } from '../items/items.repo';
import { accountTeams } from '../items/query.repo';
import { boardVisibility, filterVisible } from '../items/visibility';
import { updateAuthorsOf } from '../updates/updates.repo';

/**
 * The people a guest may see (D22.7, 05 §6.3) — for tagging and people pickers. Per board shared with them:
 * when they see all its items, everyone subscribed to it (people and team members); when the board limits
 * their items (assigned or created), only the people on the items they see — creators, assignees and
 * whoever wrote updates there. Always themselves.
 */
export const guestPeople = async (db: Db, a: Actor) => {
  const out = new Set<string>([a.user.id]);
  const subscribed = [...new Set((await boardMembershipsOf(db, a.ctx.accountId, a.user.id)).map((m) => m.boardId))];
  const readable = await readableBoardIds(db, a.ctx, a.user, subscribed);
  const teams = await accountTeams(db, a.ctx.accountId);
  const membersOfTeam = (id: string) => teams.find((t) => t.id === id)?.member_ids ?? [];
  for (const boardId of readable) {
    const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
    const v = await boardVisibility(db, a, access);
    if (!v) {
      for (const m of await listBoardMembers(db, boardId)) out.add(m.userId);
      for (const t of await listBoardTeams(db, boardId)) for (const id of membersOfTeam(t.teamId)) out.add(id);
      continue;
    }
    const items = await filterVisible(db, v, await listBoardItems(db, boardId));
    const ids = items.map((i) => i.id);
    for (const i of items) if (i.createdBy) out.add(i.createdBy);
    for (const c of await cellsByItemIds(db, ids)) {
      const people = (c.value as { persons_and_teams?: { id: string; kind: string }[] }).persons_and_teams;
      for (const p of people ?? []) {
        if (p.kind === 'team') for (const id of membersOfTeam(p.id)) out.add(id);
        else out.add(p.id);
      }
    }
    for (const id of await updateAuthorsOf(db, ids)) out.add(id);
  }
  return out;
};
