// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatInstantDate, t, type MyAccount } from '@bines/shared';
import { Button, Notice } from '@bines/ui';
import { api, errorMessage, queryKeys, type Me } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { ExportPanel, deletionKey, useDeletionStatus } from '../admin/AccountData';
import { lockedPanelKeys } from './AccountClosed';
import { clearPlanBlock } from './plan-status';
import { useProfile } from './use-profile';

/**
 * the account scheduled for deletion — one full-screen panel instead of the app, like the closed
 * account (plan-lock): it cannot be dismissed, and the server refuses everything else of the account (403
 * `account_deletion_scheduled`). It says when the data is deleted for good and who asked; admins can download the
 * data (the export) and cancel the deletion — the app comes back at once. Everyone can switch account or sign out.
 */
export const AccountDeletionScreen = ({ me, account: initial }: { me: Me; account: MyAccount }) => {
  const qc = useQueryClient();
  const { list, switchTo, signOut } = useProfile(me, initial);
  const account = list.find((a) => a.id === initial.id) ?? initial;
  const admin = account.role === 'admin' && !account.support;
  const status = useDeletionStatus(account.id);
  const due = status.data?.due_at ?? account.deletion_due_at ?? null;
  const cancel = useMutation({
    mutationFn: () => api(account.id).post('/account-deletion/cancel'),
    onSuccess: async () => {
      clearPlanBlock(account.id);
      await qc.invalidateQueries({ queryKey: deletionKey(account.id) });
      await qc.invalidateQueries({ queryKey: queryKeys.myAccounts });
    },
  });
  const others = list.filter((a) => a.id !== account.id);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <div
      ref={panel}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={lockedPanelKeys}
      data-testid="account-deletion"
      className="fixed inset-0 z-system overflow-y-auto bg-shell outline-none"
    >
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-6 px-4 py-10">
        <header className="space-y-3 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
            <Icon name="trash" size={22} />
          </span>
          <h1 id={titleId} className="text-2xl font-bold text-fg" data-testid="account-deletion-title">
            {t('deletion.title', { name: account.name })}
          </h1>
          <p className="text-base text-fg-2" data-testid="account-deletion-date">
            {due ? t('deletion.when', { date: formatInstantDate(due) }) : t('deletion.whenUnknown')}
          </p>
          {status.data?.requested_by ? (
            <p className="text-sm text-muted">{t('deletion.by', { name: status.data.requested_by.name })}</p>
          ) : null}
          <p className="text-sm text-fg-2">{admin ? t('deletion.adminText') : t('deletion.memberText')}</p>
        </header>

        {admin ? (
          <section className="app-panel flex flex-col gap-4 p-5">
            <div className="space-y-1">
              <h2 className="text-base font-bold text-fg">{t('deletion.dataTitle')}</h2>
              <p className="text-sm text-fg-2">{t('deletion.dataText')}</p>
            </div>
            <ExportPanel accountId={account.id} />
            <div className="border-t border-line pt-4">
              {cancel.isError ? <Notice tone="error">{errorMessage(cancel.error)}</Notice> : null}
              <Button busy={cancel.isPending} onClick={() => cancel.mutate()} data-testid="account-deletion-cancel">
                <Icon name="restore" size={15} />
                {t('deletion.cancel')}
              </Button>
            </div>
          </section>
        ) : null}

        <footer className="flex flex-wrap items-center justify-center gap-2 border-t border-line pt-5">
          {others.length ? (
            <details className="relative" data-testid="deletion-switch">
              <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-[10px] border border-line-strong px-4 text-sm font-semibold text-fg hover:bg-hover">
                <Icon name="building" size={15} />
                {t('closed.switch')}
              </summary>
              <ul className="absolute inset-x-0 bottom-full z-10 mb-1 min-w-56 rounded-xl border border-line bg-surface p-1 shadow-lg">
                {others.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => void switchTo(a)}
                      className="w-full rounded-lg px-3 py-2 text-start text-sm text-fg hover:bg-hover"
                    >
                      {a.name}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <Button variant="secondary" onClick={() => void signOut()} data-testid="deletion-sign-out">
            <Icon name="logout" size={15} />
            {t('closed.signOut')}
          </Button>
        </footer>
      </div>
    </div>
  );
};
