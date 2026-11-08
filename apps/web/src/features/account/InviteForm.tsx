// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountRoleSchema, he, t, type AccountRole, type MessageKey } from '@bines/shared';
import { Button, Field, Input, Notice, Picker, Switch } from '@bines/ui';
import { api, errorMessage, type InviteResult, queryKeys } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { PlanGateNote, usePlanGate } from '../../lib/plan-gate';
import { CopyLinkField } from './CopyLink';
import { linksHint } from './invite-links';
import { brandText } from '../../lib/branding';

const codeText = (code: string) => {
  const key = `error.${code}` as MessageKey;
  return key in he ? t(key) : code;
};

/**
 * Invite people by email (05 §2). From a board's permissions dialog (`board`), the invitee joins that board on
 * accepting; what they see and do there is the board's permissions. Guests only to shareable boards.
 */
export const InviteForm = ({ accountId, board }: { accountId: string; board?: { id: string; kind: string } }) => {
  const queryClient = useQueryClient();
  // Inviting guests needs the plan's `guests`: the role stays listed but cannot be picked (existing guests stay).
  const guestsGate = usePlanGate(accountId, 'guests');
  const [emails, setEmails] = useState('');
  const [picked, setRole] = useState<AccountRole>(board?.kind === 'shareable' ? 'guest' : 'member');
  // every invitation is emailed (branded as the account) unless "link only" is chosen.
  const [sendEmail, setSendEmail] = useState(true);
  const role: AccountRole = picked === 'guest' && !guestsGate.allowed ? 'member' : picked;
  const invite = useMutation({
    mutationFn: () =>
      api(accountId).post<InviteResult>('/users/invite', {
        emails: emails
          .split(/[,\s]+/)
          .map((e) => e.trim())
          .filter(Boolean),
        role,
        ...(board ? { board_ids: [board.id] } : {}),
        ...(sendEmail ? {} : { send_email: false }),
      }),
    onSuccess: async () => {
      setEmails('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations(accountId) });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };
  const roles = accountRoleSchema.options.filter((r) => r !== 'guest' || !board || board.kind === 'shareable');

  return (
    <div>
      {/* The email takes the full row; the role (growing) and the send button share the row below it. */}
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Field label={t('members.emails')} hint={t('members.emails.hint')}>
          <Input
            dir="ltr"
            required
            placeholder="name@company.co.il, …"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
          />
        </Field>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label={t('members.role')}>
              <Picker
                label={t('members.role')}
                value={role}
                onChange={(r) => setRole(r)}
                testId="invite-role"
                options={roles.map((r) => {
                  const gated = r === 'guest' && !guestsGate.allowed;
                  const label = t(`role.${r}` as MessageKey);
                  return {
                    value: r,
                    label: gated ? `${label} · ${t('plan.feature.notIncluded')}` : label,
                    disabled: gated,
                    testId: `invite-role-${r}`,
                  };
                })}
              />
            </Field>
          </div>
          <Button type="submit" busy={invite.isPending} data-testid="invite-send">
            {invite.isPending ? null : <Icon name="send" size={14} />}
            {t('members.send')}
          </Button>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-fg-2">
          <Switch checked={sendEmail} onChange={setSendEmail} testId="invite-send-email" />
          {t((sendEmail ? 'invites.sendEmail.on' : 'invites.sendEmail.off') as MessageKey)}
        </label>
        {roles.includes('guest') ? <PlanGateNote gate={guestsGate} /> : null}
      </form>
      {board && board.kind !== 'shareable' ? (
        <p className="mt-2 text-xs text-muted">{t('members.guestsNeedShareable')}</p>
      ) : null}
      <div className="space-y-2 empty:hidden [&:not(:empty)]:mt-4">
        {invite.isError ? <Notice tone="error">{errorMessage(invite.error)}</Notice> : null}
        {invite.data ? (
          <Notice tone={invite.data.errors.length ? 'info' : 'success'}>
            {t(
              (invite.data.invited.some((i) => i.status === 'link') ? 'invites.created' : 'members.sent') as MessageKey,
              {
                n: invite.data.invited.length,
              },
            )}
            {invite.data.errors.map((e) => (
              <span key={e.email} className="block">
                <span dir="ltr">{e.email}</span>: {codeText(e.code)}
              </span>
            ))}
          </Notice>
        ) : null}
        {/* fix8: every new invitation's link, to send by WhatsApp etc. when email does not arrive. */}
        {invite.data?.invited.some((i) => i.url) ? (
          <div className="space-y-2" data-testid="invite-links">
            <p className="text-xs text-muted">{linksHint(invite.data.invited)}</p>
            {invite.data.invited.map((i) =>
              i.url ? (
                <div key={i.id} className="space-y-1" data-testid="invite-link" data-email={i.email}>
                  <span className="block text-start text-xs font-semibold [unicode-bidi:isolate]" dir="ltr">
                    {i.email}
                  </span>
                  <CopyLinkField url={i.url} message={brandText('invite.links.message')} testId="invite-link-field" />
                </div>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
