// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatDuration,
  formatTimeline,
  t,
  type DateRange,
  type MessageKey,
  type TimeReport,
  todayIn,
} from '@bines/shared';
import { Avatar, Button, Calendar, Dialog, Notice, Picker, Segmented, SkeletonRows } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { downloadFrom } from '../../lib/download';
import { showToast } from '../../lib/toast';
import { type BoardDetail, useMembers } from '../board/board-api';
import { Popover } from '../board/cells/Popover';

type GroupBy = TimeReport['group_by'];

/**
 * Board time report (03 §3.3): hours by person, item or day over a range of days, the board's subitems included;
 * CSV of the entries for billing. Running timers count up to now.
 */
export const TimeReportDialog = ({
  accountId,
  board,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  onClose: () => void;
}) => {
  const [range, setRange] = useState<DateRange>({ from: null, to: null });
  const [picking, setPicking] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('user');
  const [userId, setUserId] = useState('');
  const [today] = useState(() => todayIn());
  const members = useMembers(accountId).data?.data ?? [];
  const params = new URLSearchParams({ group_by: groupBy });
  if (range.from) params.set('from', range.from);
  if (range.to ?? range.from) params.set('to', (range.to ?? range.from)!);
  if (userId) params.set('user_id', userId);
  const qs = params.toString();
  const report = useQuery({
    queryKey: ['account', accountId, 'board', board.id, 'time-report', qs],
    queryFn: () => api(accountId).get<TimeReport>(`/boards/${board.id}/time/report?${qs}`),
  });
  const r = report.data;
  const hours = (s: number) => (
    <span dir="ltr" className="tabular-nums">
      {formatDuration(s, { show_seconds: false })}
    </span>
  );
  const th = 'h-9 border-b border-line bg-surface-3 px-3 text-start text-xs font-semibold whitespace-nowrap text-muted';
  const td = 'h-11 border-b border-line-soft px-3 whitespace-nowrap';

  return (
    <Dialog
      open
      title={t('timeReport.title', { name: board.name })}
      onClose={onClose}
      className="max-w-[720px]"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3.5" data-testid="time-report">
        {/* F4: one row of filters; each picker shows its value, so no labels. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <button
              type="button"
              data-testid="time-report-range"
              title={t('timeReport.range')}
              onClick={() => setPicking(true)}
              className="flex h-9 w-40 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary"
            >
              <Icon name="calendar" size={15} className="shrink-0 text-muted" />
              <span className="flex-1 truncate">
                {range.from ? formatTimeline(range.from, range.to ?? range.from, today) : t('timeReport.allTime')}
              </span>
              <Icon name="chevronDown" size={14} className="shrink-0 text-muted" />
            </button>
            <Popover open={picking} onClose={() => setPicking(false)}>
              <Calendar mode="range" value={range} onChange={setRange} />
              {range.from ? (
                <button
                  type="button"
                  className="mt-2 text-xs text-muted hover:text-fg"
                  onClick={() => {
                    setRange({ from: null, to: null });
                    setPicking(false);
                  }}
                >
                  {t('timeReport.allTime')}
                </button>
              ) : null}
            </Popover>
          </div>
          <Segmented<GroupBy>
            testId="time-report-group"
            label={t('timeReport.groupBy')}
            value={groupBy}
            onChange={setGroupBy}
            options={(['user', 'item', 'day'] as const).map((g) => ({
              value: g,
              label: t(`timeReport.by.${g}` as MessageKey),
            }))}
          />
          <Picker
            label={t('timeReport.user')}
            value={userId}
            onChange={setUserId}
            className="w-36"
            options={[
              { value: '', label: t('timeReport.everyone') },
              ...members.map((m) => ({ value: m.user_id, label: m.name || m.email })),
            ]}
          />
          <Button
            variant="secondary"
            size="sm"
            className="ms-auto"
            data-testid="time-report-csv"
            disabled={!r?.rows.length}
            onClick={() =>
              void downloadFrom(
                accountId,
                `/boards/${board.id}/time/report.csv?${qs}`,
                `${board.name} - ${t('timeReport.csvFileSuffix')}.csv`,
              ).catch((err) => showToast({ message: errorMessage(err), tone: 'error' }))
            }
          >
            <Icon name="download" size={15} />
            {t('timeReport.csv')}
          </Button>
        </div>

        {report.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
        {report.isError ? <Notice tone="error">{errorMessage(report.error)}</Notice> : null}
        {r && !r.rows.length ? <p className="py-6 text-center text-sm text-muted">{t('timeReport.empty')}</p> : null}
        {r?.rows.length ? (
          <div className="overflow-x-auto rounded-[12px] border border-line">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={th}>{t(`timeReport.by.${groupBy}` as MessageKey)}</th>
                  <th className={th}>{t('timeReport.hours')}</th>
                  <th className={th}>{t('timeReport.billable')}</th>
                  <th className={th}>{t('timeReport.entries')}</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row) => (
                  <tr key={row.key} data-testid="time-report-row" data-label={row.label}>
                    <td className={`${td} max-w-64`}>
                      <span className="flex min-w-0 items-center gap-2">
                        {groupBy === 'user' ? (
                          <Avatar
                            name={row.label}
                            url={members.find((m) => m.user_id === row.key)?.avatar_url}
                            size={24}
                          />
                        ) : null}
                        <span className="truncate">{row.label}</span>
                      </span>
                    </td>
                    <td className={`${td} font-bold`}>{hours(row.duration_s)}</td>
                    <td className={td}>{hours(row.billable_s)}</td>
                    <td className={`${td} text-muted tabular-nums`}>{row.entries}</td>
                  </tr>
                ))}
                <tr data-testid="time-report-total">
                  <td className={`${td} border-b-0 font-bold`}>{t('timeReport.total')}</td>
                  <td className={`${td} border-b-0 font-bold`}>{hours(r.total_s)}</td>
                  <td className={`${td} border-b-0 font-bold`}>{hours(r.billable_s)}</td>
                  <td className={`${td} border-b-0 tabular-nums`}>{r.rows.reduce((n, row) => n + row.entries, 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}
        {r?.running ? <Notice tone="warn">{t('timeReport.running', { n: r.running })}</Notice> : null}
      </div>
    </Dialog>
  );
};
