// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ErrorDetail, type ErrorHubConfig, type ErrorStatus, formatDateTime, t, tDynamic } from '@bines/shared';
import { Badge, Button, Notice, Picker, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { promptDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { TEXTAREA } from '../../support/NewTicketDialog';
import {
  errorKeys,
  severityLabel,
  severityTone,
  sourceLabel,
  statusLabel,
  statusTone,
  useErrorDetail,
} from './errors-api';
import { SupportAgentPanel } from './SupportAgent';

/** Mute presets (hours) offered in the error's "mute until" menu — no native date picker (M1.1 #9). */
const MUTE_HOURS = [1, 8, 24, 72, 168];

/**
 * One error on the side of the list: what, where, how often (the last 24 hours as bars), its links
 * (ids), the workflow (acknowledge / resolve / ignore / reopen, assignee, mute, note) and tickets. The run trace and
 * "open in the account" come only with an active support grant; without one, "open a ticket and ask for access".
 */
export const ErrorDetailPanel = ({
  id,
  config,
  onClose,
}: {
  id: string;
  config: ErrorHubConfig;
  onClose: () => void;
}) => {
  const q = useErrorDetail(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const done = (res: ErrorDetail) => {
    qc.setQueryData(errorKeys.detail(id), res);
    void qc.invalidateQueries({ queryKey: [...errorKeys.all, 'list'] });
  };
  const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api().patch<ErrorDetail>(`/platform/errors/${id}`, body),
    onSuccess: done,
    onError: fail,
  });
  const ticket = useMutation({
    mutationFn: (body: { subject?: string }) =>
      api().post<{ ticket: { id: string; number: number }; detail: ErrorDetail }>(
        `/platform/errors/${id}/ticket`,
        body,
      ),
    onSuccess: (res) => {
      done(res.detail);
      showToast({ message: t('errors.ticket.created', { n: res.ticket.number }) });
    },
    onError: fail,
  });
  const attach = useMutation({
    mutationFn: (n: number) => api().post<ErrorDetail>(`/platform/errors/${id}/attach`, { ticket_number: n }),
    onSuccess: (res) => {
      done(res);
      showToast({ message: t('errors.ticket.attached') });
    },
    onError: fail,
  });
  const [note, setNote] = useState<string | null>(null);

  if (q.isPending) return <SkeletonRows rows={5} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  const d = q.data;
  const e = d.event;
  const max = Math.max(1, ...d.hourly.map((h) => h.count));
  const openTicket = (ticketId: string) =>
    void navigate({ to: '/owner', search: { section: 'support', ticket: ticketId } });
  const setStatus = (status: ErrorStatus) => patch.mutate({ status });
  const createTicket = async () => {
    const subject = await promptDialog({
      title: t('errors.ticket.create'),
      label: t('errors.ticket.subject'),
      initial: `${sourceLabel(e.source)}: ${e.code}`,
      confirmLabel: t('errors.ticket.create'),
    });
    if (subject) ticket.mutate({ subject });
  };
  const attachTicket = async () => {
    const n = await promptDialog({
      title: t('errors.ticket.attach'),
      label: t('errors.ticket.number'),
      confirmLabel: t('errors.ticket.attach'),
    });
    const num = Number(n?.replace(/^#/, ''));
    if (Number.isInteger(num) && num > 0) attach.mutate(num);
  };

  return (
    <div
      className="space-y-4"
      data-testid="error-detail"
      data-status={e.status}
      data-access={d.access.granted ? 'granted' : 'none'}
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={severityTone(e.severity)}>{severityLabel(e.severity)}</Badge>
            <Badge tone="neutral">{sourceLabel(e.source)}</Badge>
            <Badge tone={statusTone(e.status)}>{statusLabel(e.status)}</Badge>
            <span className="font-mono text-xs text-muted" dir="ltr">
              {e.code}
            </span>
          </div>
          <p className="text-sm font-semibold text-fg" dir="auto" data-testid="error-message">
            {e.message}
          </p>
          <p className="text-xs text-muted">
            {e.account?.name ?? t('errors.platform')} · {t('errors.countLine', { n: e.count })} ·{' '}
            {t('errors.seen', { first: formatDateTime(e.first_seen_at), last: formatDateTime(e.last_seen_at) })}
            {e.reopened_count ? ` · ${t('errors.reopened', { n: e.reopened_count })}` : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
          <Icon name="x" size={14} />
        </Button>
      </header>

      <div className="flex h-12 items-end gap-0.5" data-testid="error-hourly" aria-label={t('errors.hourly')}>
        {d.hourly.length ? (
          d.hourly.map((h) => (
            <span
              key={h.hour}
              className="flex-1 rounded-t bg-accent"
              style={{ blockSize: `${Math.max(8, (h.count / max) * 100)}%` }}
              title={`${formatDateTime(h.hour)} · ${h.count}`}
            />
          ))
        ) : (
          <span className="text-xs text-muted">{t('errors.hourly.none')}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid="error-actions">
        {e.status === 'new' ? (
          <Button size="sm" variant="secondary" onClick={() => setStatus('acknowledged')} data-testid="error-ack">
            {t('errors.action.ack')}
          </Button>
        ) : null}
        {e.status !== 'resolved' ? (
          <Button size="sm" variant="secondary" onClick={() => setStatus('resolved')} data-testid="error-resolve">
            {t('errors.action.resolve')}
          </Button>
        ) : null}
        {e.status !== 'ignored' ? (
          <Button size="sm" variant="ghost" onClick={() => setStatus('ignored')} data-testid="error-ignore">
            {t('errors.action.ignore')}
          </Button>
        ) : null}
        {e.status === 'resolved' || e.status === 'ignored' ? (
          <Button size="sm" variant="ghost" onClick={() => setStatus('new')} data-testid="error-reopen">
            {t('errors.action.reopen')}
          </Button>
        ) : null}
        <Picker
          label={t('errors.field.assignee')}
          className="w-40"
          value={e.assignee?.id ?? ''}
          onChange={(v) => patch.mutate({ assignee_id: v || null })}
          testId="error-assignee"
          options={[
            { value: '', label: t('errors.assignee.none') },
            ...config.agents.map((a) => ({ value: a.id, label: a.name, testId: `assignee-${a.id}` })),
          ]}
        />
        <Picker
          label={t('errors.mute')}
          className="w-40"
          value=""
          onChange={(v) =>
            patch.mutate({
              muted_until: v === 'off' ? null : new Date(Date.now() + Number(v) * 3_600_000).toISOString(),
            })
          }
          testId="error-mute"
          placeholder={
            e.muted_until ? t('errors.mutedUntil', { date: formatDateTime(e.muted_until) }) : t('errors.mute')
          }
          options={[
            ...MUTE_HOURS.map((h) => ({ value: String(h), label: t('errors.mute.hours', { n: h }) })),
            ...(e.muted_until ? [{ value: 'off', label: t('errors.mute.off') }] : []),
          ]}
        />
      </div>

      <section className="space-y-1.5" data-testid="error-ticket">
        <h3 className="text-xs font-semibold text-fg-2">{t('errors.ticket.title')}</h3>
        {e.ticket ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openTicket(e.ticket!.id)}
            data-testid="error-ticket-open"
          >
            <Icon name="chat" size={14} /> #{e.ticket.number}
          </Button>
        ) : e.account ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              busy={ticket.isPending}
              onClick={() => void createTicket()}
              data-testid="error-ticket-create"
            >
              {t('errors.ticket.create')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              busy={attach.isPending}
              onClick={() => void attachTicket()}
              data-testid="error-ticket-attach"
            >
              {t('errors.ticket.attach')}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">{t('errors.ticket.noAccount')}</p>
        )}
      </section>

      <SupportAgentPanel errorId={id} />

      <section className="space-y-1.5" data-testid="error-access">
        <h3 className="text-xs font-semibold text-fg-2">{t('errors.access.title')}</h3>
        {!e.account ? null : d.access.granted ? (
          <>
            {d.open_path ? (
              <a
                href={d.open_path}
                className="inline-flex items-center gap-1.5 text-sm text-accent-fg underline"
                data-testid="error-open-account"
              >
                <Icon name="link" size={14} />
                {t('errors.access.open')}
              </a>
            ) : null}
            {d.trace?.length ? (
              <ol className="space-y-1 text-xs" data-testid="error-trace">
                {d.trace.map((s) => (
                  <li key={s.index} className="flex items-center gap-2" data-status={s.status}>
                    <span className="w-5 text-muted tabular-nums">{s.index + 1}</span>
                    <span className="font-mono" dir="ltr">
                      {s.type}
                    </span>
                    <Badge
                      tone={
                        s.status === 'error' || s.status === 'failed'
                          ? 'danger'
                          : s.status === 'ok' || s.status === 'ran'
                            ? 'ok'
                            : 'neutral'
                      }
                    >
                      {s.status}
                    </Badge>
                    {s.code || s.reason ? (
                      <span className="font-mono text-muted" dir="ltr">
                        {s.code ?? s.reason}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : (
          <Notice tone="info">
            <span className="space-y-2">
              <span className="block">{t('errors.access.none')}</span>
              {e.ticket ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openTicket(e.ticket!.id)}
                  data-testid="error-request-access"
                >
                  {t('errors.access.request')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  busy={ticket.isPending}
                  onClick={() => void createTicket()}
                  data-testid="error-request-access"
                >
                  {t('errors.access.ticketFirst')}
                </Button>
              )}
            </span>
          </Notice>
        )}
      </section>

      {Object.keys(e.links).length ? (
        <section className="space-y-1" data-testid="error-links">
          <h3 className="text-xs font-semibold text-fg-2">{t('errors.links')}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {Object.entries(e.links).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{tDynamic(`errors.link.${k}`)}</dt>
                <dd className="truncate font-mono" dir="ltr">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {d.glitchtip_url ? (
        <a
          href={d.glitchtip_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-accent-fg underline"
          data-testid="error-glitchtip"
        >
          <Icon name="link" size={14} />
          {t('errors.glitchtip.open')}
        </a>
      ) : null}

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-fg-2">{t('errors.note')}</h3>
        <textarea
          className={TEXTAREA}
          rows={3}
          value={note ?? e.note ?? ''}
          onChange={(ev) => setNote(ev.target.value)}
          placeholder={t('errors.note.placeholder')}
          data-testid="error-note"
        />
        {note !== null && note !== (e.note ?? '') ? (
          <Button
            size="sm"
            variant="secondary"
            busy={patch.isPending}
            onClick={() => patch.mutate({ note })}
            data-testid="error-note-save"
          >
            {t('errors.note.save')}
          </Button>
        ) : null}
      </section>
    </div>
  );
};
