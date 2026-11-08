// SPDX-License-Identifier: AGPL-3.0-only
import { t, type MessageKey } from '@bines/shared';
import { Switch } from '@bines/ui';
import { CopyLinkField } from './CopyLink';
import { linksHint } from './invite-links';
import { brandText } from '../../lib/branding';

/** "שליחה במייל" (as in EmailInvite): off = no email to new people, only their links to copy. */
export const SendEmailSwitch = ({
  checked,
  onChange,
  testId,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  testId: string;
}) => (
  <label className="flex items-center gap-2.5 text-sm text-fg-2">
    <Switch checked={checked} onChange={onChange} testId={testId} />
    {t((checked ? 'invites.sendEmail.on' : 'invites.sendEmail.off') as MessageKey)}
  </label>
);

/** The new invitations' links after sending (fix8 +): each with copy / WhatsApp, under the links hint. */
export const InviteLinks = ({
  invited,
  testId,
}: {
  invited: { email: string; url?: string; expires_at?: string }[];
  testId: string;
}) =>
  invited.some((i) => i.url) ? (
    <div className="space-y-2" data-testid={testId}>
      <p className="text-xs text-muted">{linksHint(invited)}</p>
      {invited.map((i) =>
        i.url ? (
          <div key={i.email} className="space-y-1" data-testid={`${testId}-row`} data-email={i.email}>
            <span className="block text-start text-xs font-semibold [unicode-bidi:isolate]" dir="ltr">
              {i.email}
            </span>
            <CopyLinkField url={i.url} testId={`${testId}-link`} message={brandText('invite.links.message')} />
          </div>
        ) : null,
      )}
    </div>
  ) : null;
