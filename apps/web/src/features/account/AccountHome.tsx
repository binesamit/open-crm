// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDayMonth, t, type MessageKey } from '@bines/shared';
import { Avatar, Badge, Button, Card, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage, type Invitation, type Member, type MyAccount, queryKeys } from '../../lib/api';
import { Icon, type IconName } from '../../lib/icons';
import { useWindowedRows } from '../../lib/use-windowed-rows';
import { useWorkspaces } from '../board/board-api';
import { InviteForm } from './InviteForm';
import { InvitationStatusChip } from './Invitations';
import { Teams } from './Teams';
import { Templates } from './Templates';
import { useOnboarding } from '../onboarding/onboarding-api';

/** The card header of the home page (`.h3` at 16px): a title and something at its end. */
const HomeCardHeader = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="mb-3 flex items-center justify-between gap-2">
    <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">{title}</h2>
    {children}
  </div>
);

/** A bordered list (`.list`): rows split by soft lines. */
/** Long lists scroll inside the card (100+ users) so the 2×2 grid keeps teams / templates above the fold. */
const homeScrollList = 'max-h-[360px] overflow-x-hidden overflow-y-auto rounded-[14px] border border-line';
const homeRow = 'flex items-center gap-3 border-b border-line-soft bg-surface px-3 py-2.5 last:border-b-0';

const roleTone = (role: string) => (role === 'admin' ? 'ok' : role === 'guest' ? 'violet' : 'neutral');

/**
 * Account home — a welcome / overview page (account admin plan A1): the workspaces (each opens its page) and a
 * quick invite for everyone who may invite. Admins manage users, teams, templates and connections in
 * Administration (`/admin`), so they get shortcut cards to it here; everyone else keeps the users list (read
 * only), the teams and the templates on this page.
 */
export const AccountHome = ({ account }: { account: MyAccount }) => {
  const isAdmin = account.role === 'admin';
  // Right after a self sign-up the admin starts at "How to start?" until they choose or skip.
  const onboarding = useOnboarding(account.id, isAdmin);
  const navigate = useNavigate();
  useEffect(() => {
    if (onboarding.data?.pending)
      void navigate({ to: '/a/$accountSlug/start', params: { accountSlug: account.slug }, replace: true });
  }, [onboarding.data?.pending, account.slug, navigate]);

  return (
    <main className="w-full space-y-4 px-4 py-5 md:px-6">
      <section>
        <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-sm:text-2xl">
          {t('home.welcome', { account: account.name })}
        </h1>
        <p className="mt-1 max-w-[640px] text-muted">{t('home.overview')}</p>
      </section>
      {/* A guest has only their shared boards (in the sidebar) and their own profile — no account lists here. */}
      {account.role === 'guest' ? (
        <Card>
          <p className="text-fg-2">{t('home.guestHint')}</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          {isAdmin ? <AdminShortcuts account={account} /> : null}
          <Workspaces account={account} />
          {account.role !== 'viewer' ? (
            <Card>
              <HomeCardHeader title={t('members.invite')} />
              <InviteForm accountId={account.id} />
              {isAdmin ? <PendingInvitations account={account} /> : null}
            </Card>
          ) : null}
          {!isAdmin ? (
            <>
              <Members account={account} />
              <Teams account={account} />
              <Templates account={account} />
            </>
          ) : null}
        </div>
      )}
    </main>
  );
};

