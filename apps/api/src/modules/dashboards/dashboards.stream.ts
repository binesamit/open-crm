// SPDX-License-Identifier: AGPL-3.0-only
import { STREAM_RESYNC, UPDATE_SEEN } from '@bines/shared';
import type { Db } from '../../db/client';
import type { BusEvent } from '../../lib/realtime';
import { stillInAccount } from '../support/support.access';
import { readableBoardIds } from '../boards/boards.access';
import { findSubBoard } from '../boards/boards.repo';
import type { StreamFilter } from '../realtime/realtime.service';
import { loadDashboardAccess } from './dashboards.access';
import { eventDashboardId, listWidgets } from './dashboards.repo';
import { dashboardBoardIds } from './dashboards.service';
import type { Actor } from '../../types';

/**
 * Dashboard channel (`GET /dashboards/:id/events`, M8 ד4): "something changed — refetch the widgets". It hears
 * the dashboard's own events (widgets, layout, sources, sharing — losing access closes it) and every event of its
 * source boards and their sub-boards. What it sends carries the board only — never the item, column or actor,
 * so a viewer who may not see an item learns nothing about it; the widgets refetch through the API, which filters.
 * A gap is never replayed: `resync` makes the client refetch everything.
 */
export const dashboardStream = async (db: Db, a: Actor, dashboardId: string): Promise<StreamFilter> => {
  let boards = new Set<string>();
  const load = async () => {
    const access = await loadDashboardAccess(db, a.ctx, a.user, dashboardId); // 404 when not seen
    // S-37: only boards this viewer may read — the timing and type of activity on a private board is not theirs.
    const all = dashboardBoardIds(access.dashboard, await listWidgets(db, dashboardId));
    const readable = await readableBoardIds(db, a.ctx, a.user, all);
    const ids = all.filter((id) => readable.has(id));
    const next = new Set(ids);
    for (const id of ids) {
      const sub = await findSubBoard(db, id);
      if (sub) next.add(sub.id);
    }
    boards = next;
  };
  await load();

  return {
    accept: async (e: BusEvent) => {
      if (e.user_id || e.type === UPDATE_SEEN) return 'skip'; // r16seen: who saw an update changes no widget
      if (e.type.startsWith('dashboard.')) {
        if ((await eventDashboardId(db, e.id)) !== dashboardId) return 'skip';
        try {
          await load();
        } catch {
          return 'close';
        }
        return 'send';
      }
      if (e.type.startsWith('team.') || e.type.startsWith('workspace.') || e.type.startsWith('board.')) {
        // Who may read which board may have changed: check again (a board event of a source still goes out).
        try {
          await load();
        } catch {
          return 'close';
        }
        if (e.type.startsWith('team.')) return 'send';
      }
      return e.board_id && boards.has(e.board_id) ? 'send' : 'skip';
    },
    map: (e) => ({ id: e.id, account_id: e.account_id, type: e.type, board_id: e.board_id ?? null }),
    replay: async () => STREAM_RESYNC,
    stillAllowed: async () => stillInAccount(db, a.ctx.accountId, a.user.id),
  };
};
