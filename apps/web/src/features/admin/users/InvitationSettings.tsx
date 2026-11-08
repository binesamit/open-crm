// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { invitationSettingsSchema, type InvitationSettings as Settings, type MyAccount, t } from '@bines/shared';
import { Button, Card, Field, Input, Switch } from '@bines/ui';
import { showToast } from '../../../lib/toast';
import { reasonMessage } from '../../account/CopyLink';
import { useAccountDetail, useUpdateAccount } from '../account-settings';

const DEFAULTS = invitationSettingsSchema.parse({});
const WHOLE = /^\d{1,4}$/;

/**
 * Administration → Users → invitation settings: how long a link lives, how soon the same invitation may
 * be emailed again, and whether the inviter hears when it is accepted. Empty field = the built-in default.
 */
export const InvitationSettingsCard = ({ account }: { account: MyAccount }) => {
  const detail = useAccountDetail(account);
  const saved = detail.data?.settings.invitations;
  if (!saved) return null;
  return <Form account={account} saved={saved} />;
};

const Form = ({ account, saved }: { account: MyAccount; saved: Settings }) => {
  const update = useUpdateAccount(account);
  const [expiry, setExpiry] = useState(String(saved.expiry_days));
  const [cooldown, setCooldown] = useState(String(saved.resend_cooldown_minutes));
  const [notify, setNotify] = useState(saved.notify_inviter);
  const expiryN = expiry.trim() ? Number(expiry.trim()) : DEFAULTS.expiry_days;
  const cooldownN = cooldown.trim() ? Number(cooldown.trim()) : DEFAULTS.resend_cooldown_minutes;
  const ok =
    (!expiry.trim() || WHOLE.test(expiry.trim())) &&
    (!cooldown.trim() || WHOLE.test(cooldown.trim())) &&
    invitationSettingsSchema.safeParse({
      expiry_days: expiryN,
      resend_cooldown_minutes: cooldownN,
      notify_inviter: notify,
    }).success;
  const dirty =
    expiryN !== saved.expiry_days || cooldownN !== saved.resend_cooldown_minutes || notify !== saved.notify_inviter;
  const save = () =>
    update.mutate(
      {
        settings: {
          invitations: { expiry_days: expiryN, resend_cooldown_minutes: cooldownN, notify_inviter: notify },
        },
      },
      {
        onSuccess: () => showToast({ message: t('admin.general.saved') }),
        onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
      },
    );
  return (
    <section data-testid="invitation-settings">
      <Card className="flex flex-col gap-3">
        <div className="space-y-0.5">
          <h2 className="font-display text-base font-bold text-heading">{t('invites.settings.title')}</h2>
          <p className="text-xs text-muted">{t('invites.settings.hint')}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('invites.settings.expiry')} hint={t('invites.settings.expiryHint')}>
            <Input
              value={expiry}
              maxLength={2}
              inputMode="numeric"
              dir="ltr"
              className="text-start"
              placeholder={String(DEFAULTS.expiry_days)}
              onChange={(e) => setExpiry(e.target.value)}
              data-testid="invitation-settings-expiry"
            />
          </Field>
          <Field label={t('invites.settings.cooldown')} hint={t('invites.settings.cooldownHint')}>
            <Input
              value={cooldown}
              maxLength={4}
              inputMode="numeric"
              dir="ltr"
              className="text-start"
              placeholder={String(DEFAULTS.resend_cooldown_minutes)}
              onChange={(e) => setCooldown(e.target.value)}
              data-testid="invitation-settings-cooldown"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-fg">
          <Switch checked={notify} onChange={setNotify} testId="invitation-settings-notify" />
          {t('invites.settings.notify')}
        </label>
        <div className="flex justify-end">
          <Button
            variant="accent"
            size="sm"
            disabled={!ok || !dirty}
            busy={update.isPending}
            onClick={save}
            data-testid="invitation-settings-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
    </section>
  );
};