/** The workspaces I can see; each row opens the workspace's page. */
const Workspaces = ({ account }: { account: MyAccount }) => {
  const workspaces = useWorkspaces(account.id);
  const list = workspaces.data?.data ?? [];
  return (
    <Card>
      <HomeCardHeader title={t('home.workspaces')}>
        {workspaces.data ? <span className="text-xs text-muted">{list.length}</span> : null}
      </HomeCardHeader>
      {workspaces.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {workspaces.isError ? <Notice tone="error">{errorMessage(workspaces.error)}</Notice> : null}
      {list.length ? (
        <ul className={homeScrollList}>
          {list.map((w) => (
            <li key={w.id} className="border-b border-line-soft last:border-b-0">
              <Link
                to="/a/$accountSlug/w/$workspaceId"
                params={{ accountSlug: account.slug, workspaceId: w.id }}
                data-testid="home-workspace"
                data-name={w.name}
                className="flex items-center gap-3 bg-surface px-3 py-2.5 hover:bg-surface-2"
              >
                <span
                  aria-hidden
                  className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-accent text-[0.75rem] font-bold text-on-accent"
                >
                  {w.name.trim().charAt(0)}
                </span>
                <span className="min-w-0 flex-1 truncate font-semibold">{w.name}</span>
                {w.kind === 'closed' ? <Badge tone="violet">{t('workspace.kind.closed')}</Badge> : null}
                <Icon name="chevronEnd" size={14} className="shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
};

const SHORTCUTS: { section: 'users' | 'teams' | 'templates' | 'connections'; icon: IconName }[] = [
  { section: 'users', icon: 'person' },
  { section: 'teams', icon: 'people' },
  { section: 'templates', icon: 'template' },
  { section: 'connections', icon: 'key' },
];

/** Admins: what used to be managed on this page now lives in Administration — one tap to each section. */
const AdminShortcuts = ({ account }: { account: MyAccount }) => (
  <Card>
    <div data-testid="home-admin">
      <HomeCardHeader title={t('admin.title')}>
        <Link
          to="/a/$accountSlug/admin"
          params={{ accountSlug: account.slug }}
          data-testid="home-admin-open"
          className="text-sm font-semibold text-primary hover:underline"
        >
          {t('home.admin.open')}
        </Link>
      </HomeCardHeader>
      <p className="mb-3 text-sm text-muted">{t('home.admin.body')}</p>
      <div className="grid grid-cols-2 gap-2">
        {SHORTCUTS.map((s) => (
          <Link
            key={s.section}
            to="/a/$accountSlug/admin/$section"
            params={{ accountSlug: account.slug, section: s.section }}
            data-testid={`home-admin-${s.section}`}
            className="flex min-w-0 items-center gap-2.5 rounded-[12px] border border-line bg-surface px-3 py-2.5 font-semibold text-heading hover:border-line-strong hover:bg-surface-2"
          >
            <span
              aria-hidden
              className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary-soft text-primary"
            >
              <Icon name={s.icon} size={16} />
            </span>
            <span className="min-w-0 truncate">{t(`admin.section.${s.section}` as MessageKey)}</span>
          </Link>
        ))}
      </div>
    </div>
  </Card>
);

const Members = ({ account }: { account: MyAccount }) => {
  const members = useQuery({
    queryKey: queryKeys.members(account.id),
    queryFn: () => api(account.id).get<{ data: Member[] }>('/users'),
  });
  const list = members.data?.data ?? [];
  // A big account has hundreds of members: the card's scroll box mounts only the rows in view.
  const { attach, measure, ...windowed } = useWindowedRows<HTMLUListElement>({
    count: list.length,
    estimate: 62,
    getKey: (i) => list[i]!.user_id,
    scroll: 'self',
  });
  return (
    <Card>
      <HomeCardHeader title={t('members.title')}>
        {members.data ? <span className="text-xs text-muted">{list.length}</span> : null}
      </HomeCardHeader>
      {members.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
      {members.isError ? <Notice tone="error">{errorMessage(members.error)}</Notice> : null}
      {list.length ? (
        <ul ref={attach} className={homeScrollList} data-testid="home-members">
          {windowed.before ? <li aria-hidden style={{ height: windowed.before }} /> : null}
          {windowed.rows
            .map((v) => [v, list[v.index]!] as const)
            .map(([v, m]) => (
              <li key={v.key} ref={measure} data-index={v.index} className={homeRow}>
                <Avatar name={m.name || m.email} url={m.avatar_url} size={28} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">{m.name || m.email}</span>
                  {m.title || m.department ? (
                    <span className="truncate text-xs text-fg-2" data-testid="member-title">
                      {[m.title, m.department].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                  <span className="truncate text-end text-[0.6875rem] text-muted" dir="ltr">
                    {[m.email, m.phone].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <Badge tone={roleTone(m.role)}>{t(`role.${m.role}` as MessageKey)}</Badge>
              </li>
            ))}
          {windowed.after ? <li aria-hidden style={{ height: windowed.after }} /> : null}
        </ul>
      ) : null}
    </Card>
  );
};

/** Pending invitations, inside the invite card under a small label. */
const PendingInvitations = ({ account }: { account: MyAccount }) => {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.invitations(account.id),
    queryFn: () => api(account.id).get<{ data: Invitation[] }>('/users/invitations'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(account.id).delete(`/users/invitations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invitations(account.id) }),
  });
  const pending = list.data?.data ?? [];
  const { attach, measure, ...windowed } = useWindowedRows<HTMLUListElement>({
    count: pending.length,
    estimate: 58,
    getKey: (i) => pending[i]!.id,
    scroll: 'self',
  });
  if (!pending.length) return null;
  return (
    <section>
      <h3 className="pt-[1.125rem] pb-2 text-[0.6875rem] font-semibold text-muted">{t('members.pending')}</h3>
      <ul ref={attach} className={homeScrollList} data-testid="home-pending">
        {windowed.before ? <li aria-hidden style={{ height: windowed.before }} /> : null}
        {windowed.rows
          .map((v) => [v, pending[v.index]!] as const)
          .map(([v, inv]) => (
            <li key={v.key} ref={measure} data-index={v.index} className={homeRow}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-end font-semibold" dir="ltr">
                  {inv.email}
                </span>
                <span className="text-[0.6875rem] text-muted">
                  {t(`role.${inv.role}` as MessageKey)} ·{' '}
                  {t('members.expires', {
                    date: formatDayMonth(inv.expires_at),
                  })}
                </span>
              </span>
              <InvitationStatusChip inv={inv} />
              <Button
                variant="ghost"
                size="sm"
                className="text-danger-fg hover:text-danger-fg"
                onClick={() => revoke.mutate(inv.id)}
                busy={revoke.isPending && revoke.variables === inv.id}
              >
                {t('members.revoke')}
              </Button>
            </li>
          ))}
        {windowed.after ? <li aria-hidden style={{ height: windowed.after }} /> : null}
      </ul>
    </section>
  );
};
