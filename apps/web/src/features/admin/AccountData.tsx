// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AccountDeletionStatus,
  type AccountExport,
  deletionNameMatches,
  formatDateTime,
  type MyAccount,
  t,
} from '@bines/shared';
import { Badge, Button, Card, Dialog, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { CodeInput } from '../account/TwoFactor';

/**
 * Administration → General → "Your data" — the full export (one ZIP, built in the background, its
 * link valid for the platform's export period) and "Delete the account" (the export offered first, then the name
 * typed again, then a fresh two-factor code). After that the account shows only the "scheduled for deletion" screen.
 */

export const exportsKey = (accountId: string) => ['account', accountId, 'account-export'] as const;
export const deletionKey = (accountId: string) => ['account', accountId, 'account-deletion'] as const;

const busy = (e: AccountExport | undefined) => e?.status === 'pending' || e?.status === 'running';

/** The account's exports (newest first); asked again every few seconds while one is being built. */
export const useAccountExports = (accountId: string) =>
  useQuery({
    queryKey: exportsKey(accountId),
    queryFn: () => api(accountId).get<{ data: AccountExport[] }>('/account-export'),
    refetchInterval: (q) => (busy(q.state.data?.data[0]) ? 4000 : false),
  });

export const useDeletionStatus = (accountId: string) =>
  useQuery({
    queryKey: deletionKey(accountId),
    queryFn: () => api(accountId).get<AccountDeletionStatus>('/account-deletion'),
  });

/** Opens a ready export's short-lived link (the browser downloads it). */
export const downloadExport = async (accountId: string, id: string) => {
  const { url } = await api(accountId).get<{ url: string }>(`/account-export/${id}/download`);
  window.location.assign(url);
};

const sizeText = (bytes: number | null) => {
  if (bytes === null) return '';
  const mb = bytes / (1024 * 1024);
  return mb < 1
    ? t('accountData.export.sizeKb', { n: Math.max(1, Math.round(bytes / 1024)) })
    : t('accountData.export.sizeMb', { n: Math.round(mb * 10) / 10 });
};

/** The newest export: building / ready (download) / failed / expired, and "export again". */
export const ExportPanel = ({ accountId, compact }: { accountId: string; compact?: boolean }) => {
  const qc = useQueryClient();
  const exports = useAccountExports(accountId);
  const latest = exports.data?.data[0];
  const start = useMutation({
    mutationFn: () => api(accountId).post<AccountExport>('/account-export'),
    onSuccess: () => qc.invalidateQueries({ queryKey: exportsKey(accountId) }),
  });
  const download = useMutation({ mutationFn: (id: string) => downloadExport(accountId, id) });
  // The server marks an export `expired` once its time is up (the download refuses it meanwhile too).
  const ready = latest?.status === 'ready' && !!latest.expires_at;
  const error = start.error ?? download.error ?? exports.error;
  return (
    <div className="flex flex-col gap-2.5" data-testid="account-export">
      {latest && busy(latest) ? (
        <Notice tone="info">
          <span data-testid="account-export-building">{t('accountData.export.building')}</span>
        </Notice>
      ) : null}
      {latest && ready ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="account-export-ready">
          <Button
            size="sm"
            busy={download.isPending}
            onClick={() => download.mutate(latest.id)}
            data-testid="account-export-download"
          >
            <Icon name="download" size={14} />
            {t('accountData.export.download')}
          </Button>
          <span className="text-xs text-muted">
            {t('accountData.export.readyUntil', { date: formatDateTime(latest.expires_at!) })}
            {latest.size_bytes !== null ? ` · ${sizeText(latest.size_bytes)}` : ''}
          </span>
        </div>
      ) : null}
      {latest && ready && latest.summary && !compact ? (
        <p className="text-xs text-muted" data-testid="account-export-summary">
          {t('accountData.export.summary', {
            boards: latest.summary.boards,
            docs: latest.summary.docs,
            files: latest.summary.files,
            users: latest.summary.users,
          })}
          {latest.summary.skipped.length
            ? ` · ${t('accountData.export.skipped', { n: latest.summary.skipped.length })}`
            : ''}
        </p>
      ) : null}
      {latest?.status === 'failed' ? (
        <Notice tone="error">
          <span data-testid="account-export-failed">{t('accountData.export.failed')}</span>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      {!busy(latest) ? (
        <div>
          <Button
            variant={ready ? 'secondary' : 'primary'}
            size="sm"
            busy={start.isPending}
            onClick={() => start.mutate()}
            data-testid="account-export-start"
          >
            <Icon name="download" size={14} />
            {ready ? t('accountData.export.again') : t('accountData.export.start')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

type Step = 'export' | 'name' | 'code';

/**
 * "Delete the account": three steps in one dialog — (1) take the data out first (the export, optional), (2) type the
 * account's name, (3) a fresh code from the authenticator app. Without two-factor sign-in the last step explains
 * how to turn it on and cannot be passed (the server refuses too).
 */
export const DeleteAccountDialog = ({
  account,
  status,
  onClose,
}: {
  account: MyAccount;
  status: AccountDeletionStatus;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('export');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const schedule = useMutation({
    mutationFn: () => api(account.id).post<AccountDeletionStatus>('/account-deletion', { confirm_name: name, code }),
    onSuccess: async () => {
      onClose();
      await qc.invalidateQueries({ queryKey: queryKeys.myAccounts });
    },
  });
  const nameOk = deletionNameMatches(name, account.name);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('accountData.delete.title', { name: account.name })}
      subtitle={t(`accountData.delete.step.${step}`)}
      role="alertdialog"
    >
      <div className="flex flex-col gap-3 whitespace-normal" data-testid="delete-account-dialog">
        {step === 'export' ? (
          <>
            <Notice tone="warn">{t('accountData.delete.what', { days: status.grace_days })}</Notice>
            <p className="text-sm text-fg-2">{t('accountData.delete.exportFirst')}</p>
            <ExportPanel accountId={account.id} compact />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                {t('accountData.cancel')}
              </Button>
              <Button variant="danger" onClick={() => setStep('name')} data-testid="delete-account-next">
                {t('accountData.delete.continue')}
              </Button>
            </div>
          </>
        ) : null}
        {step === 'name' ? (
          <>
            <Field label={t('accountData.delete.typeName', { name: account.name })}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                data-testid="delete-account-name"
              />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => setStep('export')}>
                {t('accountData.back')}
              </Button>
              <Button
                variant="danger"
                disabled={!nameOk}
                onClick={() => setStep('code')}
                data-testid="delete-account-name-next"
              >
                {t('accountData.delete.continue')}
              </Button>
            </div>
          </>
        ) : null}
        {step === 'code' ? (
          status.two_factor_enabled ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length >= 6) schedule.mutate();
              }}
            >
              <Field label={t('accountData.delete.code')}>
                <CodeInput value={code} onChange={setCode} testId="delete-account-code" />
              </Field>
              <p className="text-xs text-muted">{t('accountData.delete.final', { days: status.grace_days })}</p>
              {schedule.isError ? <Notice tone="error">{errorMessage(schedule.error)}</Notice> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setStep('name')}>
                  {t('accountData.back')}
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  busy={schedule.isPending}
                  disabled={code.length < 6}
                  data-testid="delete-account-confirm"
                >
                  {t('accountData.delete.confirm')}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <Notice tone="error">
                <span data-testid="delete-account-no2fa">{t('accountData.delete.no2fa')}</span>
              </Notice>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={onClose}>
                  {t('accountData.cancel')}
                </Button>
              </div>
            </>
          )
        ) : null}
      </div>
    </Dialog>
  );
};

/** The section at the end of Administration → General. */
export const AccountDataSection = ({ account }: { account: MyAccount }) => {
  const status = useDeletionStatus(account.id);
  const [deleting, setDeleting] = useState(false);
  return (
    <Card className="p-0" data-testid="admin-general-data">
      <div className="space-y-0.5 border-b border-line-soft px-3.5 pt-3.5 pb-3">
        <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">{t('accountData.title')}</h2>
        <p className="text-xs text-muted">{t('accountData.hint')}</p>
      </div>
      <div className="flex flex-col gap-2 border-b border-line-soft px-3.5 py-3">
        <div className="text-sm font-semibold text-fg">{t('accountData.export.title')}</div>
        <p className="text-xs text-muted">{t('accountData.export.hint', { days: status.data?.export_days ?? 7 })}</p>
        <ExportPanel accountId={account.id} />
      </div>
      <div className="flex items-center gap-3 px-3.5 py-3 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            {t('accountData.delete.button')}
            <Badge tone="danger">{t('accountData.delete.badge')}</Badge>
          </div>
          <p className="text-xs text-muted">{t('accountData.delete.hint', { days: status.data?.grace_days ?? 30 })}</p>
        </div>
        <Button
          variant="danger-outline"
          size="sm"
          disabled={!status.data}
          onClick={() => setDeleting(true)}
          data-testid="delete-account-open"
        >
          {t('accountData.delete.button')}
        </Button>
      </div>
      {deleting && status.data ? (
        <DeleteAccountDialog account={account} status={status.data} onClose={() => setDeleting(false)} />
      ) : null}
    </Card>
  );
};
