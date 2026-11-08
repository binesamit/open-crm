// SPDX-License-Identifier: AGPL-3.0-only
import { columnFitsRole, type ColumnRole, type DashboardColumns } from '@bines/shared';

/** Sensible first settings for a new widget from the sources' columns (all editable afterwards). */
export const widgetPreset = (type: string, columns: DashboardColumns | undefined): Record<string, unknown> => {
  const first = (role: ColumnRole) => {
    const c = columns?.columns.find((x) => columnFitsRole(x.type, role));
    return c ? { type: c.type, title: c.title } : null;
  };
  switch (type) {
    case 'battery':
      return { column: first('labels') };
    case 'chart':
      return first('labels') ? { x: { kind: 'column', column: first('labels'), date_unit: 'month' } } : {};
    case 'table':
      return {
        columns: (columns?.columns ?? [])
          .filter((c) => columnFitsRole(c.type, 'any'))
          .slice(0, 3)
          .map((c) => ({ type: c.type, title: c.title })),
      };
    case 'calendar':
    case 'timeline':
      return { date_column: first('date'), color_column: first('labels') };
    case 'workload':
      return { people_column: first('people'), split_column: first('labels') };
    case 'board_view':
      return { board_id: columns?.boards[0]?.id ?? null };
    default:
      return {};
  }
};
