// SPDX-License-Identifier: AGPL-3.0-only
import { PHONE_CLICK_CHOICES, t, type PhoneActionPrefs, type SetPhoneActionPrefs } from '@bines/shared';
import { Field, Notice, Picker, Segmented, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { usePhonePrefs, useSetPhonePrefs } from './phone-api';

const WHATSAPP = ['auto', 'app', 'web'] as const;
const SMS_MOBILE = ['ask', 'system', 'device'] as const;

/**
 * Profile → "Phone numbers": what a click on a phone number does for me (the menu, the column's
 * default action, or one action straight away), WhatsApp on a computer (app / browser), and SMS on a phone.
 * Per user, on every device (GET / PUT /me/phone-actions).
 */
export const PhonePrefsSection = () => {
  const prefs = usePhonePrefs();
  const set = useSetPhonePrefs();
  if (prefs.isError) return <Notice tone="error">{errorMessage(prefs.error)}</Notice>;
  if (!prefs.data) return <SkeletonRows rows={3} label={t('app.loading')} />;
  const p = prefs.data;
  const save = (patch: SetPhoneActionPrefs) =>
    set.mutate(patch, {
      onSuccess: () => showToast({ message: t('phone.prefs.saved'), seconds: 2 }),
      onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
    });
  return (
    <div className="flex flex-col gap-3" data-testid="phone-prefs">
      <Field label={t('phone.prefs.click')} hint={t('phone.prefs.clickHint')}>
        <Picker<PhoneActionPrefs['click']>
          value={p.click}
          label={t('phone.prefs.click')}
          testId="phone-prefs-click"
          onChange={(click) => save({ click })}
          options={PHONE_CLICK_CHOICES.map((c) => ({
            value: c,
            label: t(`phone.prefs.click.${c}`),
            testId: `phone-prefs-click-${c}`,
          }))}
        />
      </Field>
      <Field label={t('phone.prefs.whatsapp')} hint={t('phone.prefs.whatsappHint')}>
        <Segmented
          value={p.whatsapp_desktop}
          label={t('phone.prefs.whatsapp')}
          testId="phone-prefs-whatsapp"
          className="flex w-full [&>button]:flex-1"
          onChange={(whatsapp_desktop) => save({ whatsapp_desktop })}
          options={WHATSAPP.map((w) => ({
            value: w,
            label: t(`phone.prefs.whatsapp.${w}`),
            testId: `phone-prefs-whatsapp-${w}`,
          }))}
        />
      </Field>
      <Field label={t('phone.prefs.sms')} hint={t('phone.prefs.smsHint')}>
        <Segmented
          value={p.sms_mobile}
          label={t('phone.prefs.sms')}
          testId="phone-prefs-sms"
          className="flex w-full [&>button]:flex-1"
          onChange={(sms_mobile) => save({ sms_mobile })}
          options={SMS_MOBILE.map((s) => ({
            value: s,
            label: t(`phone.prefs.sms.${s}`),
            testId: `phone-prefs-sms-${s}`,
          }))}
        />
      </Field>
    </div>
  );
};
