// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDateTime,
  type SupportConsoleConfig,
  type SupportReport,
  type SupportStaff,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketSummary,
  t,
  paint,
} from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  cn,
  EmptyState,
  Input,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
  Tabs,
} from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { priorityLabel, statusLabel, statusTone } from '../../support/support-api';
import { ConsoleTicket } from './ConsoleTicket';
import { consoleKeys, minutesLabel, useConsoleConfig, useConsoleTickets } from './console-api';
import { HelpKnowledge } from './HelpKnowledge';
import { SupportConfig } from './SupportConfig';

type Tab = 'tickets' | 'knowledge' | 'reports' | 'settings' | 'staff';

/**
 * The owner console's "Support" section: the tickets of every account (filters, the ticket on the
 * side), reports, the helpdesk's settings (leads and the owner) and the support staff (the owner). Support staff
 * open the console and see only this section.
 */
export const SupportConsole = ({ ticket }: { ticket?: string }) => {
  const config = useConsoleConfig();
  const [tab, setTab] = useState<Tab>('tickets');
  if (config.isPending) return <SkeletonRows rows={6} label={t('app.loading')} />;
  if (config.isError) return <Notice tone="error">{errorMessage(config.error)}</Notice>;
  const c = config.data;
  const tabs: { value: Tab; label: string; testId: string }[] = [
    { value: 'tickets', label: t('tickets.console.tickets'), testId: 'support-tab-tickets' },
    // The knowledge center: help articles, their settings and metrics.
    { value: 'knowledge', label: t('help.console.title'), testId: 'support-tab-knowledge' },
    { value: 'reports', label: t('tickets.console.reports'), testId: 'support-tab-reports' },
    ...(c.role !== 'agent'
      ? [{ value: 'settings' as const, label: t('tickets.console.settings'), testId: 'support-tab-settings' }]
      : []),
    ...(c.role === 'owner'
      ? [{ value: 'staff' as const, label: t('tickets.console.staff'), testId: 'support-tab-staff' }]
      : []),
  ];
  return (
    <section className="space-y-3" data-testid="support-console" data-role={c.role}>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'tickets' ? <TicketsTab config={c} initial={ticket} /> : null}
      {tab === 'knowledge' ? <HelpKnowledge /> : null}
      {tab === 'reports' ? <ReportsTab /> : null}
      {tab === 'settings' ? <SupportConfig config={c} /> : null}
      {tab === 'staff' ? <StaffTab /> : null}
    </section>
  );
};

