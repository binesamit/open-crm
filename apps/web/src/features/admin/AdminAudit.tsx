// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { type AuditEntry, type DateRange, type MyAccount, t, tDynamic } from '@bines/shared';
import { Button, Calendar, cn, EmptyState, formatIsoDate, Notice, Picker, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { downloadFrom } from '../../lib/download';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Popover } from '../board/cells/Popover';
import { Actor, Ago, TD, TH, TR, useNarrow } from '../trash/TrashPage';
import { useAdminMembers } from './users/users-api';
import { useAudit } from './admin-a45-api';
import { SectionHeader } from './admin-parts';

const PAGE_SIZE = 50;

/** The event's name in words ("שינוי תפקיד"); an event without a label shows its key. */
export const eventLabel = (event: string) => {
  const key = `a45.audit.event.${event}`;
  const label = tDynamic(key);
  return label === key ? event : label;
};

/** A short line of what the row remembers (`before → after` for changes), the full JSON in the title. */
const summary = (e: AuditEntry) => {
  const d = e.details;
  const before = d.before as Record<string, unknown> | undefined;
  const after = d.after as Record<string, unknown> | undefined;
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    return Object.keys(after)
      .map((k) => `${k}: ${JSON.stringify(before[k] ?? null)} → ${JSON.stringify(after[k])}`)
      .join(' · ');
  }
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
};

/**
 * Administration → יומן ביקורת (08 §11, account admin A4): who did what and when in the account — sign-outs,
 * roles, deactivations, tokens, security and account settings, boards removed. Filters (person, event, days),
 * pages of 50 and a CSV of what is filtered.
 */
