// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { t, type AccountRole, type MessageKey } from '@bines/shared';
import { Button, Field, Input, Notice, Picker, Switch } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { CopyLinkField } from '../account/CopyLink';
import { linksHint } from '../account/invite-links';
import { brandText } from '../../lib/branding';

/** What a board / workspace invite answers: invitations sent, people already in the account added at once. */
export type EmailInviteResult = {
  /** `url` (fix8): the invitation link, to send another way when email does not arrive. */
  invited: { email: string; url?: string; expires_at?: string }[];
  added?: { email: string }[];
  errors: { email?: string; user_id?: string; code: string }[];
};

const errorText = (code: string) => {
  const key = `error.${code}` as MessageKey;
  const text = t(key);
  return text === key ? code : text;
};

/**
 * Invite by email into a place (owner fix6-server 3): a board's members section or a workspace's.
 * People already in the account join at once; new people get an account invitation that brings them in on
 * accepting. `roles` = the account roles new people may get here (guests only where the place allows them).
 */
export const EmailInvite = <R extends EmailInviteResult>({
  accountId,
  path,
  roles,
  defaultRole,
  note,
  testId,
  onDone,
}: {
  accountId: string;
  /** POST endpoint taking `{emails, role}`. */
  path: string;
  roles: AccountRole[];
  defaultRole: AccountRole;
  note?: string | null;
  testId: string;
  onDone?: (result: R) => void;
}) => {
  const queryClient = useQueryClient();
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<AccountRole>(defaultRole);
  // new people get the account's branded email unless "link only" is chosen.
  const [sendEmail, setSendEmail] = useState(true);
  const current = roles.includes(role) ? role : defaultRole;
  const invite = useMutation({
    mutationFn: () =>
      api(accountId).post<R>(path, {
        emails: emails
          .split(/[,\s]+/)
          .map((e) => e.trim())
          .filter(Boolean),
        role: current,
        ...(sendEmail ? {} : { send_email: false }),
      }),
    onSuccess: async (res) => {
      setEmails('');
      onDone?.(res);
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations(accountId) });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  return (
    <div data-testid={testId}>
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Field label={t('members.emails')} hint={t('members.emails.hint')}>
          <Input
            dir="ltr"
            required
            placeholder="name@company.co.il, …"
            value={emails}
            data-testid={`${testId}-emails`}
            onChange={(e) => setEmails(e.target.value)}
          />
        </Field>
        <div className="flex items-end gap-2">
          {roles.length > 1 ? (
            <div className="min-w-0 flex-1">
              <Field label={t('members.role')}>
                <Picker
                  label={t('members.role')}
                  value={current}
                  onChange={(r) => setRole(r)}
                  options={roles.map((r) => ({ value: r, label: t(`role.${r}` as MessageKey) }))}
                />
              </Field>
            </div>
          ) : (
            <span className="flex-1" />
          )}
          <Button type="submit" busy={invite.isPending} data-testid={`${testId}-send`}>
            {invite.isPending ? null : <Icon name="send" size={14} />}
            {t('members.send')}
          </Button>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-fg-2">
          <Switch checked={sendEmail} onChange={setSendEmail} testId={`${testId}-send-email`} />
          {t((sendEmail ? 'invites.sendEmail.on' : 'invites.sendEmail.off') as MessageKey)}
        </label>
      </form>
      {note ? <p className="mt-2 text-xs text-muted">{note}</p> : null}
      <div className="space-y-2 empty:hidden [&:not(:empty)]:mt-4">
        {invite.isError ? <Notice tone="error">{errorMessage(invite.error)}</Notice> : null}
        {invite.data ? (
          <Notice tone={invite.data.errors.length ? 'info' : 'success'}>
            <span data-testid={`${testId}-result`}>
              {t((sendEmail ? 'members.sent' : 'invites.created') as MessageKey, { n: invite.data.invited.length })}
              {invite.data.added?.length ? ` ${t('invite.addedNow', { n: invite.data.added.length })}` : null}
            </span>
            {invite.data.errors.map((e) => (
              <span key={e.email ?? e.user_id} className="block" dir="ltr">
                {e.email ?? e.user_id}: {errorText(e.code)}
              </span>
            ))}
          </Notice>
        ) : null}
        {invite.data?.invited.some((i) => i.url) ? (
          <div className="space-y-2" data-testid={`${testId}-links`}>
            <p className="text-xs text-muted">{linksHint(invite.data.invited)}</p>
            {invite.data.invited.map((i) =>
              i.url ? (
                <div key={i.email} className="space-y-1">
                  <span className="block text-start text-xs font-semibold [unicode-bidi:isolate]" dir="ltr">
                    {i.email}
                  </span>
                  <CopyLinkField url={i.url} message={brandText('invite.links.message')} />
                </div>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
