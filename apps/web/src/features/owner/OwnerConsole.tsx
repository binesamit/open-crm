// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ApiError } from '@bines/sdk';
import {
  type AccountOrigin,
  formatDateTime,
  slugFromName,
  t,
  type RecoveryLink,
  type TemplateSet,
} from '@bines/shared';
import { Badge, Button, Card, cn, Dialog, EmptyState, Field, Input, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { SupportConsole } from './support/SupportConsole';
import { ErrorsHub } from './errors/ErrorsHub';
import { Icon } from '../../lib/icons';
import { TD, TH, TR, useNarrow } from '../trash/TrashPage';
import { api, errorMessage, type Invitation, type Me, type PlatformAccount, queryKeys } from '../../lib/api';
import { confirmDialog, promptDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { timeLeft } from '../admin/SupportBanner';
import { EmergencyRequests, emergencyKey, useEmergencyRequests } from './EmergencyRequests';
import { TopBar } from '../shell/TopBar';
import { CopyLinkField, reasonMessage } from '../account/CopyLink';
import { OwnerExtensions } from '../extensions/OwnerExtensions';
import { KitPicker, StarterKitsPanel } from './StarterKits';
import {
  EmailOffNotice,
  PlatformConnectionsSettings,
  PlatformEmailSettings,
  PlatformGeneralSettings,
  PlatformSecuritySettings,
  PlatformSupportSettings,
} from './PlatformSettings';
import { ConsoleTwoFactorGate } from '../account/TwoFactorGate';
import { AiPricesPanel } from './AiPrices';
import { CostsSection } from './costs/CostsSection';
import { WebSearchPlatformCard } from './WebSearchPlatformCard';
import { LoginProvidersPanel } from './LoginProviders';
import { AccountPlanBadge, AccountPlanDialog, PlansPanel, useSubscriptions } from './Plans';
import { AccountInvitationsDialog } from './AccountInvitations';
import { PendingDeletionsPanel, usePendingDeletions } from './PendingDeletions';
import type { Subscription } from '@bines/shared';
import { LegalDocumentsPanel } from './LegalDocuments';
import { SecurityIncidentsPanel } from './SecurityIncidents';
import { SignupRequestsPanel } from './SignupRequests';
import { SignupSettingsCard } from './SignupSettings';
import { FirstStepsCard } from './FirstSteps';
import { LicensingSection } from '../licensing/LicensingSection';
import { INSTALL_GUIDE, OwnerGuidesSection } from '../guides/OwnerGuides';
import { type OwnerSection, SUPPORT_SECTIONS } from './console-sections';
import { OwnerNav, useConsoleCounts, WaitingList } from './OwnerNav';

type LinkShown = { title: string; subtitle: string; url: string; note: string; testId: string };

/**
 * Owner console (D12): create, suspend and restore accounts; invite admins. No access to account data.
 * Plan: a "Support" section (tickets); support staff open the console and see only Support and Errors.
 * a side nav of sections (`?section=`), one section shown at a time, instead of one long page.
 */
type ConsoleProps = {
  me: Me;
  section?: OwnerSection;
  ticket?: string;
  error?: string;
  /** Guides: which guide (`install` or an owner guide's id) and which section of it. */
  guide?: string;
  anchor?: string;
};

/** S-77: when the console requires two-factor sign-in and I have not turned it on, I turn it on first. */
export const OwnerConsole = (props: ConsoleProps) => (
  <ConsoleTwoFactorGate>
    <ConsoleBody {...props} />
  </ConsoleTwoFactorGate>
);

const ConsoleBody = ({ me, section, ...rest }: ConsoleProps) => {
  const owner = me.user.is_platform_owner;
  // Support staff asking for an owner's section get Support (their first section).
  const current: OwnerSection =
    section && (owner || SUPPORT_SECTIONS.includes(section)) ? section : owner ? 'overview' : 'support';
  const counts = useConsoleCounts(me);
  return (
    <OwnerFrame owner={owner} me={me} current={current} counts={counts}>
      <SectionBody section={current} owner={owner} counts={counts} {...rest} />
    </OwnerFrame>
  );
};

/** The console's frame: the top bar, the title, the section nav and the section. */
const OwnerFrame = ({
  me,
  owner,
  current,
  counts,
  children,
}: {
  me: Me;
  owner: boolean;
  current: OwnerSection;
  counts: Partial<Record<OwnerSection, number>>;
  children: ReactNode;
}) => (
  <div className="flex min-h-dvh flex-col bg-shell">
    <TopBar me={me} />
    <main className="app-panel mx-2 mb-2 flex-1 md:mx-3 md:mb-3">
      <div className="space-y-4 px-4 py-5 md:px-6">
        <header className="space-y-1">
          <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
            {owner ? t('owner.title') : t('tickets.console.title')}
          </h1>
          <p className="max-w-[640px] text-sm text-muted">
            {owner ? t('owner.subtitle') : t('tickets.console.subtitle')}
          </p>
        </header>
        <div className="flex gap-6 max-md:flex-col max-md:gap-4">
          <OwnerNav current={current} owner={owner} counts={counts} />
          <section className="min-w-0 flex-1 space-y-4" data-testid={`owner-panel-${current}`} data-section={current}>
            {children}
          </section>
        </div>
      </div>
    </main>
  </div>
);

/** One section's content: the console's existing cards, each where the approved canvas put it. */
const SectionBody = ({
  section,
  owner,
  counts,
  ticket,
  error,
  guide,
  anchor,
}: Omit<ConsoleProps, 'me' | 'section'> & {
  section: OwnerSection;
  owner: boolean;
  counts: Partial<Record<OwnerSection, number>>;
}) => {
  const navigate = useNavigate();
  switch (section) {
    case 'overview':
      return (
        <>
          {/* First steps (SIGNUP plan, decision 12): until every step is done or the owner closes it. */}
          <FirstStepsCard />
          <EmailOffNotice />
          <WaitingList counts={counts} />
        </>
      );
    case 'accounts':
      return <AccountsSection />;
    case 'signup-requests':
      return <SignupRequestsPanel always />;
    case 'emergency':
      return <EmergencySection />;
    case 'deletions':
      return <DeletionsSection />;
    case 'plans':
      return <PlansPanel />;
    case 'signup':
      return <SignupSettingsCard />;
    case 'licensing':
      // Licensing (docs/LICENSING.md): the license, its settings, editions — and, on a license server, its lists.
      return (
        <LicensingSection
          // "How licensing works" on the license card: the installation guide, at that section.
          onGuide={(at) =>
            void navigate({ to: '/owner', search: { section: 'guides', guide: INSTALL_GUIDE, anchor: at } })
          }
        />
      );
    case 'ai-prices':
      return (
        <>
          {/* Web search for agents: the platform's master switch. */}
          <WebSearchPlatformCard />
          <AiPricesPanel />
        </>
      );
    case 'costs':
      // Platform costs: sources, prices, by account, settings.
      return <CostsSection />;
    case 'kits':
      return <StarterKitsPanel />;
    case 'extensions':
      return <OwnerExtensions />;
    case 'guides':
      // Guides: the public installation guide and the owner's private guides.
      return <OwnerGuidesSection guide={guide} anchor={anchor} />;
    case 'legal':
      return <LegalDocumentsPanel />;
    case 'general':
      return <PlatformGeneralSettings />;
    case 'security':
      return (
        <>
          <PlatformSecuritySettings />
          <LoginProvidersPanel />
        </>
      );
    case 'email':
      return <PlatformEmailSettings />;
    case 'connections':
      return <PlatformConnectionsSettings />;
    case 'support':
      return (
        <>
          <SupportConsole ticket={ticket} />
          {owner ? <PlatformSupportSettings /> : null}
        </>
      );
    case 'errors':
      // Errors & health: the owner and support staff alike.
      return <ErrorsHub initial={error} />;
    case 'incidents':
      // Privacy A3: the security incident register.
      return <SecurityIncidentsPanel />;
  }
};

/** Emergency recovery requests, or a line saying there are none (the panel itself hides while empty). */
const EmergencySection = () => {
  const list = useEmergencyRequests();
  return (
    <>
      <EmergencyRequests />
      {list.data && !list.data.data.length ? (
        <EmptyState title={t('owner.emergency.none')} testId="owner-emergency-none" />
      ) : null}
    </>
  );
};

/** Accounts waiting to be deleted, or a line saying there are none (the panel itself hides while empty). */
const DeletionsSection = () => {
  const list = usePendingDeletions();
  return (
    <>
      <PendingDeletionsPanel />
      {list.data && !list.data.data.length ? (
        <EmptyState title={t('owner.deletions.none')} testId="owner-deletions-none" />
      ) : null}
    </>
  );
};

/** The accounts: the table with its filters, and the "new account" card beside it. */
const AccountsSection = () => {
  const narrow = useNarrow();
  const accounts = useQuery({
    queryKey: queryKeys.platformAccounts,
    queryFn: () => api().get<{ data: PlatformAccount[] }>('/platform/accounts'),
  });
  // Plans: each account's current subscription (none = unlimited / legacy).
  const subs = useSubscriptions();
  const subOf = (id: string) => subs.data?.data.find((s) => s.account_id === id);
  // Self sign-up (D32): filter by who opened the account, and by trial state.
  const [origin, setOrigin] = useState<OriginFilter>('all');
  const [trial, setTrial] = useState<TrialFilter>('all');
  const [now] = useState(() => Date.now());
  const all = accounts.data?.data ?? [];
  const rows = all.filter(
    (a) =>
      (origin === 'all' || (a.origin ?? 'owner') === origin) &&
      (trial === 'all' || trialStateOf(subOf(a.id), now) === trial),
  );

  return (
    <div className="flex items-start gap-5 max-xl:flex-col max-xl:items-stretch">
      <section className="flex min-w-0 flex-[1_1_600px] flex-col gap-2.5 max-md:flex-auto">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="flex-1 font-display text-base font-bold text-heading">{t('owner.accounts.title')}</h2>
          <Segmented<OriginFilter>
            label={t('owner.accounts.origin')}
            value={origin}
            onChange={setOrigin}
            testId="owner-accounts-origin"
            options={ORIGIN_FILTERS.map((v) => ({
              value: v,
              label: t(`owner.accounts.origin.filter.${v}`),
              testId: `owner-accounts-origin-${v}`,
            }))}
          />
          <Segmented<TrialFilter>
            label={t('owner.accounts.trial')}
            value={trial}
            onChange={setTrial}
            testId="owner-accounts-trial"
            options={TRIAL_FILTERS.map((v) => ({
              value: v,
              label: t(`owner.accounts.trial.${v}`),
              testId: `owner-accounts-trial-${v}`,
            }))}
          />
        </div>
        {accounts.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
        {accounts.isError ? <Notice tone="error">{errorMessage(accounts.error)}</Notice> : null}
        {accounts.data && !all.length ? (
          <EmptyState icon={<Icon name="building" size={28} />} title={t('owner.accounts.empty')} />
        ) : accounts.data && !rows.length ? (
          <EmptyState title={t('owner.accounts.noneMatch')} testId="owner-accounts-none" />
        ) : null}
        {rows.length && narrow ? (
          <ul className="overflow-hidden rounded-[14px] border border-line">
            {rows.map((a) => (
              <AccountRow key={a.id} account={a} sub={subOf(a.id)} narrow />
            ))}
          </ul>
        ) : rows.length ? (
          <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH}>{t('owner.accounts.name')}</th>
                  <th className={TH}>{t('owner.accounts.origin')}</th>
                  <th className={TH}>{t('myWork.col.status')}</th>
                  <th className={TH}>{t('owner.accounts.members')}</th>
                  <th className={TH}>{t('owner.accounts.pending')}</th>
                  <th className={TH}>{t('plans.column')}</th>
                  <th className={TH} />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <AccountRow key={a.id} account={a} sub={subOf(a.id)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <CreateAccount />
    </div>
  );
};

const ORIGIN_FILTERS = ['all', 'signup', 'owner', 'setup'] as const;
type OriginFilter = (typeof ORIGIN_FILTERS)[number];
const TRIAL_FILTERS = ['all', 'trial', 'ended'] as const;
type TrialFilter = (typeof TRIAL_FILTERS)[number];

/** On a trial now; or a trial that ended without an upgrade (the plan is no longer simply active). */
export const trialStateOf = (sub: Subscription | undefined, now: number): TrialFilter | null => {
  if (!sub?.trial_ends_at) return null;
  if (sub.effective_status === 'trial') return 'trial';
  return Date.parse(sub.trial_ends_at) <= now && sub.effective_status !== 'active' ? 'ended' : null;
};

/** Who opened the account (the "source" column): self sign-up, the platform owner, the first-run setup. */
const OriginBadge = ({ origin = 'owner' }: { origin?: AccountOrigin }) => (
  <span data-testid="owner-account-origin" data-origin={origin}>
    <Badge tone={origin === 'signup' ? 'info' : 'neutral'}>{t(`owner.accounts.origin.${origin}`)}</Badge>
  </span>
);

/** The slug suggested from a name (the shared rule: accents folded, lowercase, dashes; 63 = the slug's maximum). */
const slugify = (name: string) => slugFromName(name, 63);

const CreateAccount = () => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [email, setEmail] = useState('');
  const [templateSet, setTemplateSet] = useState<TemplateSet>('empty');

  const create = useMutation({
    mutationFn: () =>
      api().post<{ account: PlatformAccount; invitation: Invitation; emailed: boolean }>('/platform/accounts', {
        name,
        slug,
        first_admin_email: email,
        template_set: templateSet,
      }),
    onSuccess: async () => {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.platformAccounts });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Card className="flex min-w-0 flex-[0_1_360px] flex-col gap-3 max-md:flex-auto">
      <h2 className="font-display text-base font-bold text-heading">{t('owner.accounts.new')}</h2>
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Field label={t('owner.accounts.name')}>
          <Input
            required
            value={name}
            placeholder={t('owner.accounts.name.placeholder')}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label={t('owner.accounts.slug')} hint={t('owner.accounts.slug.hint')}>
          <Input
            required
            dir="ltr"
            className="text-end font-mono"
            placeholder="amana"
            pattern="[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Field>
        <Field label={t('owner.accounts.firstAdmin')}>
          <Input
            type="email"
            dir="ltr"
            required
            className="text-end"
            placeholder="admin@company.co.il"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-fg-2">{t('owner.accounts.templateSet')}</span>
          <KitPicker value={templateSet} onChange={setTemplateSet} />
        </div>
        <Button type="submit" variant="accent" size="lg" className="w-full" busy={create.isPending}>
          {t('owner.accounts.create')}
        </Button>
      </form>
      {create.isError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
      {create.data ? (
        <Notice tone={create.data.emailed ? 'success' : 'error'}>
          {t(create.data.emailed ? 'owner.accounts.created' : 'owner.accounts.createdNoEmail', {
            email: create.data.invitation.email,
          })}
        </Notice>
      ) : null}
      {/* fix8: the first admin's link, to send another way when email does not arrive. */}
      {create.data?.invitation.url ? (
        <CopyLinkField url={create.data.invitation.url} testId="owner-created-link" />
      ) : null}
    </Card>
  );
};

const AccountRow = ({
  account,
  sub,
  narrow,
}: {
  account: PlatformAccount;
  sub: Subscription | undefined;
  narrow?: boolean;
}) => {
  const [planOpen, setPlanOpen] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.platformAccounts });
  const suspend = useMutation({
    mutationFn: (reason: string) => api().post(`/platform/accounts/${account.id}/suspend`, { reason }),
    onSuccess: refresh,
  });
  const restore = useMutation({
    mutationFn: () => api().post(`/platform/accounts/${account.id}/restore`),
    onSuccess: refresh,
  });
  const [link, setLink] = useState<LinkShown | null>(null);
  // the account's invitations — invite anyone (the first admin or any role), send again, copy, cancel.
  const [invitationsOpen, setInvitationsOpen] = useState(false);
  // The emergency path: no grant → the account's admins are told, the link opens after the wait.
  const emergency = useMutation({
    mutationFn: (input: { email: string; reason: string }) =>
      api().post<{ available_at: string }>(`/platform/accounts/${account.id}/emergency-recovery`, input),
    onSuccess: async (res) => {
      showToast({ message: t('support.emergency.requestedToast', { date: formatDateTime(res.available_at) }) });
      await queryClient.invalidateQueries({ queryKey: emergencyKey });
    },
  });
  const askEmergency = async (email: string) => {
    const ok = await confirmDialog({
      title: t('support.emergency.askTitle'),
      message: t('support.emergency.askBody', { email }),
      confirmLabel: t('support.emergency.askConfirm'),
    });
    if (!ok) return;
    const reason = await promptDialog({
      title: t('support.emergency.askTitle'),
      label: t('support.reason'),
      confirmLabel: t('support.emergency.askConfirm'),
    });
    if (reason) emergency.mutate({ email, reason });
  };
  // fix8: a one-time sign-in / new-password link for anyone in this account (audited there) — only with an active
  // edit grant of the account; without one, the emergency path is offered.
  const recovery = useMutation({
    mutationFn: (email: string) =>
      api().post<RecoveryLink>(`/platform/accounts/${account.id}/recovery-link`, { email }),
    onSuccess: (res, email) =>
      setLink({
        title: t('adminUsers.recovery.title'),
        subtitle: email,
        url: res.url,
        note: t('adminUsers.recovery.note'),
        testId: 'owner-recovery-link',
      }),
    onError: (err, email) => {
      if (err instanceof ApiError && err.body.message === 'support_grant_required') {
        recovery.reset();
        void askEmergency(email);
      }
    },
  });
  // "Enter support" (only while a grant is active): the account switcher list is refetched so the route finds it.
  const navigate = useNavigate();
  const enterSupport = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.myAccounts });
    await navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
  };
  const error = suspend.error ?? restore.error ?? recovery.error ?? emergency.error;
  const total = account.members.admin + account.members.member + account.members.viewer + account.members.guest;

  const badge = account.deletion_due_at ? (
    <Badge tone="danger">{t('owner.deletions.badge')}</Badge>
  ) : (
    <Badge tone={account.status === 'active' ? 'ok' : 'danger'}>{t(`status.${account.status}`)}</Badge>
  );
  const support = account.support;
  const [now] = useState(() => Date.now());
  const actions = (
    <span className="flex items-center justify-end gap-2">
      {support ? (
        <Button
          variant="accent"
          size="sm"
          data-testid="owner-enter-support"
          title={formatDateTime(support.expires_at)}
          onClick={() => void enterSupport()}
        >
          <Icon name="lock" size={14} />
          {t('support.owner.enter')}
          <span className="font-normal opacity-80">
            · {t(`support.mode.${support.mode}`)} · {timeLeft(Date.parse(support.expires_at) - now)}
          </span>
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" data-testid="owner-account-plan" onClick={() => setPlanOpen(true)}>
        {t('plans.column')}
      </Button>
      {planOpen ? <AccountPlanDialog account={account} onClose={() => setPlanOpen(false)} /> : null}
      <Button variant="ghost" size="sm" data-testid="owner-invitations" onClick={() => setInvitationsOpen(true)}>
        {t('invites.owner.button')}
        {account.pending_invitations ? (
          <span className="font-normal tabular-nums opacity-80">· {account.pending_invitations}</span>
        ) : null}
      </Button>
      {invitationsOpen ? (
        <AccountInvitationsDialog account={account} onClose={() => setInvitationsOpen(false)} />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        busy={recovery.isPending}
        data-testid="owner-recovery"
        onClick={() => {
          void promptDialog({
            title: t('owner.recovery.title'),
            label: t('owner.recovery.prompt'),
            type: 'email',
            confirmLabel: t('owner.recovery.create'),
          }).then((email) => email && recovery.mutate(email.trim().toLowerCase()));
        }}
      >
        {t('owner.recovery.button')}
      </Button>
      {link ? (
        <Dialog open onClose={() => setLink(null)} title={link.title} subtitle={link.subtitle}>
          <div className="space-y-3 whitespace-normal" data-testid={link.testId}>
            <CopyLinkField url={link.url} testId={`${link.testId}-field`} />
            <p className="text-xs text-muted">{link.note}</p>
          </div>
        </Dialog>
      ) : null}
      {account.status === 'active' ? (
        <Button
          variant="danger-outline"
          size="sm"
          busy={suspend.isPending}
          onClick={() => {
            void promptDialog({
              title: t('owner.accounts.suspend'),
              label: t('owner.accounts.suspend.reason'),
              confirmLabel: t('owner.accounts.suspend'),
            }).then((reason) => reason && suspend.mutate(reason));
          }}
        >
          {t('owner.accounts.suspend')}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" busy={restore.isPending} onClick={() => restore.mutate()}>
          {t('owner.accounts.restore')}
        </Button>
      )}
    </span>
  );
  const nameCell = (
    <span className="flex min-w-0 flex-col items-start">
      <span className="max-w-full truncate font-semibold text-fg">{account.name}</span>
      <span
        className="max-w-full truncate text-start font-mono text-[0.6875rem] text-muted [unicode-bidi:isolate]"
        dir="ltr"
      >
        /a/{account.slug}
      </span>
    </span>
  );

  if (narrow)
    return (
      <li className="flex flex-col gap-2 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0">
        <div className="flex items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-semibold text-fg">{account.name}</span>
            <span className="text-[0.6875rem] text-muted">
              {t('owner.accounts.members')}: {total} · {t('owner.accounts.pending')}: {account.pending_invitations}
            </span>
            <AccountPlanBadge sub={sub} />
          </span>
          <OriginBadge origin={account.origin} />
          {badge}
        </div>
        <div className="flex justify-start">{actions}</div>
        {error ? <Notice tone="error">{reasonMessage(error)}</Notice> : null}
      </li>
    );

  return (
    <tr className={TR}>
      <td className={cn(TD, 'h-[3.25rem] py-1.5')}>
        {nameCell}
        {error ? (
          <div className="mt-1 whitespace-normal">
            <Notice tone="error">{reasonMessage(error)}</Notice>
          </div>
        ) : null}
      </td>
      <td className={TD}>
        <OriginBadge origin={account.origin} />
      </td>
      <td className={TD}>{badge}</td>
      <td className={cn(TD, 'tabular-nums')}>{total}</td>
      <td className={cn(TD, 'tabular-nums')}>{account.pending_invitations}</td>
      <td className={TD}>
        <AccountPlanBadge sub={sub} />
      </td>
      <td className={TD}>{actions}</td>
    </tr>
  );
};