const TicketsTab = ({ config, initial }: { config: SupportConsoleConfig; initial?: string }) => {
  const [filters, setFilters] = useState<Record<string, string>>({ status: 'active' });
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const list = useConsoleTickets({ ...filters, q });
  const set = (k: string) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const rows = list.data?.data ?? [];
  const all = { value: '', label: t('tickets.filter.all') };
  return (
    <div className="flex items-start gap-4 max-lg:flex-col">
      <div className={cn('min-w-0 space-y-2', selected ? 'flex-[1_1_420px] max-lg:w-full' : 'w-full')}>
        <div className="flex flex-wrap items-center gap-2" data-testid="support-filters">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('tickets.filter.search')}
            className="w-44"
            data-testid="support-search"
          />
          <Picker
            label={t('tickets.field.status')}
            className="w-40"
            value={filters.status ?? ''}
            onChange={set('status')}
            testId="support-filter-status"
            options={[
              all,
              { value: 'active', label: t('tickets.filter.active') },
              ...TICKET_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
            ]}
          />
          <Picker
            label={t('tickets.field.priority')}
            className="w-32"
            value={filters.priority ?? ''}
            onChange={set('priority')}
            options={[all, ...TICKET_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))]}
          />
          <Picker
            label={t('tickets.field.queue')}
            className="w-36"
            value={filters.queue_id ?? ''}
            onChange={set('queue_id')}
            options={[all, ...config.queues.map((x) => ({ value: x.id, label: x.name }))]}
          />
          <Picker
            label={t('tickets.field.category')}
            className="w-36"
            value={filters.category_id ?? ''}
            onChange={set('category_id')}
            options={[all, ...config.categories.map((x) => ({ value: x.id, label: x.name }))]}
          />
          <Picker
            label={t('tickets.field.assignee')}
            className="w-36"
            value={filters.assignee ?? ''}
            onChange={set('assignee')}
            testId="support-filter-assignee"
            options={[
              all,
              { value: 'me', label: t('tickets.filter.me') },
              { value: 'none', label: t('tickets.assignee.none') },
              ...config.agents.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          {config.tags.length ? (
            <Picker
              label={t('tickets.field.tags')}
              className="w-32"
              value={filters.tag_id ?? ''}
              onChange={set('tag_id')}
              options={[all, ...config.tags.map((x) => ({ value: x.id, label: x.name }))]}
            />
          ) : null}
          <Picker
            label={t('tickets.filter.sla')}
            className="w-40"
            value={filters.breached ?? ''}
            onChange={set('breached')}
            testId="support-filter-breached"
            options={[
              all,
              { value: 'any', label: t('tickets.filter.breached') },
              { value: 'first_response', label: t('tickets.sla.first') },
              { value: 'resolution', label: t('tickets.sla.resolution') },
            ]}
          />
        </div>
        {list.isPending ? <SkeletonRows rows={5} label={t('app.loading')} /> : null}
        {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
        {list.data && !rows.length ? (
          <EmptyState icon={<Icon name="inbox" size={28} />} title={t('tickets.console.empty')} />
        ) : null}
        <ul className="overflow-hidden rounded-[12px] border border-line bg-surface">
          {rows.map((r) => (
            <TicketRow key={r.id} r={r} active={r.id === selected} onOpen={() => setSelected(r.id)} />
          ))}
        </ul>
      </div>
      {selected ? (
        <Card className="min-w-0 flex-[1_1_520px] max-lg:w-full">
          <ConsoleTicket key={selected} id={selected} config={config} onClose={() => setSelected(null)} />
        </Card>
      ) : null}
    </div>
  );
};

const TicketRow = ({ r, active, onOpen }: { r: TicketSummary; active: boolean; onOpen: () => void }) => {
  const breached = r.sla?.first_response_breached || r.sla?.resolution_breached;
  return (
    <li className="border-b border-line-soft last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        data-testid="support-ticket-row"
        data-number={r.number}
        data-breached={breached ? 'true' : 'false'}
        className={cn('flex w-full flex-col gap-1 px-3 py-2.5 text-start hover:bg-surface-2', active && 'bg-surface-2')}
      >
        <span className="flex w-full items-center gap-2">
          <span className="font-mono text-xs text-muted" dir="ltr">
            #{r.number}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" dir="auto">
            {r.subject}
          </span>
          {breached ? (
            <Badge tone="danger">
              <Icon name="clock" size={11} />
              {t('tickets.sla.breached')}
            </Badge>
          ) : null}
          <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
        </span>
        <span className="flex w-full flex-wrap items-center gap-2 text-xs text-muted">
          <span>{r.account?.name}</span>
          <span>· {priorityLabel(r.priority)}</span>
          {r.queue ? <span>· {r.queue.name}</span> : null}
          <span>· {r.assignee?.name ?? t('tickets.assignee.none')}</span>
          {(r.tags ?? []).map((x) => (
            <span
              key={x.id}
              className="rounded-full px-1.5 text-white"
              style={{ background: paint(x.color) ?? 'var(--muted)' }}
            >
              {x.name}
            </span>
          ))}
          <span className="ms-auto">{formatDateTime(r.updated_at)}</span>
        </span>
      </button>
    </li>
  );
};

const ReportsTab = () => {
  const [days, setDays] = useState('30');
  const q = useQuery({
    queryKey: consoleKeys.report(Number(days)),
    queryFn: () => api().get<SupportReport>(`/platform/support/reports?days=${days}`),
  });
  const r = q.data;
  const maxDay = Math.max(1, ...(r?.by_day ?? []).map((d) => Math.max(d.created, d.solved)));
  return (
    <div className="space-y-3" data-testid="support-reports">
      <Segmented
        label={t('tickets.report.range')}
        value={days}
        onChange={setDays}
        options={['7', '30', '90'].map((d) => ({ value: d, label: t('tickets.report.days', { n: d }) }))}
      />
      {q.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
      {q.isError ? <Notice tone="error">{errorMessage(q.error)}</Notice> : null}
      {r ? (
        <>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label={t('tickets.report.created')} value={String(r.created)} testId="report-created" />
            <Tile label={t('tickets.report.solved')} value={String(r.solved)} />
            <Tile label={t('tickets.report.open')} value={String(r.open_now)} />
            <Tile
              label={t('tickets.report.breached')}
              value={String(r.breached_now)}
              tone={r.breached_now ? 'danger' : undefined}
            />
            <Tile
              label={t('tickets.report.firstResponse')}
              value={minutesLabel(r.first_response.median_minutes)}
              hint={t('tickets.report.median')}
            />
            <Tile
              label={t('tickets.report.resolution')}
              value={minutesLabel(r.resolution.median_minutes)}
              hint={t('tickets.report.median')}
            />
          </div>
          <Card className="space-y-1">
            <h3 className="text-sm font-semibold text-fg">{t('tickets.report.csat')}</h3>
            <p className="text-sm text-fg-2" data-testid="report-csat">
              {r.csat.count
                ? t('tickets.report.csatValue', {
                    avg: r.csat.avg ?? 0,
                    share: Math.round((r.csat.satisfied_share ?? 0) * 100),
                    n: r.csat.count,
                  })
                : t('tickets.report.noRatings')}
            </p>
          </Card>
          <Card className="space-y-2">
            <h3 className="text-sm font-semibold text-fg">{t('tickets.report.perDay')}</h3>
            <div className="flex h-28 items-end gap-0.5" role="img" aria-label={t('tickets.report.perDay')}>
              {r.by_day.map((d) => (
                <div
                  key={d.date}
                  className="flex flex-1 items-end gap-px"
                  title={`${d.date}: ${d.created} / ${d.solved}`}
                >
                  <span className="flex-1 rounded-t bg-info" style={{ height: `${(d.created / maxDay) * 100}%` }} />
                  <span className="flex-1 rounded-t bg-ok" style={{ height: `${(d.solved / maxDay) * 100}%` }} />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">{t('tickets.report.legend')}</p>
          </Card>
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="space-y-2">
              <h3 className="text-sm font-semibold text-fg">{t('tickets.report.perAgent')}</h3>
              <table className="w-full text-sm">
                <tbody>
                  {r.by_agent.map((a) => (
                    <tr key={a.id} className="border-b border-line-soft last:border-b-0">
                      <td className="py-1">{a.name}</td>
                      <td className="py-1 text-muted tabular-nums">
                        {t('tickets.report.agentLine', { assigned: a.assigned, solved: a.solved })}
                      </td>
                      <td className="py-1 text-muted">{minutesLabel(a.avg_first_response_minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card className="space-y-2">
              <h3 className="text-sm font-semibold text-fg">{t('tickets.report.perCategory')}</h3>
              <ul className="space-y-1 text-sm">
                {r.by_category.map((x) => (
                  <li key={x.id ?? 'none'} className="flex justify-between">
                    <span>{x.name ?? t('tickets.category.none')}</span>
                    <span className="tabular-nums text-muted">{x.count}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
};

const Tile = ({
  label,
  value,
  hint,
  tone,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'danger';
  testId?: string;
}) => (
  <Card className="space-y-0.5">
    <span className="block text-xs text-muted">{label}</span>
    <span
      className={cn('block font-display text-xl font-bold', tone === 'danger' ? 'text-danger-fg' : 'text-heading')}
      data-testid={testId}
    >
      {value}
    </span>
    {hint ? <span className="block text-[0.6875rem] text-muted">{hint}</span> : null}
  </Card>
);

const StaffTab = () => {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: consoleKeys.staff,
    queryFn: () => api().get<{ data: SupportStaff[] }>('/platform/support/staff'),
  });
  const done = (res: { data: SupportStaff[] }) => {
    qc.setQueryData(consoleKeys.staff, res);
    void qc.invalidateQueries({ queryKey: consoleKeys.config });
  };
  const onError = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
  const invite = useMutation({
    mutationFn: (v: { email: string; role: 'agent' | 'lead' }) =>
      api().post<{ data: SupportStaff[] }>('/platform/support/staff', v),
    onSuccess: (res) => {
      done(res);
      setEmail('');
      showToast({ message: t('tickets.staff.invited') });
    },
    onError,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; role?: 'agent' | 'lead'; status?: 'active' | 'deactivated' }) =>
      api().patch<{ data: SupportStaff[] }>(`/platform/support/staff/${v.id}`, { role: v.role, status: v.status }),
    onSuccess: done,
    onError,
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'agent' | 'lead'>('agent');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) invite.mutate({ email: email.trim().toLowerCase(), role });
  };
  return (
    <div className="space-y-3" data-testid="support-staff">
      <Card className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">{t('tickets.staff.invite')}</h3>
        <p className="text-xs text-muted">{t('tickets.staff.hint')}</p>
        <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
          <Input
            type="email"
            dir="ltr"
            className="w-64 text-start"
            placeholder="agent@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="support-staff-email"
          />
          <Segmented
            label={t('tickets.staff.role')}
            value={role}
            onChange={setRole}
            options={[
              { value: 'agent' as const, label: t('tickets.staff.role.agent') },
              { value: 'lead' as const, label: t('tickets.staff.role.lead') },
            ]}
          />
          <Button
            type="submit"
            variant="accent"
            size="sm"
            busy={invite.isPending}
            disabled={!email.trim()}
            data-testid="support-staff-invite"
          >
            {t('tickets.staff.inviteButton')}
          </Button>
        </form>
      </Card>
      {q.isError ? <Notice tone="error">{errorMessage(q.error)}</Notice> : null}
      <ul className="overflow-hidden rounded-[12px] border border-line bg-surface">
        {(q.data?.data ?? []).map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-3 border-b border-line-soft px-3 py-2.5 last:border-b-0"
            data-testid="support-staff-row"
            data-email={s.email}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-fg">{s.name ?? s.email}</span>
              <span className="block truncate text-xs text-muted" dir="ltr">
                {s.email} {s.user_id ? '' : `· ${t('tickets.staff.notSignedUp')}`}
              </span>
            </span>
            <Segmented
              label={t('tickets.staff.role')}
              value={s.role}
              onChange={(v) => update.mutate({ id: s.id, role: v })}
              options={[
                { value: 'agent' as const, label: t('tickets.staff.role.agent') },
                { value: 'lead' as const, label: t('tickets.staff.role.lead') },
              ]}
            />
            <label className="flex items-center gap-2 text-xs text-fg-2">
              <Switch
                checked={s.status === 'active'}
                onChange={(on) => update.mutate({ id: s.id, status: on ? 'active' : 'deactivated' })}
                label={t('tickets.staff.active')}
                testId="support-staff-active"
              />
              {t('tickets.staff.active')}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
};
