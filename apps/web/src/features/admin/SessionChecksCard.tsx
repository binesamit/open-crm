// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { sessionChecksSettingsSchema, type SessionChecksSettings, type MyAccount, t } from '@bines/shared';
import { Button, Card, Field, Input, Switch } from '@bines/ui';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { useAccountDetail, useUpdateAccount } from './account-settings';
import { h2 } from './admin-parts';

const DEFAULTS = sessionChecksSettingsSchema.parse({});
const WHOLE = /^\d{1,4}$/;

/**
 * Administration → Connections → outside work sessions: whether tools such as code sessions check
 * the account for changes on their items at all (off by default), and how many minutes apart. Empty field = the
 * built-in interval.
 */
export const SessionChecksCard = ({ account }: { account: MyAccount }) => {
  const saved = useAccountDetail(account).data?.settings.session_checks;
  if (!saved) return null;
  return <Form account={account} saved={saved} />;
};

const Form = ({ account, saved }: { account: MyAccount; saved: SessionChecksSettings }) => {
  const update = useUpdateAccount(account);
  const [enabled, setEnabled] = useState(saved.enabled);
  const [minutes, setMinutes] = useState(String(saved.interval_minutes));
  const intervalN = minutes.trim() ? Number(minutes.trim()) : DEFAULTS.interval_minutes;
  const ok =
    (!minutes.trim() || WHOLE.test(minutes.trim())) &&
    sessionChecksSettingsSchema.safeParse({ enabled, interval_minutes: intervalN }).success;
  const dirty = enabled !== saved.enabled || intervalN !== saved.interval_minutes;
  const save = () =>
    update.mutate(
      { settings: { session_checks: { enabled, interval_minutes: intervalN } } },
      {
        onSuccess: () => showToast({ message: t('admin.general.saved') }),
        onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
      },
    );
  return (
    <section data-testid="session-checks">
      <Card className="flex flex-col gap-3">
        <div className="space-y-0.5">
          <h2 className={h2}>{t('admin.sessionChecks.title')}</h2>
          <p className="text-xs text-muted">{t('admin.sessionChecks.hint')}</p>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-fg">
          <Switch checked={enabled} onChange={setEnabled} testId="session-checks-enabled" />
          {t('admin.sessionChecks.enabled')}
        </label>
        <Field label={t('admin.sessionChecks.interval')} hint={t('admin.sessionChecks.intervalHint')}>
          <Input
            value={minutes}
            maxLength={4}
            inputMode="numeric"
            dir="ltr"
            className="text-start sm:max-w-40"
            placeholder={String(DEFAULTS.interval_minutes)}
            disabled={!enabled}
            onChange={(e) => setMinutes(e.target.value)}
            data-testid="session-checks-interval"
          />
        </Field>
        <div className="flex justify-end">
          <Button
            variant="accent"
            size="sm"
            disabled={!ok || !dirty}
            busy={update.isPending}
            onClick={save}
            data-testid="session-checks-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
    </section>
  );
};
