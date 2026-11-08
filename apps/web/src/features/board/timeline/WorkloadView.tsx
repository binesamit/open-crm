// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  addDays,
  aggregateWorkload,
  bucketCapacity,
  defaultCapacity,
  isWeekend,
  loadLevel,
  parseIso,
  readDateSpan,
  readIds,
  readNumber,
  startOfUnit,
  t,
  weekdayName,
  workloadBuckets,
  type LoadLevel,
  type QueryEnv,
  type Span,
  type ViewSettings,
  type WorkloadItem,
  type WorkloadSourceRow,
  workloadRowLabel,
  workloadSourceRows,
} from '@bines/shared';
import { Avatar, cn } from '@bines/ui';
import { type BoardDetail, type Item, type Member, useTeams } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { safeField } from '../toolbar/filter-model';
import { useOpenItem } from '../open-item';
import { Popover } from '../cells/Popover';
import { AxisControls } from './TimeAxis';
import { timelineDateColumn } from './TimelineChart';

/**
 * Workload (M8 ד8, D25): one row per person (or team) of a people column, a cell per day or week with the load —
 * items counted, or a number / time-estimate column spread over each item's working days — against the capacity
 * (the view's daily default, or the person's own). Over capacity shows in the danger colour; a click on a cell
 * lists its items.
 */

export const NO_PERSON = '__none__';
const DAYS_SHOWN = 28;
const WEEKS_SHOWN = 12;

/** People columns of a board. */
export const peopleColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => safeField(c.id, env)?.model === 'people');

/** Number columns (numbers, time estimates, number formulas) a workload can sum. */
export const effortColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return f?.source === 'column' && f.model === 'number';
  });

/**
 * Round 15: the sub-board's side of a workload — its own people, date and effort columns (the view's choice, else
 * the first that fits), resolved with the sub-board's columns.
 */
export const subWorkloadColumns = (
  subBoard: BoardDetail | undefined,
  env: QueryEnv,
  cfg: { sub_people_column_id?: string; sub_date_column_id?: string; sub_effort_column_id?: string },
) => {
  if (!subBoard) return null;
  const subEnv: QueryEnv = { ...env, columns: env.subitems ?? [] };
  const people = peopleColumns(subBoard, subEnv);
  const efforts = effortColumns(subBoard, subEnv);
  return {
    env: subEnv,
    people,
    efforts,
    person: people.find((c) => c.id === cfg.sub_people_column_id) ?? people[0],
    date: timelineDateColumn(subBoard, subEnv, cfg.sub_date_column_id),
    effort: efforts.find((c) => c.id === cfg.sub_effort_column_id) ?? efforts[0],
  };
};

