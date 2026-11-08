// SPDX-License-Identifier: AGPL-3.0-only
import {
  boardChartData,
  chartRequestSchema,
  groupColorHex,
  readIds,
  resolveField,
  type ChartRequest,
  type QueryRow,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { listGroups } from '../boards/boards.repo';
import { accountEnv } from '../automations/engine/context';
import { principalNames } from '../dashboards/dashboards.repo';
import { accountTeams } from '../items/query.repo';
import { type Actor, visibleColumns } from '../items/items.service';
import { queryItems } from '../items/query.service';

/** Items one chart reads (like a dashboard widget's source board). */
export const CHART_ROWS = 5000;

/**
 * The Chart view's data on the server (M8 ד9) — for a windowed board, whose rows the browser never has all of.
 * The view's query through `queryItems` (access, `view_items`, column restrictions), then the same
 * `boardChartData` the browser runs on a loaded board.
 */
export const boardChart = async (db: Db, a: Actor, boardId: string, input: ChartRequest) => {
  const req = chartRequestSchema.parse(input);
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const columns = await visibleColumns(db, access);
  const env = {
    ...(await accountEnv(db, a.ctx.accountId)),
    columns: columns.map((c) => ({ id: c.key, type: c.type, settings: c.settings as Record<string, unknown> })),
    meId: a.user.id,
    teams: await accountTeams(db, a.ctx.accountId),
  };
  const res = await queryItems(db, a, boardId, { ...req.query, scope: 'parents' }, { limit: CHART_ROWS });
  const rows = res.data as QueryRow[];
  const groups = (await listGroups(db, boardId)).map((g) => ({
    id: g.id,
    title: g.title,
    color: groupColorHex(g.color, null),
  }));
  // People buckets show names.
  const peopleIds = new Set<string>();
  for (const dim of [req.chart.x, req.chart.series])
    if (dim?.kind === 'column') {
      try {
        const f = resolveField(dim.column_id, env);
        if (f.model === 'people') for (const r of rows) for (const id of readIds(r, f)) peopleIds.add(id);
      } catch {
        // a column that is gone: no buckets
      }
    }
  const names = await principalNames(db, a.ctx.accountId, [...peopleIds]);
  return {
    ...boardChartData(rows, req.chart, env, { groups, nameOf: (id) => names.get(id) }),
    items: rows.length,
    truncated: res.total > rows.length,
  };
};
