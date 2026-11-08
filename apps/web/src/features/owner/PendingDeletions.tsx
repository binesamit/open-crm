// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInstantDate, type PendingDeletion, t } from '@bines/shared';
import { Button, Card, Dialog, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { CodeInput } from '../account/TwoFactor';

export const pendingDeletionsKey = ['platform', 'account-deletions'] as const;

/**
 * Owner console: the accounts scheduled for deletion, soonest first — cancel one (it opens again at
 * once) or delete it now, for good (its address typed again and the owner's own fresh two-factor code).
 */
export const usePendingDeletions = (enabled = true) =>
  useQuery({
    queryKey: pendingDeletionsKey,
    queryFn: () => api().get<{ data: PendingDeletion[] }>('/platform/account-deletions'),
    enabled,
  });

export const PendingDeletionsPanel = () => {
  const list = usePendingDeletions();
  const rows = list.data?.data ?? [];
  if (!list.isError && !rows.length) return null;
  return (
    <Card className="space-y-3" data-testid="owner-pending-deletions">
      <div className="space-y-0.5">
        <h2 className="font-display text-base font-bold text-heading">{t('owner.deletions.title')}</h2>
        <p className="text-xs text-muted">{t('owner.deletions.hint')}</p>
      </div>
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      <ul className="divide-y divide-line-soft overflow-hidden rounded-[12px] border border-line">
        {rows.map((r) => (
          <PendingRow key={r.id} row={r} />
        ))}
      </ul>
    </Card>
  );
};

const PendingRow = ({ row }: { row: PendingDeletion }) => {
  const qc = useQueryClient();
  const [now, setNow] = useState(false);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: pendingDeletionsKey });
    await qc.invalidateQueries({ queryKey: queryKeys.platformAccounts });
  };
  const cancel = useMutation({
    mutationFn: () => api().post(`/platform/accounts/${row.id}/deletion/cancel`),
    onSuccess: async () => {
      showToast({ message: t('owner.deletions.cancelled', { name: row.name }) });
      await refresh();
    },
  });
  return (
    <li className="flex flex-wrap items-center gap-3 bg-surface px-3.5 py-3" data-testid={`owner-deletion-${row.slug}`}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold text-fg">{row.name}</span>
        <span className="text-xs text-muted">
          {t('owner.deletions.due', { date: formatInstantDate(row.due_at) })}
          {row.requested_by
            ? ` · ${t('owner.deletions.by', { name: row.requested_by.name || row.requested_by.email })}`
            : ''}
        </span>
      </span>
      {cancel.isError ? <Notice tone="error">{errorMessage(cancel.error)}</Notice> : null}
      <Button
        variant="secondary"
        size="sm"
        busy={cancel.isPending}
        data-testid="owner-deletion-cancel"
        onClick={() =>
          void confirmDialog({
            title: t('owner.deletions.cancelTitle', { name: row.name }),
            message: t('owner.deletions.cancelBody'),
            confirmLabel: t('owner.deletions.cancel'),
          }).then((ok) => ok && cancel.mutate())
        }
      >
        {t('owner.deletions.cancel')}
      </Button>
      <Button variant="danger-outline" size="sm" data-testid="owner-deletion-now" onClick={() => setNow(true)}>
        {t('owner.deletions.now')}
      </Button>
      {now ? <DeleteNowDialog row={row} onClose={() => setNow(false)} onDone={refresh} /> : null}
    </li>
  );
};

export const DeleteNowDialog = ({
  row,
  onClose,
  onDone,
}: {
  row: PendingDeletion;
  onClose: () => void;
  onDone: () => Promise<void>;
}) => {
  const [slug, setSlug] = useState('');
  const [code, setCode] = useState('');
  const purge = useMutation({
    mutationFn: () => api().post(`/platform/accounts/${row.id}/deletion/now`, { confirm_slug: slug.trim(), code }),
    onSuccess: async () => {
      showToast({ message: t('owner.deletions.deleted', { name: row.name }) });
      onClose();
      await onDone();
    },
  });
  const can = slug.trim() === row.slug && code.length >= 6;
  return (
    <Dialog open onClose={onClose} title={t('owner.deletions.nowTitle', { name: row.name })} role="alertdialog">
      <form
        className="flex flex-col gap-3 whitespace-normal"
        data-testid="owner-delete-now-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (can) purge.mutate();
        }}
      >
        <Notice tone="error">{t('owner.deletions.nowBody')}</Notice>
        <Field label={t('owner.deletions.typeSlug', { slug: row.slug })}>
          <Input
            value={slug}
            dir="ltr"
            autoComplete="off"
            onChange={(e) => setSlug(e.target.value)}
            data-testid="owner-delete-now-slug"
          />
        </Field>
        <Field label={t('accountData.delete.code')}>
          <CodeInput value={code} onChange={setCode} testId="owner-delete-now-code" />
        </Field>
        {purge.isError ? <Notice tone="error">{errorMessage(purge.error)}</Notice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('accountData.cancel')}
          </Button>
          <Button
            type="submit"
            variant="danger"
            busy={purge.isPending}
            disabled={!can}
            data-testid="owner-delete-now-confirm"
          >
            {t('owner.deletions.nowConfirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