const LEVEL_FILL: Record<LoadLevel, string> = {
  none: 'transparent',
  under: 'color-mix(in srgb, var(--ok) 55%, var(--surface))',
  full: 'var(--ok)',
  over: 'var(--danger)',
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export const WorkloadView = ({
  board,
  items,
  settings,
  env,
  members,
  update,
  onRange,
  subBoard,
  subItems,
}: {
  board: BoardDetail;
  items: Item[];
  settings: ViewSettings;
  env: QueryEnv;
  members: Member[];
  update: (fn: (s: ViewSettings) => ViewSettings) => void;
  onRange?: (columnId: string, first: string, last: string) => void;
  /** Round 15: the sub-board and its items, for a workload of subitems. */
  subBoard?: BoardDetail;
  subItems?: Item[];
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const open = useOpenItem(board.id);
  const teams = useTeams(accountId).data?.data;
  const cfg: NonNullable<ViewSettings['workload']> = settings.workload ?? {
    measure: 'count',
    unit: 'day',
    capacity_overrides: {},
    source: 'items',
  };
  const measure = cfg.measure ?? 'count';
  const unit = cfg.unit ?? 'day';
  const source = cfg.source ?? 'items';
  const readsItems = source !== 'subitems';
  const sub = source === 'items' ? null : subWorkloadColumns(subBoard, env, cfg);
  const people = peopleColumns(board, env);
  const peopleColumn = people.find((c) => c.id === cfg.people_column_id) ?? people[0];
  const dateColumn = timelineDateColumn(board, env, cfg.date_column_id);
  const efforts = effortColumns(board, env);
  const effortColumn = efforts.find((c) => c.id === cfg.effort_column_id) ?? efforts[0];
  const peopleField = peopleColumn ? safeField(peopleColumn.id, env) : null;
  const dateField = dateColumn ? safeField(dateColumn.id, env) : null;
  const effortField = measure === 'column' && effortColumn ? safeField(effortColumn.id, env) : null;
  const subPeopleField = sub?.person ? safeField(sub.person.id, sub.env) : null;
  const subDateField = sub?.date ? safeField(sub.date.id, sub.env) : null;
  const subEffortField = measure === 'column' && sub?.effort ? safeField(sub.effort.id, sub.env) : null;
  const perDay = cfg.capacity ?? defaultCapacity(measure);

  const [anchor, setAnchor] = useState(env.today);
  const range = useMemo<Span>(() => {
    const from = startOfUnit(anchor, 'week', env.firstDay);
    return { from, to: addDays(from, unit === 'day' ? DAYS_SHOWN - 1 : WEEKS_SHOWN * 7 - 1) };
  }, [anchor, unit, env.firstDay]);
  const columnId = readsItems ? dateColumn?.id : undefined;
  useEffect(() => {
    if (onRange && columnId) onRange(columnId, range.from, range.to);
  }, [onRange, columnId, range.from, range.to]);

  const buckets = useMemo(() => workloadBuckets(range, unit, env.firstDay), [range, unit, env.firstDay]);
  // The rows read (round 15): the items, their subitems (under the items the view shows), or both.
  const rows = useMemo(() => workloadSourceRows(source, items, subItems ?? []), [source, items, subItems]);
  const byId = useMemo(() => new Map<string, WorkloadSourceRow<Item>>(rows.map((r) => [r.row.id, r])), [rows]);
  /** A row's people field: the board's column for an item, the sub-board's for a subitem. */
  const fieldsOf = useCallback(
    (r: WorkloadSourceRow<Item>) =>
      r.kind === 'item'
        ? { people: peopleField, date: dateField, effort: effortField }
        : { people: subPeopleField, date: subDateField, effort: subEffortField },
    [peopleField, dateField, effortField, subPeopleField, subDateField, subEffortField],
  );
  const grid = useMemo(() => {
    const list: WorkloadItem[] = [];
    for (const r of rows) {
      const f = fieldsOf(r);
      if (!f.people || !f.date) continue;
      const span = readDateSpan(r.row, f.date, env.timezone);
      const ids = readIds(r.row, f.people);
      list.push({
        id: r.row.id,
        people: ids.length ? ids : [NO_PERSON],
        span: span?.from && span.to ? { from: span.from, to: span.to } : null,
        effort: f.effort ? readNumber(r.row, f.effort) : null,
      });
    }
    return aggregateWorkload({
      items: list,
      measure,
      unit,
      range,
      weekend: env.weekend,
      firstDay: env.firstDay,
      calendar: env.calendar,
    });
  }, [rows, fieldsOf, measure, unit, range, env]);

  // Rows: everyone assigned on this board (also with no load in range), named; "unassigned" last.
  const names = useMemo(
    () =>
      new Map<string, { name: string; url: string | null }>([
        ...members.map((mb) => [mb.user_id, { name: mb.name || mb.email, url: mb.avatar_url }] as const),
        ...(teams ?? []).map((tm) => [tm.id, { name: tm.name, url: null }] as const),
      ]),
    [members, teams],
  );
  const rowIds = useMemo(() => {
    const ids = new Set<string>(grid.keys());
    for (const r of rows) {
      const f = fieldsOf(r).people;
      if (f) for (const id of readIds(r.row, f)) ids.add(id);
    }
    const list = [...ids].filter((id) => id !== NO_PERSON);
    list.sort((a, b) => (names.get(a)?.name ?? a).localeCompare(names.get(b)?.name ?? b));
    return grid.has(NO_PERSON) ? [...list, NO_PERSON] : list;
  }, [grid, rows, fieldsOf, names]);

  const [cell, setCell] = useState<{ person: string; bucket: string } | null>(null);

  const itemsReady = !!peopleColumn && !!dateColumn;
  const subReady = !!sub?.person && !!sub.date;
  const header = readsItems && peopleColumn ? peopleColumn : sub?.person;
  if (source === 'items' ? !itemsReady : source === 'subitems' ? !subReady : !itemsReady && !subReady)
    return (
      <p className="py-16 text-center text-sm text-muted" data-testid="workload-no-column">
        {t('workload.noColumn')}
      </p>
    );

  const step = unit === 'day' ? DAYS_SHOWN : WEEKS_SHOWN * 7;
  const cellWidth = unit === 'day' ? 46 : 84;
  const capacityOf = (person: string, bucket: string) =>
    bucketCapacity(
      bucket,
      unit,
      person === NO_PERSON ? perDay : (cfg.capacity_overrides?.[person] ?? perDay),
      env.weekend,
      env.calendar,
    );
  const bucketLabel = (b: string) => {
    if (unit === 'week') {
      const p = parseIso(b);
      return `${String(p.day).padStart(2, '0')}/${String(p.month + 1).padStart(2, '0')}`;
    }
    return `${weekdayName(b, 'narrow').replace(/[׳'"]/g, '')} ${parseIso(b).day}`;
  };

  return (
    <div
      className="flex min-w-0 flex-col"
      data-testid="workload"
      data-unit={unit}
      data-measure={measure}
      data-source={source}
    >
      <AxisControls
        zoom={unit}
        zooms={['day', 'week']}
        onZoom={(z) =>
          update((s) => ({
            ...s,
            workload: {
              measure: 'count',
              capacity_overrides: {},
              source: 'items',
              ...s.workload,
              unit: z === 'week' ? 'week' : 'day',
            },
          }))
        }
        onPrev={() => setAnchor((a) => addDays(a, -step))}
        onNext={() => setAnchor((a) => addDays(a, step))}
        onToday={() => setAnchor(env.today)}
      >
        <span className="ms-2 text-xs text-muted" data-testid="workload-capacity">
          {t('workload.capacityLine', { n: fmt(perDay) })}
        </span>
      </AxisControls>
      <div className="overflow-auto rounded-[14px] border border-line bg-surface" data-testid="workload-scroll">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th
                className="sticky start-0 top-0 z-20 min-w-[200px] border-e border-b border-line bg-surface-3 px-3 py-2 text-start text-xs font-semibold text-muted"
                scope="col"
              >
                {header?.title}
              </th>
              {buckets.map((b) => (
                <th
                  key={b}
                  scope="col"
                  data-testid="workload-bucket"
                  data-bucket={b}
                  className={cn(
                    'sticky top-0 z-10 border-b border-s border-line-soft bg-surface-3 px-1 py-2 text-center text-[0.6875rem] font-medium whitespace-nowrap text-muted tabular-nums',
                    unit === 'day' && isWeekend(b, env.weekend) && 'opacity-60',
                    (unit === 'day' ? b === env.today : b === startOfUnit(env.today, 'week', env.firstDay)) &&
                      'font-normal text-primary',
                  )}
                  style={{ minWidth: cellWidth }}
                >
                  {bucketLabel(b)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowIds.map((person) => {
              const who = person === NO_PERSON ? null : names.get(person);
              const row = grid.get(person);
              return (
                <tr key={person} data-testid="workload-row" data-person={person} data-name={who?.name ?? ''}>
                  <th
                    scope="row"
                    className="sticky start-0 z-10 border-e border-b border-line-soft bg-surface px-3 py-1.5 text-start font-normal"
                  >
                    <span className="flex items-center gap-2">
                      {who ? <Avatar name={who.name} url={who.url} size={24} /> : null}
                      <span className="truncate">{who?.name ?? t('workload.unassigned')}</span>
                      {person !== NO_PERSON && cfg.capacity_overrides?.[person] !== undefined ? (
                        <span className="ms-auto text-[0.6875rem] text-muted" data-tip={t('workload.ownCapacity')}>
                          {fmt(cfg.capacity_overrides[person]!)}
                        </span>
                      ) : null}
                    </span>
                  </th>
                  {buckets.map((b) => {
                    const c = row?.get(b);
                    const load = c?.load ?? 0;
                    const cap = capacityOf(person, b);
                    const level = person === NO_PERSON ? (load ? 'under' : 'none') : loadLevel(load, cap);
                    const pct = cap > 0 ? Math.min(1, load / cap) : load ? 1 : 0;
                    const isOpen = cell?.person === person && cell.bucket === b;
                    return (
                      <td
                        key={b}
                        data-testid="workload-cell"
                        data-bucket={b}
                        data-load={load}
                        data-capacity={cap}
                        data-level={level}
                        className={cn(
                          'relative h-11 border-b border-s border-line-soft p-1 align-bottom',
                          unit === 'day' && isWeekend(b, env.weekend) && 'bg-surface-3',
                          load > 0 && 'cursor-pointer hover:bg-surface-2',
                        )}
                        data-tip={
                          load
                            ? [
                                t('workload.cellTip', { load: fmt(load), capacity: fmt(cap) }),
                                // Round 15: what is behind the load — a subitem under its parent's name.
                                ...(c?.items ?? []).flatMap((id: string) => {
                                  const r = byId.get(id);
                                  return r ? [workloadRowLabel(r)] : [];
                                }),
                              ].join('\n')
                            : undefined
                        }
                        onClick={() => load > 0 && setCell({ person, bucket: b })}
                      >
                        {load > 0 ? (
                          <div className="relative h-full w-full overflow-hidden rounded-[6px] bg-surface-2">
                            <div
                              className="absolute inset-x-0 bottom-0"
                              style={{ height: `${Math.max(12, pct * 100)}%`, backgroundColor: LEVEL_FILL[level] }}
                            />
                            <span
                              className={cn(
                                'relative grid h-full place-items-center text-[0.6875rem] font-normal tabular-nums',
                                level === 'over' ? 'text-white' : 'text-heading',
                              )}
                            >
                              {fmt(load)}
                            </span>
                          </div>
                        ) : null}
                        <Popover open={isOpen} onClose={() => setCell(null)} className="w-64">
                          <div data-testid="workload-popover" className="flex flex-col gap-1">
                            <div className="px-1 pb-1 text-xs text-muted">
                              {who?.name ?? t('workload.unassigned')} · {bucketLabel(b)} ·{' '}
                              {t('workload.cellTip', { load: fmt(load), capacity: fmt(cap) })}
                            </div>
                            {(c?.items ?? []).map((id: string) => {
                              const r = byId.get(id);
                              return r ? (
                                <button
                                  key={id}
                                  type="button"
                                  data-testid="workload-item"
                                  data-item-name={r.row.name}
                                  data-kind={r.kind}
                                  data-parent-name={r.parent?.name}
                                  data-tip={workloadRowLabel(r)}
                                  onClick={() => {
                                    setCell(null);
                                    // A subitem opens over this board, like its row in the table.
                                    open(id);
                                  }}
                                  className="truncate rounded-[7px] px-2 py-1 text-start text-sm hover:bg-surface-2"
                                >
                                  {r.parent ? (
                                    <span className="text-muted" data-testid="workload-item-parent">
                                      {r.parent.name} ›{' '}
                                    </span>
                                  ) : null}
                                  {r.row.name}
                                </button>
                              ) : null;
                            })}
                          </div>
                        </Popover>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!rowIds.length ? (
              <tr>
                <td colSpan={buckets.length + 1} className="py-10 text-center text-sm text-muted">
                  {t('workload.empty')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
};
