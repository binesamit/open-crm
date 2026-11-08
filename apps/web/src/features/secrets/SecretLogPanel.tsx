// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type DateRange, type MyAccount, SECRET_LOG_ACTIONS, type SecretLogPage, t, tDynamic } from '@bines/shared';
import { Button, Calendar, cn, EmptyState, formatIsoDate, Notice, Picker, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { useReadableBoards } from '../board/board-api';
import { Popover } from '../board/cells/Popover';
import { Actor, Ago, TD, TH, TR, useNarrow } from '../trash/TrashPage';
import { useAdminMembers } from '../admin/users/users-api';
import { Panel } from '../admin/admin-parts';

const PAGE_SIZE = 25;

/**
 * Administration → Security: the secret columns' log — who revealed, copied, set or cleared which
 * secret and when, the two-factor checks and the "many reveals" alerts. Filters: person, board, action, dates.
 * Never shows a value (the server never logs one).
 */
export const SecretLogPanel = ({ account }: { account: MyAccount }) => {
  const narrow = useNarrow();
  const [now] = useState(() => Date.now());
  const members = useAdminMembers(account.id);
  const boards = useReadableBoards(account.id);
  const [actor, setActor] = useState('');
  const [board, setBoard] = useState('');
  const [action, setAction] = useState('');
  const [range, setRange] = useState<DateRange>({ from: null, to: null });
  const [calendar, setCalendar] = useState(false);
  const [page, setPage] = useState(1);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (actor) p.set('actor_id', actor);
    if (board) p.set('board_id', board);
    if (action) p.set('action', action);
    if (range.from) p.set('from', range.from);
    if (range.to ?? range.from) p.set('to', (range.to ?? range.from)!);
    p.set('page', String(page));
    p.set('page_size', String(PAGE_SIZE));
    return p.toString();
  }, [actor, board, action, range, page]);
  const log = useQuery({
    queryKey: ['account', account.id, 'secrets-log', query],
    queryFn: () => api(account.id).get<SecretLogPage>(`/secrets/log?${query}`),
  });
  const data = log.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = !!(actor || board || action || range.from);
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };
  const actionLabel = (a: string) => tDynamic(`secret.log.action.${a}`);
  const rangeLabel = range.from
    ? range.to && range.to !== range.from
      ? `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`
      : formatIsoDate(range.from)
    : t('a45.audit.anyDate');
  const what = (e: SecretLogPage['data'][number]) =>
    // A secret update has no column: the row says it was an update.
    [e.board_name, e.item_name, e.update_id ? t('secretUpdates.log.what') : e.column_title]
      .filter(Boolean)
      .join(' › ') || '—';

  return (
    <Panel title={t('secret.log.title')} hint={t('secret.log.hint')} testId="secret-log">
      <div className="flex flex-col gap-3 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Picker
            label={t('a45.audit.filter.actor')}
            testId="secret-log-actor"
            value={actor}
            onChange={(v) => reset(() => setActor(v))}
            className="h-9 w-[180px] max-md:flex-1"
            options={[
              { value: '', label: t('a45.audit.filter.anyone') },
              ...(members.data?.data ?? []).map((m) => ({ value: m.user_id, label: m.name || m.email })),
            ]}
          />
          <Picker
            label={t('secret.log.filter.board')}
            testId="secret-log-board"
            value={board}
            onChange={(v) => reset(() => setBoard(v))}
            className="h-9 w-[180px] max-md:flex-1"
            options={[
              { value: '', label: t('secret.log.filter.anyBoard') },
              ...(boards.data?.data ?? []).map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
          <Picker
            label={t('secret.log.filter.action')}
            testId="secret-log-action"
            value={action}
            onChange={(v) => reset(() => setAction(v))}
            className="h-9 w-[160px] max-md:flex-1"
            options={[
              { value: '', label: t('secret.log.filter.anyAction') },
              ...SECRET_LOG_ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })),
            ]}
          />
          <span className="relative flex items-center max-md:w-full">
            <button
              type="button"
              onClick={() => setCalendar((v) => !v)}
              data-testid="secret-log-dates"
              aria-label={t('a45.audit.filter.dates')}
              className="flex h-9 min-w-[170px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary max-md:flex-1"
            >
              <Icon name="calendar" size={15} className="shrink-0 text-muted" />
              <span className={cn('truncate', !range.from && 'text-muted')}>{rangeLabel}</span>
            </button>
            <Popover open={calendar} onClose={() => setCalendar(false)} className="p-2">
              <Calendar
                mode="range"
                value={range}
                onChange={(v) =>
                  reset(() => {
                    setRange(v);
                    if (v.from && v.to) setCalendar(false);
                  })
                }
              />
            </Popover>
          </span>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="secret-log-clear"
              onClick={() =>
                reset(() => {
                  setActor('');
                  setBoard('');
                  setAction('');
                  setRange({ from: null, to: null });
                })
              }
            >
              <Icon name="x" size={14} />
              {t('a45.audit.filter.clear')}
            </Button>
          ) : null}
          <span className="ms-auto text-xs text-muted" data-testid="secret-log-count">
            {data ? t('a45.audit.count', { n: data.total }) : null}
          </span>
        </div>

        {log.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
        {log.isError ? <Notice tone="error">{errorMessage(log.error)}</Notice> : null}
        {data && !data.data.length ? (
          <EmptyState
            icon={<Icon name="key" size={28} />}
            title={filtered ? t('a45.audit.emptyFiltered') : t('secret.log.empty')}
            testId="secret-log-empty"
          />
        ) : null}

        {data?.data.length && narrow ? (
          <ul className="overflow-hidden rounded-[14px] border border-line">
            {data.data.map((e) => (
              <li
                key={e.id}
                data-testid="secret-log-row"
                data-action={e.action}
                className="flex flex-col gap-1 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-fg">{actionLabel(e.action)}</span>
                  <span className="shrink-0 text-[0.6875rem] text-muted">
                    <Ago iso={e.created_at} now={now} />
                  </span>
                </span>
                <span className="truncate text-xs text-fg-2">
                  <bdi>{e.actor_name ?? '—'}</bdi>
                  {' → '}
                  <bdi>{what(e)}</bdi>
                </span>
              </li>
            ))}
          </ul>
        ) : data?.data.length ? (
          <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH}>{t('a45.audit.col.when')}</th>
                  <th className={TH}>{t('a45.audit.col.actor')}</th>
                  <th className={TH}>{t('secret.log.col.action')}</th>
                  <th className={TH}>{t('secret.log.col.what')}</th>
                  <th className={TH}>{t('a45.audit.col.ip')}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((e) => (
                  <tr
                    key={e.id}
                    className={cn(TR, 'hover:bg-row-alt')}
                    data-testid="secret-log-row"
                    data-action={e.action}
                  >
                    <td className={cn(TD, 'text-fg-2')}>
                      <Ago iso={e.created_at} now={now} />
                    </td>
                    <td className={cn(TD, 'max-w-[200px]')}>
                      <Actor label={e.actor_name ?? '—'} />
                    </td>
                    <td className={TD}>
                      <span className="font-semibold text-fg">{actionLabel(e.action)}</span>
                      {e.via_token ? (
                        <span className="ms-1.5 text-xs text-muted">{t('secret.log.viaToken')}</span>
                      ) : null}
                    </td>
                    <td className={cn(TD, 'max-w-[320px] truncate text-fg-2')}>
                      <bdi>{what(e)}</bdi>
                    </td>
                    <td className={cn(TD, 'text-xs text-muted')}>
                      <bdi dir="ltr">{e.ip ?? '—'}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {data && pages > 1 ? (
          <nav className="flex items-center justify-center gap-2" aria-label={t('a45.audit.pages')}>
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              data-testid="secret-log-prev"
            >
              {t('a45.audit.prev')}
            </Button>
            <span className="text-xs text-muted">{t('a45.audit.page', { page, pages })}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              data-testid="secret-log-next"
            >
              {t('a45.audit.next')}
            </Button>
          </nav>
        ) : null}
      </div>
    </Panel>
  );
};
