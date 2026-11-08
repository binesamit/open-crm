// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACTIVITY_SYSTEM_ACTOR,
  type ActivityEntry,
  type DateRange,
  exactTime,
  he,
  type MessageKey,
  relativeTime,
  t,
} from '@bines/shared';
import {
  Avatar,
  Badge,
  Button,
  Calendar,
  cn,
  Dialog,
  EmptyState,
  formatIsoDate,
  Notice,
  Picker,
  SearchField,
  SkeletonRows,
} from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { undoAction } from '../../lib/undo';
import { ActivityChange, type ChangeCtx } from './ActivityChange';
import { type BoardDetail, useBoard, useMembers } from './board-api';
import { Popover } from './cells/Popover';

/** "X עדכן/ה את סטטוס" — the entry's own wording, or a generic one for types without it. */
export const describeActivity = (e: ActivityEntry, columnTitle: (key: string | null) => string) => {
  // A version the AI made from a person's request says so.
  const ai = e.type === 'file.version_added' && (e.after as { ai?: unknown } | null)?.ai === true;
  const k = ai ? 'activity.file.version_added_ai' : `activity.${e.type}`;
  return k in he ? t(k as MessageKey, { column: columnTitle(e.column_id) }) : t('activity.other', { type: e.type });
};

/**
 * One activity row (07 §12): who did what and when; "undo" while the viewer may (their action or they are an
 * admin, within 7 days); undone rows say so. A batch row (one action on many items) undoes them all.
 */