export const AdminAudit = ({ account }: { account: MyAccount }) => {
  const narrow = useNarrow();
  const [now] = useState(() => Date.now());
  const members = useAdminMembers(account.id);
  const [actor, setActor] = useState('');
  const [event, setEvent] = useState('');
  const [range, setRange] = useState<DateRange>({ from: null, to: null });
  const [calendar, setCalendar] = useState(false);
  const [page, setPage] = useState(1);

  const filters = useMemo(() => {
    const p = new URLSearchParams();
    if (actor) p.set('actor_id', actor);
    if (event) p.set('event', event);
    if (range.from) p.set('from', range.from);
    if (range.to ?? range.from) p.set('to', (range.to ?? range.from)!);
    return p;
  }, [actor, event, range]);
  const query = useMemo(() => {
    const p = new URLSearchParams(filters);
    p.set('page', String(page));
    p.set('page_size', String(PAGE_SIZE));
    return p.toString();
  }, [filters, page]);
  const audit = useAudit(account.id, query);
  const data = audit.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filtered = !!(actor || event || range.from);
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const exportCsv = () =>
    void downloadFrom(account.id, `/audit/export.csv?${filters.toString()}`, `audit-${account.slug}.csv`).catch(
      (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' }),
    );

  const people = (members.data?.data ?? []).map((m) => ({ value: m.user_id, label: m.name || m.email }));
  const rangeLabel = range.from
    ? range.to && range.to !== range.from
      ? `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`
      : formatIsoDate(range.from)
    : t('a45.audit.anyDate');

  return (
    <div className="flex flex-col gap-4 pb-12" data-testid="admin-audit">
      <SectionHeader
        title={t('admin.section.audit')}
        subtitle={t('a45.audit.subtitle')}
        actions={
          <Button variant="secondary" onClick={exportCsv} data-testid="audit-export">
            <Icon name="download" size={15} />
            {t('adminUsers.export')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Picker
          label={t('a45.audit.filter.actor')}
          testId="audit-filter-actor"
          value={actor}
          onChange={(v) => reset(() => setActor(v))}
          className="h-9 w-[190px] max-md:flex-1"
          options={[{ value: '', label: t('a45.audit.filter.anyone') }, ...people]}
        />
        <Picker
          label={t('a45.audit.filter.event')}
          testId="audit-filter-event"
          value={event}
          onChange={(v) => reset(() => setEvent(v))}
          className="h-9 w-[210px] max-md:flex-1"
          options={[
            { value: '', label: t('a45.audit.filter.anyEvent') },
            ...(data?.events ?? []).map((e) => ({ value: e, label: eventLabel(e) })),
          ]}
        />
        <span className="relative flex items-center gap-1.5 max-md:w-full">
          <button
            type="button"
            onClick={() => setCalendar((v) => !v)}
            data-testid="audit-filter-dates"
            aria-label={t('a45.audit.filter.dates')}
            className="flex h-9 min-w-[190px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary max-md:flex-1"
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
            data-testid="audit-filter-clear"
            onClick={() =>
              reset(() => {
                setActor('');
                setEvent('');
                setRange({ from: null, to: null });
              })
            }
          >
            <Icon name="x" size={14} />
            {t('a45.audit.filter.clear')}
          </Button>
        ) : null}
        <span className="ms-auto text-xs text-muted" data-testid="audit-count">
          {data ? t('a45.audit.count', { n: data.total }) : null}
        </span>
      </div>

      {audit.isPending ? <SkeletonRows rows={6} label={t('app.loading')} /> : null}
      {audit.isError ? <Notice tone="error">{errorMessage(audit.error)}</Notice> : null}
      {data && !data.data.length ? (
        <EmptyState
          icon={<Icon name="history" size={28} />}
          title={filtered ? t('a45.audit.emptyFiltered') : t('a45.audit.empty')}
          testId="audit-empty"
        />
      ) : null}

      {data?.data.length && narrow ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {data.data.map((e) => (
            <li
              key={e.id}
              data-testid="audit-row"
              data-event={e.event}
              className="flex flex-col gap-1 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-fg">{eventLabel(e.event)}</span>
                <span className="shrink-0 text-[0.6875rem] text-muted">
                  <Ago iso={e.created_at} now={now} />
                </span>
              </span>
              <span className="truncate text-xs text-fg-2">
                <bdi>{e.actor_name ?? t('a45.audit.system')}</bdi>
                {e.target_name ? (
                  <>
                    {' → '}
                    <bdi>{e.target_name}</bdi>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : data?.data.length ? (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{t('a45.audit.col.when')}</th>
                <th className={TH}>{t('a45.audit.col.actor')}</th>
                <th className={TH}>{t('a45.audit.col.event')}</th>
                <th className={TH}>{t('a45.audit.col.target')}</th>
                <th className={TH}>{t('a45.audit.col.details')}</th>
                <th className={TH}>{t('a45.audit.col.ip')}</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((e) => {
                const line = summary(e);
                return (
                  <tr key={e.id} className={cn(TR, 'hover:bg-row-alt')} data-testid="audit-row" data-event={e.event}>
                    <td className={cn(TD, 'text-fg-2')}>
                      <Ago iso={e.created_at} now={now} />
                    </td>
                    <td className={cn(TD, 'max-w-[200px]')}>
                      <Actor label={e.actor_name ?? t('a45.audit.system')} />
                    </td>
                    <td className={TD}>
                      <span className="font-semibold text-fg" title={e.event}>
                        {eventLabel(e.event)}
                      </span>
                    </td>
                    <td className={cn(TD, 'max-w-[200px] truncate text-fg-2')}>
                      <bdi>{e.target_name ?? '—'}</bdi>
                    </td>
                    <td
                      className={cn(TD, 'max-w-[320px] truncate text-xs text-muted')}
                      title={JSON.stringify(e.details, null, 1)}
                    >
                      <bdi dir="ltr">{line || '—'}</bdi>
                    </td>
                    <td className={cn(TD, 'text-xs text-muted')} title={e.user_agent ?? undefined}>
                      <bdi dir="ltr">{e.ip ?? '—'}</bdi>
                    </td>
                  </tr>
                );
              })}
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
            data-testid="audit-prev"
          >
            {t('a45.audit.prev')}
          </Button>
          <span className="text-xs text-muted" data-testid="audit-page">
            {t('a45.audit.page', { page, pages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            data-testid="audit-next"
          >
            {t('a45.audit.next')}
          </Button>
        </nav>
      ) : null}
    </div>
  );
};
