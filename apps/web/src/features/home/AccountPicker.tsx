// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { t, type MessageKey } from '@bines/shared';
import { avatarColor, Badge, Button, cn, Notice, SkeletonRows } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage, type Me, type MyAccount, type MyInvitation, queryKeys } from '../../lib/api';
import { TopBar } from '../shell/TopBar';

/** `/`: jump to the last used account when possible (D12), otherwise list accounts + pending invitations. */
export const AccountPicker = ({ me }: { me: Me }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: queryKeys.myAccounts,
    queryFn: () => api().get<{ data: MyAccount[] }>('/me/accounts'),
  });
  const invitations = useQuery({
    queryKey: queryKeys.myInvitations,
    queryFn: () => api().get<{ data: MyInvitation[] }>('/me/invitations'),
  });
  const accept = useMutation({
    mutationFn: (id: string) => api().post<MyAccount>(`/me/invitations/${id}/accept`),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
    },
  });

  const list = accounts.data?.data ?? [];
  const pending = invitations.data?.data ?? [];
  const last =
    list.find((a) => a.id === me.last_account_id) ?? (list.length === 1 && !pending.length ? list[0] : undefined);

  useEffect(() => {
    if (last) void navigate({ to: '/a/$accountSlug', params: { accountSlug: last.slug }, replace: true });
  }, [last, navigate]);

  const tile = (name: string, accent: boolean) => (
    <span
      aria-hidden
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-[14px] font-display text-lg font-extrabold',
        accent ? 'bg-accent text-on-accent' : 'text-white',
      )}
      style={accent ? undefined : { backgroundColor: avatarColor(name) }}
    >
      {name.trim().charAt(0) || '?'}
    </span>
  );
  const ROW = 'flex items-center gap-3.5 rounded-[var(--radius-lg)] border border-line bg-surface px-4 py-3.5';
  const nameAndRole = (name: string, role: string) => (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate font-display text-[0.9375rem] leading-snug font-bold text-heading">{name}</span>
      <span className="text-xs text-muted">{role}</span>
    </span>
  );
  const currentId = list.find((a) => a.id === me.last_account_id)?.id ?? list[0]?.id;

  // Loading, or on the way to the last account: only a placeholder. The URL is already the account's while its route
  // loads, so a picker shown here (its own avatar menu, the account rows) flashed for a moment and took clicks meant
  // for the account's shell.
  if (accounts.isPending || invitations.isPending || last)
    return (
      <div className="flex min-h-dvh flex-col bg-shell" data-testid="account-picker-loading">
        <main className="app-panel m-2 flex-1 md:m-3">
          <div className="mx-auto my-6 w-full max-w-[640px] px-4 py-5">
            <SkeletonRows rows={3} label={t('app.loading')} />
          </div>
        </main>
      </div>
    );

  return (
    <div className="flex min-h-dvh flex-col bg-shell">
      <TopBar me={me} />
      <main className="app-panel mx-2 mb-2 flex-1 md:mx-3 md:mb-3">
        <div className="mx-auto my-6 flex w-full max-w-[640px] flex-col gap-5 px-4 py-5">
          <header className="space-y-1">
            <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
              {t('account.picker.title')}
            </h1>
            <p className="text-sm text-muted">{t('account.picker.subtitle')}</p>
          </header>
          {accept.isError ? <Notice tone="error">{errorMessage(accept.error)}</Notice> : null}

          {list.length ? (
            <ul className="flex flex-col gap-2.5">
              {list.map((a) => (
                <li key={a.id}>
                  <Link
                    to="/a/$accountSlug"
                    params={{ accountSlug: a.slug }}
                    className={cn(ROW, 'hover:border-line-strong hover:bg-surface-3')}
                  >
                    {tile(a.name, a.id === currentId)}
                    {nameAndRole(a.name, t(`role.${a.role}` as MessageKey))}
                    {a.status === 'suspended' ? (
                      <Badge tone="danger">{t('status.suspended')}</Badge>
                    ) : a.plan_status === 'closed' ? (
                      <Badge tone="danger">{t('plan.status.closed' as MessageKey)}</Badge>
                    ) : (
                      <Icon name="chevronEnd" size={18} className="shrink-0 text-muted" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          {pending.length ? (
            <section className="flex flex-col gap-2.5">
              <h2 className="text-[0.6875rem] font-semibold text-muted">{t('picker.invitations')}</h2>
              <ul className="flex flex-col gap-2.5">
                {pending.map((inv) => (
                  <li key={inv.id} className={ROW}>
                    {tile(inv.account.name, false)}
                    {nameAndRole(inv.account.name, t(`role.${inv.role}` as MessageKey))}
                    <Button
                      variant="accent"
                      onClick={() => accept.mutate(inv.id)}
                      busy={accept.isPending && accept.variables === inv.id}
                    >
                      {t('picker.accept')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {!list.length && !pending.length ? <Notice>{t('account.picker.empty')}</Notice> : null}

          {me.user.is_platform_owner ? (
            <Link
              to="/owner"
              className="inline-flex items-center gap-1.5 self-start text-xs font-semibold text-heading hover:underline"
            >
              <Icon name="shield" size={15} />
              {t('picker.owner')}
            </Link>
          ) : null}
        </div>
      </main>
    </div>
  );
};