export const ActivityRow = ({
  accountId,
  entry: e,
  columnTitle,
  showItem,
  changeCtx,
}: {
  accountId: string;
  entry: ActivityEntry;
  columnTitle: (key: string | null) => string;
  /** On the board log: which item (or items) it was about. */
  showItem?: boolean;
  /** Columns / groups / people to show the value before → after (without it: the sentence only). */
  changeCtx?: ChangeCtx;
}) => {
  const qc = useQueryClient();
  // N17: relative time ("לפני 20 דק׳"), the exact time on hover. `now` is state (no Date.now() in render).
  const [now] = useState(() => Date.now());
  const member = useMembers(accountId).data?.data.find((m) => m.user_id === e.actor?.id);
  // A person shows their name (or email); the system / an automation (no actor, or an actor without a name) shows the bolt.
  const personName = e.actor ? e.actor.name || member?.name || member?.email || '' : '';
  return (
    <li
      className="flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
      data-testid="activity-entry"
      data-type={e.type}
      data-undone={e.undone || undefined}
    >
      {personName ? (
        <Avatar name={personName} url={member?.avatar_url} size={28} />
      ) : (
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-heading">
          <Icon name="bolt" size={15} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>
          <b className="font-bold text-fg">{personName || t('activity.system')}</b> {describeActivity(e, columnTitle)}
          {e.is_undo ? <span className="text-muted"> · {t('activity.isUndo')}</span> : null}
          {e.via?.kind === 'mcp' ? (
            <span className="text-muted" data-testid="activity-via-mcp">
              {' '}
              · {t('activity.viaMcp', { client: e.via.client ?? 'AI' })}
            </span>
          ) : e.via?.kind === 'app' ? (
            <span className="text-muted" data-testid="activity-via-app">
              {' '}
              · {t('activity.viaApp', { app: e.via.client ?? '' })}
            </span>
          ) : e.via?.kind === 'form' ? (
            <span className="text-muted" data-testid="activity-via-form">
              {' '}
              · {t('activity.viaForm', { form: e.via.client ?? '' })}
            </span>
          ) : null}
          {e.workflow_override ? (
            <span className="text-muted" data-testid="activity-workflow-override">
              {' '}
              · {t('workflow.activity.override')}
            </span>
          ) : null}
          {showItem && e.item_name ? (
            <span className="text-muted">
              {' '}
              · {e.count > 1 ? t('activity.batch', { n: e.count, names: e.item_name }) : e.item_name}
            </span>
          ) : null}
        </span>
        {changeCtx && e.count <= 1 ? <ActivityChange entry={e} ctx={changeCtx} /> : null}
        <time className="text-xs text-muted" dateTime={e.created_at} title={exactTime(e.created_at)}>
          {relativeTime(e.created_at, now)}
        </time>
      </span>
      {e.undone ? <Badge>{t('activity.undone')}</Badge> : null}
      {e.undoable ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="activity-undo"
          onClick={() => void undoAction(qc, accountId, e.id)}
        >
          {t('undo.action')}
        </Button>
      ) : null}
    </li>
  );
};

/** A key of the r15auto strings (merged into he/en.json later), else the fallback — never a raw key. */
const tr = (key: string, fallback: string, vars?: Record<string, string | number>) =>
  key in he ? t(key as MessageKey, vars) : fallback;

/** The event types the log filters by, in the order the menu shows them. */
export const ACTIVITY_FILTER_TYPES = [
  'cell.changed',
  'item.created',
  'item.renamed',
  'item.moved_to_group',
  'item.reordered',
  'item.duplicated',
  'item.moved_to_board',
  'item.archived',
  'item.deleted',
  'item.restored',
  'update.created',
  'update.replied',
  'update.edited',
  'update.deleted',
  'button.clicked',
  'column.type_changed',
] as const;

/** A type's name in the filter: its own label, else the row's wording ("updated {column}" → "updated a column"). */
const typeLabel = (type: string) =>
  tr(`activity.type.${type}`, `activity.${type}` in he ? t(`activity.${type}` as MessageKey, { column: '…' }) : type);

const SEARCH_DEBOUNCE_MS = 300;

/** The board log's filters: person, column, event type, days and free text — all server-side. */
type LogFilters = { actor: string; column: string; type: string; range: DateRange; q: string };
const NO_FILTERS: LogFilters = { actor: '', column: '', type: '', range: { from: null, to: null }, q: '' };

const filterQuery = (f: LogFilters) => {
  const p = new URLSearchParams();
  if (f.actor) p.set('actor_id', f.actor);
  if (f.column) p.set('column', f.column);
  if (f.type) p.set('type', f.type);
  if (f.range.from) p.set('from', f.range.from);
  if (f.range.to ?? f.range.from) p.set('to', (f.range.to ?? f.range.from)!);
  if (f.q.trim()) p.set('q', f.q.trim());
  return p;
};

/** The board's activity log (Ctrl+Shift+L): the board and its subitems, newest first, a page at a time, filterable. */
export const BoardActivityDialog = ({
  accountId,
  board,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  onClose: () => void;
}) => {
  const sub = useBoard(accountId, board.subitems_board_id ?? '').data;
  const members = useMembers(accountId).data?.data;
  const [filters, setFilters] = useState<LogFilters>(NO_FILTERS);
  const [text, setText] = useState('');
  const [calendar, setCalendar] = useState(false);
  // Typing settles before the server is asked.
  useEffect(() => {
    const id = window.setTimeout(() => setFilters((f) => (f.q === text ? f : { ...f, q: text })), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [text]);
  const query = filterQuery(filters).toString();
  const log = useInfiniteQuery({
    queryKey: ['account', accountId, 'board', board.id, 'activity', query],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(query);
      if (pageParam) p.set('before', pageParam);
      const qs = p.toString();
      return api(accountId).get<{ data: ActivityEntry[]; next_before: string | null }>(
        `/boards/${board.id}/activity${qs ? `?${qs}` : ''}`,
      );
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next_before ?? undefined,
    placeholderData: keepPreviousData,
  });
  const columns = useMemo(() => [...board.columns, ...(sub?.columns ?? [])], [board.columns, sub?.columns]);
  const changeCtx = useMemo<ChangeCtx>(
    () => ({ columns, groups: [...board.groups, ...(sub?.groups ?? [])], members: members ?? [] }),
    [columns, board.groups, sub?.groups, members],
  );
  const columnTitle = (key: string | null) => columns.find((c) => c.id === key)?.title ?? key ?? '';
  const entries = log.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = query !== '' || !!text.trim();
  const set = (patch: Partial<LogFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const rangeLabel = filters.range.from
    ? filters.range.to && filters.range.to !== filters.range.from
      ? `${formatIsoDate(filters.range.from)} – ${formatIsoDate(filters.range.to)}`
      : formatIsoDate(filters.range.from)
    : tr('activity.filter.anyDate', t('a45.audit.anyDate'));
  // A column once on both boards (a key shared by board and subitems) is offered once.
  const columnOptions = columns
    .filter((c, i) => c.type !== 'name' && columns.findIndex((x) => x.id === c.id) === i)
    .map((c) => ({ value: c.id, label: c.title }));

  return (
    <Dialog
      open
      title={t('activity.boardTitle', { name: board.name })}
      onClose={onClose}
      className="max-w-[760px]"
      footer={
        log.hasNextPage ? (
          <Button variant="secondary" busy={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {t('activity.more')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3.5" data-testid="board-activity">
        <div className="flex flex-col gap-2" data-testid="activity-filters">
          <SearchField
            value={text}
            onChange={setText}
            placeholder={tr('activity.filter.search', t('menu.search'))}
            testId="activity-filter-q"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Picker
              label={tr('activity.filter.person', t('a45.audit.filter.actor'))}
              testId="activity-filter-actor"
              value={filters.actor}
              onChange={(v) => set({ actor: v })}
              className="h-9 w-[170px] max-md:flex-1"
              options={[
                { value: '', label: tr('activity.filter.anyone', t('a45.audit.filter.anyone')) },
                { value: ACTIVITY_SYSTEM_ACTOR, label: t('activity.system'), testId: 'activity-filter-actor-system' },
                ...(members ?? [])
                  .filter((m) => m.status !== 'deactivated' || m.user_id === filters.actor)
                  .map((m) => ({ value: m.user_id, label: m.name || m.email, keywords: m.email })),
              ]}
            />
            <Picker
              label={tr('activity.filter.column', t('filter.column'))}
              testId="activity-filter-column"
              value={filters.column}
              onChange={(v) => set({ column: v })}
              className="h-9 w-[170px] max-md:flex-1"
              options={[{ value: '', label: tr('activity.filter.anyColumn', t('filter.column')) }, ...columnOptions]}
            />
            <Picker
              label={tr('activity.filter.type', t('a45.audit.filter.event'))}
              testId="activity-filter-type"
              value={filters.type}
              onChange={(v) => set({ type: v })}
              className="h-9 w-[190px] max-md:flex-1"
              options={[
                { value: '', label: tr('activity.filter.anyType', t('a45.audit.filter.anyEvent')) },
                ...ACTIVITY_FILTER_TYPES.map((x) => ({ value: x, label: typeLabel(x), testId: `activity-type-${x}` })),
              ]}
            />
            <span className="relative flex items-center max-md:w-full">
              <button
                type="button"
                onClick={() => setCalendar((v) => !v)}
                data-testid="activity-filter-dates"
                aria-label={tr('activity.filter.dates', t('a45.audit.filter.dates'))}
                className="flex h-9 min-w-[170px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary max-md:flex-1"
              >
                <Icon name="calendar" size={15} className="shrink-0 text-muted" />
                <span className={cn('truncate', !filters.range.from && 'text-muted')}>{rangeLabel}</span>
              </button>
              <Popover open={calendar} onClose={() => setCalendar(false)} className="p-2">
                <Calendar
                  mode="range"
                  value={filters.range}
                  onChange={(v) => {
                    set({ range: v });
                    if (v.from && v.to) setCalendar(false);
                  }}
                />
              </Popover>
            </span>
            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="activity-filter-clear"
                onClick={() => {
                  setText('');
                  setFilters(NO_FILTERS);
                }}
              >
                <Icon name="x" size={14} />
                {tr('activity.filter.clear', t('a45.audit.filter.clear'))}
              </Button>
            ) : null}
          </div>
        </div>
        {log.isPending ? <SkeletonRows rows={5} label={t('app.loading')} /> : null}
        {log.isError ? <Notice tone="error">{errorMessage(log.error)}</Notice> : null}
        {log.isSuccess && !entries.length ? (
          filtered ? (
            <EmptyState
              icon={<Icon name="filter" size={26} />}
              title={tr('activity.filter.empty', t('board.noResults'))}
              testId="activity-filter-empty"
            />
          ) : (
            <p className="text-sm text-muted">{t('item.noActivity')}</p>
          )
        ) : null}
        {entries.length ? (
          <ol
            className={cn('overflow-hidden rounded-[14px] border border-line', log.isPlaceholderData && 'opacity-60')}
          >
            {entries.map((e) => (
              <ActivityRow
                key={e.id}
                accountId={accountId}
                entry={e}
                columnTitle={columnTitle}
                showItem
                changeCtx={changeCtx}
              />
            ))}
          </ol>
        ) : null}
      </div>
    </Dialog>
  );
};
