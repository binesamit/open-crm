// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { type MyAccount, t } from '@bines/shared';
import { Button } from '@bines/ui';
import { confirmDialog } from '../../lib/dialogs';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { useOnboarding, useOnboardingActions } from './onboarding-api';

/**
 * Phase B: on a board that still holds sample rows a kit or a built structure brought, a quiet line
 * for the account's admins — "these are sample rows" — with "delete the sample data" (every board's, in one batch;
 * the toast's "undo" brings them back).
 */
export const SampleDataNotice = ({ account, boardId }: { account: MyAccount; boardId: string }) => {
  const admin = account.role === 'admin' && !account.support;
  const state = useOnboarding(account.id, admin).data;
  const actions = useOnboardingActions(account.id);
  const [busy, setBusy] = useState(false);
  if (!admin || !state?.sample.board_ids.includes(boardId)) return null;
  const remove = async () => {
    if (
      !(await confirmDialog({
        title: t('onboarding.sample.remove'),
        message: t('onboarding.sample.confirm', { n: state.sample.items }),
        confirmLabel: t('onboarding.sample.remove'),
      }))
    )
      return;
    setBusy(true);
    try {
      const out = await actions.removeSample();
      showToast({
        message: t('onboarding.sample.removed', { n: out.removed }),
        seconds: 10,
        ...(out.batch_id
          ? {
              action: {
                label: t('onboarding.build.undo'),
                run: () =>
                  actions
                    .undoBatch(out.batch_id!)
                    .catch((e: unknown) => showToast({ message: errorMessage(e), tone: 'error' })),
              },
            }
          : {}),
      });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-[13px] text-fg-2"
      data-testid="sample-notice"
    >
      <span className="flex-1">{t('onboarding.sample.notice')}</span>
      <Button size="sm" variant="secondary" busy={busy} onClick={() => void remove()} data-testid="sample-remove">
        {t('onboarding.sample.remove')}
      </Button>
    </div>
  );
};
