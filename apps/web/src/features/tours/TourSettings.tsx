// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type MyAccount, t } from '@bines/shared';
import { Button, Card, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { useAccountDetail, useUpdateAccount } from '../admin/account-settings';
import { h2 } from '../admin/admin-parts';
import { tourKeys, useMyTours, useTourActions } from './tours-api';
import { checklistKeys } from '../checklist/checklist-api';

/**
 * My profile → appearance: "offer me a short tour the first time I open a screen" — the person's own
 * switch, every account and device. The "?" menu runs any tour either way.
 */
export const TourPrefs = ({ account }: { account: MyAccount }) => {
  const tours = useMyTours(account.id).data;
  const actions = useTourActions(account.id);
  if (!tours?.enabled) return null;
  return (
    <section className="space-y-1.5" data-testid="profile-tours">
      <label className="flex items-center gap-2.5 text-sm text-fg">
        <Switch
          checked={tours.offers}
          onChange={(on) =>
            void actions
              .setOffers(on)
              .then(() => showToast({ message: t('tour.prefs.saved') }))
              .catch((e) => showToast({ message: errorMessage(e), tone: 'error' }))
          }
          testId="profile-tours-offers"
        />
        {t('tour.prefs.offers')}
      </label>
      <p className="text-xs text-muted">{t('tour.prefs.hint')}</p>
    </section>
  );
};

/**
 * Administration → General → guided tours: the account's admins may turn the tours off for everyone
 * in the account (the platform's tours stay; nobody here is offered or shown them).
 */
export const ToursAdminCard = ({ account }: { account: MyAccount }) => {
  const saved = useAccountDetail(account).data?.settings.tours;
  const update = useUpdateAccount(account);
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [steps, setSteps] = useState<boolean | null>(null);
  if (!saved) return null;
  const value = enabled ?? saved.enabled;
  // "First steps" for the account's people.
  const stepsValue = steps ?? saved.first_steps;
  return (
    <section data-testid="admin-tours">
      <Card className="flex flex-col gap-3">
        <div className="space-y-0.5">
          <h2 className={h2}>{t('tour.admin.title')}</h2>
          <p className="text-xs text-muted">{t('tour.admin.hint')}</p>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-fg">
          <Switch checked={value} onChange={setEnabled} testId="admin-tours-enabled" />
          {t('tour.admin.enabled')}
        </label>
        <label className="flex items-center gap-2.5 text-sm text-fg">
          <Switch checked={stepsValue} onChange={setSteps} testId="admin-first-steps-enabled" />
          {t('checklist.admin.enabled')}
        </label>
        <div>
          <Button
            variant="accent"
            disabled={value === saved.enabled && stepsValue === saved.first_steps}
            busy={update.isPending}
            onClick={() =>
              update.mutate(
                { settings: { tours: { enabled: value, first_steps: stepsValue } } },
                {
                  onSuccess: () => {
                    setEnabled(null);
                    setSteps(null);
                    void qc.invalidateQueries({ queryKey: tourKeys.mine(account.id) });
                    void qc.invalidateQueries({ queryKey: checklistKeys.mine(account.id) });
                    showToast({ message: t('admin.general.saved') });
                  },
                  onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
                },
              )
            }
            data-testid="admin-tours-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
    </section>
  );
};
