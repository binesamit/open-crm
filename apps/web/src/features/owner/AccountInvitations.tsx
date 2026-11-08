// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountRoleSchema, type AccountRole, t } from '@bines/shared';
import { Button, Dialog, EmptyState, Field, Input, Notice, Picker, SkeletonRows, Switch } from '@bines/ui';
import { api, type Invitation, type PlatformAccount, queryKeys } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { CopyLinkField, reasonMessage } from '../account/CopyLink';
import {
  InvitationActions,
  type InvitationHandlers,
  InvitationLinkDialog,
  InvitationRowBody,
  type ReissueResult,
} from '../account/Invitations';
import { linksHint } from '../account/invite-links';
import { brandText } from '../../lib/branding';

/** The owner console's view of one account's invitations. */
export const platformInvitationsKey = (accountId: string) =>
  ['platform', 'accounts', accountId, 'invitations'] as const;

const days = (n?: number) => (n ? `?expires_in_days=${n}` : '');

/**
 * Owner console → an account → "הזמנות": invite anyone (the first admin or any role), emailed or as a
 * link to copy, and manage the account's open invitations — send again, copy a fresh link, cancel. The back-door rule
 * holds on the server: nothing that hands the owner's own address a link without an edit grant of the account.
 */
export const AccountInvitationsDialog = ({ account, onClose }: { account: PlatformAccount; onClose: () => void }) => {
  const qc = useQueryClient();
  const key = platformInvitationsKey(account.id);
  const base = `/platform/accounts/${account.id}/invitations`;
  const list = useQuery({ queryKey: key, queryFn: () => api().get<{ data: Invitation[] }>(base) });
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: key }),
      qc.invalidateQueries({ queryKey: queryKeys.platformAccounts }),
    ]);
  };
  const after = async <T,>(p: Promise<T>) => {
    const res = await p;
    await refresh();
    return res;
  };
  const handlers: InvitationHandlers = {
    resend: (id, n) => after(api().post<ReissueResult>(`${base}/${id}/resend${days(n)}`)),
    link: (id, n) => after(api().post<ReissueResult>(`${base}/${id}/link${days(n)}`)),
    revoke: (id) => after(api().delete(`${base}/${id}`)),
  };

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('admin');
  const [sendEmail, setSendEmail] = useState(true);
  const invite = useMutation({
    mutationFn: () => api().post<ReissueResult>(base, { email: email.trim(), role, send_email: sendEmail }),
    onSuccess: async () => {
      setEmail('');
      await refresh();
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };
  const [shown, setShown] = useState<{ email: string; url: string; emailed: boolean } | null>(null);
  const [now] = useState(() => Date.now());
  const rows = list.data?.data ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('invites.owner.title')}
      subtitle={account.name}
      className="md:max-w-[760px]"
    >
      <div className="flex flex-col gap-4 whitespace-normal" data-testid="owner-invitations-dialog">
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-[2_1_220px]">
              <Field label={t('members.emails')}>
                <Input
                  type="email"
                  dir="ltr"
                  required
                  className="text-start"
                  placeholder="name@company.co.il"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="owner-invite-email"
                />
              </Field>
            </div>
            <div className="min-w-[140px] flex-[1_1_140px]">
              <Field label={t('members.role')}>
                <Picker
                  label={t('members.role')}
                  value={role}
                  onChange={setRole}
                  testId="owner-invite-role"
                  options={accountRoleSchema.options.map((r) => ({
                    value: r,
                    label: t(`role.${r}`),
                    testId: `owner-invite-role-${r}`,
                  }))}
                />
              </Field>
            </div>
            <Button type="submit" busy={invite.isPending} data-testid="owner-invite-send">
              {invite.isPending ? null : <Icon name="send" size={14} />}
              {t(sendEmail ? 'members.send' : 'invites.createLink')}
            </Button>
          </div>
          <label className="flex items-center gap-2.5 text-sm text-fg-2">
            <Switch checked={sendEmail} onChange={setSendEmail} testId="owner-invite-send-email" />
            {t(sendEmail ? 'invites.sendEmail.on' : 'invites.sendEmail.off')}
          </label>
        </form>
        {invite.isError ? <Notice tone="error">{reasonMessage(invite.error)}</Notice> : null}
        {invite.data ? (
          <div className="space-y-2" data-testid="owner-invite-result">
            <Notice tone={invite.data.emailed || !sendEmail ? 'success' : 'error'}>
              {t(
                invite.data.emailed
                  ? 'owner.accounts.created'
                  : invite.data.invitation.status === 'link'
                    ? 'invites.linkReady'
                    : 'owner.accounts.createdNoEmail',
                { email: invite.data.invitation.email },
              )}
            </Notice>
            {invite.data.invitation.url ? (
              <>
                <p className="text-xs text-muted">{linksHint([invite.data.invitation])}</p>
                <CopyLinkField
                  url={invite.data.invitation.url}
                  message={brandText('invite.links.message')}
                  testId="owner-invite-link"
                />
              </>
            ) : null}
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-heading">
            {t('invites.open')} <span className="font-normal text-muted">({rows.length})</span>
          </h3>
          {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
          {list.isError ? <Notice tone="error">{reasonMessage(list.error)}</Notice> : null}
          {list.data && !rows.length ? (
            <EmptyState icon={<Icon name="send" size={24} />} title={t('invites.none')} />
          ) : null}
          {rows.length ? (
            <ul className="overflow-hidden rounded-[12px] border border-line" data-testid="owner-invitations">
              {rows.map((inv) => (
                <li
                  key={inv.id}
                  data-testid="invitation-row"
                  data-email={inv.email}
                  data-status={inv.status}
                  className="border-b border-line-soft bg-surface px-3 py-2.5 last:border-b-0"
                >
                  <InvitationRowBody
                    inv={inv}
                    now={now}
                    actions={<InvitationActions inv={inv} handlers={handlers} onLink={setShown} />}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted">{t('invites.owner.rule')}</p>
        </section>
      </div>
      <InvitationLinkDialog shown={shown} onClose={() => setShown(null)} />
    </Dialog>
  );
};
