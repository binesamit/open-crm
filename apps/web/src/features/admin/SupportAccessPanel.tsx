// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CreateSupportGrant,
  formatDateTime,
  type MyAccount,
  type SupportAccessResponse,
  type SupportGrant,
  type SupportMode,
  type SupportRecoveryRequest,
  t,
  type UpdateSecurity,
} from '@bines/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  RadioCard,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { Panel, Row } from './admin-parts';

/**
 * Administration → אבטחה → גישת תמיכה ("remote support access"): the admin lets the
 * platform's support (or a support person by email) into the account for a while — view only unless the admin
 * chooses edit (and the account allows edit at all), for one of the durations the owner console offers, with a
 * reason. Active and past grants with revoke; the platform owner's emergency recovery requests with cancel. The
 * account's own limits (edit allowed, longest grant) live here too.
 */
const KEY = (accountId: string) => ['account', accountId, 'admin', 'support-access'] as const;

/** "שעה", "4 שעות", "יום", "7 ימים" — whole days when the hours divide. */
export const durationLabel = (hours: number) =>
  hours % 24 === 0
    ? hours === 24
      ? t('support.duration.day')
      : t('support.duration.days', { n: hours / 24 })
    : hours === 1
      ? t('support.duration.hour')
      : t('support.duration.hours', { n: hours });

const fail = (err: unknown) => showToast({ message: reasonMessage(err), tone: 'error' });

