// SPDX-License-Identifier: AGPL-3.0-only
import { EMAIL_OPENS, t, type EmailOpen, type MessageKey } from '@bines/shared';
import { Segmented } from '@bines/ui';

/** what a click on an email address does — the user's own (Profile → Appearance) or the account default. */
export const EmailOpenPicker = ({
  value,
  onChange,
  label,
  testId = 'email-open',
}: {
  value: EmailOpen;
  onChange: (v: EmailOpen) => void;
  label: string;
  testId?: string;
}) => (
  <Segmented
    label={label}
    value={value}
    onChange={onChange}
    testId={testId}
    options={EMAIL_OPENS.map((v) => ({
      value: v,
      label: t(`emailOpen.${v}` as MessageKey),
      testId: `${testId}-${v}`,
    }))}
  />
);