export const SupportAccessPanel = ({
  account,
  busy,
  onSave,
}: {
  account: MyAccount;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: KEY(account.id),
    queryFn: () => api(account.id).get<SupportAccessResponse>('/support-access'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY(account.id) });
  const revoke = useMutation({
    mutationFn: (id: string) => api(account.id).delete(`/support-access/${id}`),
    onSuccess: async () => {
      showToast({ message: t('support.revoked') });
      await refresh();
    },
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(account.id).post(`/support-access/recovery-requests/${id}/cancel`),
    onSuccess: async () => {
      showToast({ message: t('support.emergency.cancelled') });
      await refresh();
    },
    onError: fail,
  });
  const [open, setOpen] = useState(false);
  const data = query.data;
  // Support itself sees the list but never manages it (the server refuses too).
  const readOnly = !!account.support;
  const save = (patch: UpdateSecurity) => {
    onSave(patch);
    void refresh();
  };

  const askRevoke = async (g: SupportGrant) => {
    const ok = await confirmDialog({
      title: t('support.revokeConfirm'),
      message: t('support.revokeHint'),
      confirmLabel: t('support.revoke'),
      danger: true,
    });
    if (ok) revoke.mutate(g.id);
  };
  const askCancel = async (r: SupportRecoveryRequest) => {
    const ok = await confirmDialog({
      title: t('support.emergency.cancelConfirm', { email: r.email }),
      message: t('support.emergency.cancelHint'),
      confirmLabel: t('support.emergency.cancel'),
      danger: true,
    });
    if (ok) cancel.mutate(r.id);
  };

  return (
    <Panel
      title={t('support.title')}
      hint={t('support.hint')}
      testId="security-support"
      actions={
        <Button
          variant="accent"
          size="sm"
          disabled={!data || readOnly}
          onClick={() => setOpen(true)}
          data-testid="support-grant-open"
        >
          <Icon name="plus" size={14} />
          {t('support.grant')}
        </Button>
      }
    >
      {query.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {query.isError ? <Notice tone="error">{errorMessage(query.error)}</Notice> : null}
      {data ? (
        <>
          {data.recovery_requests.some((r) => r.status === 'waiting' || r.status === 'ready') ? (
            <div className="border-b border-line-soft px-3.5 py-3">
              <Notice tone="error">{t('support.emergency.notice')}</Notice>
            </div>
          ) : null}
          <Row label={t('support.allowEdit')} hint={t('support.allowEditHint')}>
            <Switch
              checked={data.settings.allow_edit}
              onChange={(on) => save({ support_access: { allow_edit: on } })}
              disabled={busy || readOnly}
              label={t('support.allowEdit')}
              testId="support-allow-edit"
            />
          </Row>
          <Row label={t('support.maxDuration')} hint={t('support.maxDurationHint')}>
            <Segmented
              label={t('support.maxDuration')}
              value={String(Math.min(data.settings.max_hours, Math.max(...data.options.platform_durations_hours)))}
              onChange={(v) => save({ support_access: { max_hours: Number(v) } })}
              testId="support-max-duration"
              options={data.options.platform_durations_hours.map((h) => ({
                value: String(h),
                label: durationLabel(h),
                testId: `support-max-${h}`,
              }))}
            />
          </Row>
          <GrantList grants={data.grants} onRevoke={(g) => void askRevoke(g)} readOnly={readOnly} />
          {data.recovery_requests.length ? (
            <RequestList requests={data.recovery_requests} onCancel={(r) => void askCancel(r)} readOnly={readOnly} />
          ) : null}
        </>
      ) : null}
      {open && data ? (
        <GrantDialog
          account={account}
          options={data.options}
          onClose={() => setOpen(false)}
          onDone={async () => {
            setOpen(false);
            showToast({ message: t('support.granted') });
            await refresh();
          }}
        />
      ) : null}
    </Panel>
  );
};

const statusTone = { active: 'ok', expired: 'neutral', revoked: 'danger' } as const;

const GrantList = ({
  grants,
  onRevoke,
  readOnly,
}: {
  grants: SupportGrant[];
  onRevoke: (g: SupportGrant) => void;
  readOnly: boolean;
}) =>
  grants.length ? (
    <ul data-testid="support-grants">
      {grants.map((g) => (
        <li
          key={g.id}
          data-testid="support-grant-row"
          data-status={g.status}
          data-mode={g.mode}
          className="flex items-start gap-3 border-b border-line-soft px-3.5 py-3 last:border-b-0 max-sm:flex-col max-sm:items-stretch"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-fg">
              {g.grantee === 'platform' ? t('support.grantee.platform') : <bdi dir="ltr">{g.email}</bdi>}
              <Badge tone={g.mode === 'edit' ? 'info' : 'neutral'}>{t(`support.mode.${g.mode}`)}</Badge>
              <Badge tone={statusTone[g.status]}>{t(`support.status.${g.status}`)}</Badge>
            </span>
            {g.reason ? <span className="text-xs break-words text-fg-2">{g.reason}</span> : null}
            <span className="text-[0.6875rem] text-muted">
              {t('support.grantedBy', { name: g.granted_by.name ?? '—', date: formatDateTime(g.created_at) })}
              {' · '}
              {g.status === 'revoked'
                ? t('support.revokedAt', { name: g.revoked_by_name ?? '—', date: formatDateTime(g.revoked_at!) })
                : t(g.status === 'active' ? 'support.expiresAt' : 'support.expiredAt', {
                    date: formatDateTime(g.expires_at),
                  })}
              {g.last_used_at ? ` · ${t('support.lastUsed', { date: formatDateTime(g.last_used_at) })}` : ''}
            </span>
          </span>
          {g.status === 'active' && !readOnly ? (
            <Button variant="danger-outline" size="sm" onClick={() => onRevoke(g)} data-testid="support-revoke">
              {t('support.revoke')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  ) : (
    <EmptyState title={t('support.empty')} testId="support-empty" />
  );

const requestTone = { waiting: 'info', ready: 'danger', used: 'neutral', cancelled: 'neutral' } as const;

const RequestList = ({
  requests,
  onCancel,
  readOnly,
}: {
  requests: SupportRecoveryRequest[];
  onCancel: (r: SupportRecoveryRequest) => void;
  readOnly: boolean;
}) => (
  <div className="border-t border-line-soft" data-testid="support-emergency">
    <div className="px-3.5 pt-3 pb-1 text-sm font-semibold text-fg">{t('support.emergency.title')}</div>
    <p className="px-3.5 pb-2 text-xs text-muted">{t('support.emergency.hint')}</p>
    <ul>
      {requests.map((r) => (
        <li
          key={r.id}
          data-testid="support-emergency-row"
          data-status={r.status}
          className="flex items-start gap-3 border-t border-line-soft px-3.5 py-3 max-sm:flex-col max-sm:items-stretch"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-fg">
              <bdi dir="ltr">{r.email}</bdi>
              <Badge tone={requestTone[r.status]}>{t(`support.emergency.status.${r.status}`)}</Badge>
            </span>
            <span className="text-xs break-words text-fg-2">{r.reason}</span>
            <span className="text-[0.6875rem] text-muted">
              {t('support.emergency.requested', {
                name: r.requested_by_name ?? '—',
                date: formatDateTime(r.created_at),
              })}
              {' · '}
              {t('support.emergency.opens', { date: formatDateTime(r.available_at) })}
            </span>
          </span>
          {(r.status === 'waiting' || r.status === 'ready') && !readOnly ? (
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => onCancel(r)}
              data-testid="support-emergency-cancel"
            >
              {t('support.emergency.cancel')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  </div>
);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GrantDialog = ({
  account,
  options,
  onClose,
  onDone,
}: {
  account: MyAccount;
  options: SupportAccessResponse['options'];
  onClose: () => void;
  onDone: () => Promise<void>;
}) => {
  const [grantee, setGrantee] = useState<'platform' | 'email'>('platform');
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<SupportMode>('view');
  const [hours, setHours] = useState(String(options.default_duration_hours));
  const [reason, setReason] = useState('');
  const create = useMutation({
    mutationFn: (input: CreateSupportGrant) => api(account.id).post<SupportGrant>('/support-access', input),
    onSuccess: onDone,
  });
  const valid = reason.trim().length > 0 && (grantee === 'platform' || EMAIL.test(email.trim()));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    create.mutate({
      grantee,
      ...(grantee === 'email' ? { email: email.trim().toLowerCase() } : {}),
      mode,
      duration_hours: Number(hours),
      reason: reason.trim(),
    });
  };
  return (
    <Dialog open onClose={onClose} title={t('support.grant')} subtitle={t('support.grantSubtitle')}>
      <form className="flex flex-col gap-4 whitespace-normal" onSubmit={submit} data-testid="support-grant-form">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg-2">{t('support.who')}</span>
          <div className="grid gap-2 sm:grid-cols-2">
            <RadioCard
              name="support-grantee"
              checked={grantee === 'platform'}
              onSelect={() => setGrantee('platform')}
              title={t('support.grantee.platform')}
              hint={t('support.grantee.platformHint')}
              testId="support-grantee-platform"
            />
            <RadioCard
              name="support-grantee"
              checked={grantee === 'email'}
              onSelect={() => setGrantee('email')}
              title={t('support.grantee.email')}
              hint={t('support.grantee.emailHint')}
              testId="support-grantee-email"
            />
          </div>
          {grantee === 'email' ? (
            <Input
              type="email"
              dir="ltr"
              className="text-start"
              placeholder="support@example.com"
              aria-label={t('support.grantee.email')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="support-grantee-email-input"
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg-2">{t('support.access')}</span>
          <Segmented
            label={t('support.access')}
            value={mode}
            onChange={setMode}
            testId="support-mode"
            options={[
              { value: 'view' as const, label: t('support.mode.view'), testId: 'support-mode-view' },
              ...(options.allow_edit
                ? [{ value: 'edit' as const, label: t('support.mode.edit'), testId: 'support-mode-edit' }]
                : []),
            ]}
          />
          <span className="text-xs text-muted">
            {t(options.allow_edit ? `support.mode.${mode}.hint` : 'support.mode.editOff')}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg-2">{t('support.duration')}</span>
          <Segmented
            label={t('support.duration')}
            value={hours}
            onChange={setHours}
            testId="support-duration"
            options={options.durations_hours.map((h) => ({
              value: String(h),
              label: durationLabel(h),
              testId: `support-duration-${h}`,
            }))}
          />
        </div>
        <Field label={t('support.reason')} hint={t('support.reasonHint')}>
          <Input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="support-reason"
          />
        </Field>
        {create.isError ? <Notice tone="error">{reasonMessage(create.error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="accent"
            disabled={!valid}
            busy={create.isPending}
            data-testid="support-grant-submit"
          >
            {t('support.grantSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
