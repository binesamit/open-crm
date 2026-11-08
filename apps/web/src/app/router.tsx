// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import {
  EXTENSION_DOC_PAGES,
  type ExtensionDocPageKey,
  isUpdateLinkId,
  t,
  UPDATE_LINK_PARAM,
  type AccountDetail,
} from '@bines/shared';
import { Button, Notice, SkeletonRows } from '@bines/ui';
import { lazy, Suspense, type ComponentType } from 'react';
import { api, fetchMe, type Me, type MyAccount, queryKeys } from '../lib/api';
import { LoginPage, safeRedirect } from '../features/auth/LoginPage';
import { InvitePage } from '../features/auth/InvitePage';
import { fetchSetupStatus, SetupPage, setupStatusKey } from '../features/auth/SetupPage';
import { ConnectError, ConnectPage } from '../features/auth/ConnectPage';
import { AccountPicker } from '../features/home/AccountPicker';
import { AccountHome } from '../features/account/AccountHome';
import { TopBar } from '../features/shell/TopBar';
import { AppShell } from '../features/shell/AppShell';
import { BoardPage } from '../features/board/BoardPage';
import { ItemCard } from '../features/item/ItemCard';
import { PanelPage, PanelSignIn } from '../features/extensions/PanelPage';
import { isProfileTab, ProfilePage, type ProfileTab } from '../features/account/ProfilePage';
import { MyWorkPage } from '../features/mywork/MyWorkPage';
import { AppPageView } from '../features/extensions/AppPage';
import { appPageCardRoutes } from '../features/extensions/app-pages';
import { useBoardLive } from '../features/board/use-board-live';
import { InboxPage } from '../features/search/InboxPage';
import { BoardsPage } from '../features/shell/BoardsPage';
import { MePage } from '../features/shell/MePage';
import { AdminHub, isAdminSection } from '../features/admin/AdminHub';
import { AnnouncementBanner } from '../features/admin/AnnouncementBanner';
import { PwaAccountHost } from '../pwa/PwaHosts';
import { SupportBanner } from '../features/admin/SupportBanner';
import { AccountClosedGate, PlanGate, PlanReadOnlyBanner } from '../features/shell/PlanStatus';
import { TwoFactorBanner, TwoFactorGate } from '../features/account/TwoFactorGate';
import { LegalConsentGate } from '../features/legal/LegalConsentGate';
import { accountDetailKey, useAccountRegionSync } from '../features/admin/account-settings';
import { applyAccountRegion } from '../lib/region';
import { WorkspacePage } from '../features/workspace/WorkspacePage';
import { FirstStepsPanel } from '../features/checklist/FirstStepsPanel';
import { TourHost } from '../features/tours/TourHost';
import { AreaBoundary, ErrorScreen, RouteErrorScreen } from '../lib/error-screen';
import { isChunkLoadError, reloadForNewVersion, retryTransient } from '../lib/errors';
import { helpHiddenFor, parseKbSearch } from '../features/support/kb-page';
import { type OwnerSection, sectionFromSearch } from '../features/owner/console-sections';

/**
 * Pages most people open rarely load on first visit (perf review: one 1.9 MB bundle before) — the owner console,
 * administration sections, automations, trash and archive. The board, item card, My Work and inbox stay in the
 * main bundle (the update composer with TipTap is split off in ItemCard).
 */
const lazyPage = <P extends object>(load: () => Promise<ComponentType<P>>) => {
  // Round 12: after a deploy the old version's chunk is gone — reload once to the new version (`lib/errors.ts`)
  // instead of crashing into an empty page; a second failure goes on to the error screen.
  const Page = lazy(async () => {
    try {
      return { default: await load() };
    } catch (err) {
      if (isChunkLoadError(err) && reloadForNewVersion()) return new Promise<never>(() => undefined);
      throw err;
    }
  }) as unknown as ComponentType<Record<string, unknown>>;
  return (props: P) => (
    <Suspense fallback={<SkeletonRows rows={6} label={t('app.loading')} />}>
      <Page {...(props as unknown as Record<string, unknown>)} />
    </Suspense>
  );
};
const OwnerConsole = lazyPage(() => import('../features/owner/OwnerConsole').then((m) => m.OwnerConsole));
// Support tickets: "My tickets" and one ticket.
const MyTicketsPage = lazyPage(() => import('../features/support/MyTicketsPage').then((m) => m.MyTicketsPage));
const TicketPage = lazyPage(() => import('../features/support/TicketPage').then((m) => m.TicketPage));
const KnowledgeCenterPage = lazyPage(() =>
  import('../features/support/KnowledgeCenterPage').then((m) => m.KnowledgeCenterPage),
);
const ToursPage = lazyPage(() => import('../features/tours/ToursPage').then((m) => m.ToursPage));
const StartPage = lazyPage(() => import('../features/onboarding/StartPage').then((m) => m.StartPage));
const TrashPage = lazyPage(() => import('../features/trash/TrashPage').then((m) => m.TrashPage));
const ArchivePage = lazyPage(() => import('../features/trash/ArchivePage').then((m) => m.ArchivePage));
const AccountAutomationsPage = lazyPage(() =>
  import('../features/automations/AccountAutomationsPage').then((m) => m.AccountAutomationsPage),
);
const AgentsPage = lazyPage(() => import('../features/agents/AgentsPage').then((m) => m.AgentsPage));
const AgentEditorPage = lazyPage(() => import('../features/agents/AgentEditor').then((m) => m.AgentEditorPage));
const FlowsPage = lazyPage(() => import('../features/flows/FlowsPage').then((m) => m.FlowsPage));
const AdminSectionPage = lazyPage(() => import('../features/admin/AdminSections').then((m) => m.AdminSectionPage));
// s37market: the extension developer guide inside the app (Administration → Extensions → For developers).
const DevDocsPage = lazyPage(() => import('../features/extensions/DevDocsPage').then((m) => m.DevDocsPage));
// Docs (M8): Yjs, Hocuspocus and the collaboration extensions load with the doc page only.
const DocPage = lazyPage(() => import('../features/docs/DocPage').then((m) => m.DocPage));
// Dashboards (M8 ד4): Recharts and dnd-kit's grid load with the dashboard page only.
const DashboardPage = lazyPage(() => import('../features/dashboards/DashboardPage').then((m) => m.DashboardPage));
// Public forms (M11): the page anyone with the link opens — outside the app shell, loaded on its own.
const PublicFormPage = lazyPage(() => import('../features/forms/PublicFormPage').then((m) => m.PublicFormPage));
const PublicDocPage = lazyPage(() => import('../features/idocs/PublicDocPage').then((m) => m.PublicDocPage));
// An interactive document: no sign-in, no shell — the token names the document.
const publicDocRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$token',
  component: function PublicDoc() {
    const { token } = publicDocRoute.useParams();
    return <PublicDocPage token={token} />;
  },
});

// The public help center: outside the shell, no sign-in.
const HelpCenterPage = lazyPage(() => import('../features/support/HelpCenterPage').then((m) => m.HelpCenterPage));
// Legal documents: outside the shell, no sign-in.
const GuidePage = lazyPage(() => import('../features/guides/GuidePage').then((m) => m.GuidePage));
const LegalPage = lazyPage(() => import('../features/legal/LegalPage').then((m) => m.LegalPage));
// Licensing: the license server's public registration pages (outside the shell, no sign-in).
const PublicRegisterPage = lazyPage(() =>
  import('../features/licensing/PublicRegisterPage').then((m) => m.PublicRegisterPage),
);
const PublicVerifyPage = lazyPage(() =>
  import('../features/licensing/PublicRegisterPage').then((m) => m.PublicVerifyPage),
);
// Self sign-up (D32): the public form, the email link and the return from Google / Microsoft.
const SignupPage = lazyPage(() => import('../features/signup/SignupPage').then((m) => m.SignupPage));
const SignupVerifyPage = lazyPage(() => import('../features/signup/SignupVerifyPage').then((m) => m.SignupVerifyPage));
const SignupCompletePage = lazyPage(() =>
  import('../features/signup/SignupCompletePage').then((m) => m.SignupCompletePage),
);
// Licensing: the license server's optional online purchase.
const BuyPage = lazyPage(() => import('../features/licensing/BuyPage').then((m) => m.BuyPage));
const BuySuccessPage = lazyPage(() => import('../features/licensing/BuyPage').then((m) => m.BuySuccessPage));
const PricingPage = lazyPage(() => import('../features/pricing/PricingPage').then((m) => m.PricingPage));

/*
 * Route map (11-UI-DESIGN §1, D12):
 *   /login, /invite/:token        public
 *   /setup                        first run only (no user yet): create the owner account
 *   /f/:token                     a public form (M11), outside the shell
 *   /                             last used account or account picker
 *   /a/:accountSlug               everything inside an account (/trash = trash, 07 §5.2;
 *                                 /boards and /me = the phone's "לוחות" and "אני" tabs, N1;
 *                                 /admin/:section = Administration, account admins only, 08 §13 —
 *                                 /profile?tab= = "הפרופיל שלי" (fix5): profile, notifications, tokens, appearance;
 *                                 /settings/notifications and /settings/tokens redirect into its tabs;
 *                                 the account notification defaults = /admin/notifications, everyone's
 *                                 tokens = /admin/connections;
 *                                 /w/:workspaceId = a workspace's page)
 *   /owner                        platform owner console
 */
type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  // Round 12: our error screen instead of the router's "Something went wrong!" (every route, `defaultErrorComponent`).
  errorComponent: RouteErrorScreen,
  notFoundComponent: () => (
    <main className="mx-auto max-w-md px-4 py-16">
      <Notice>{t('error.not_found')}</Notice>
    </main>
  ),
});

/** Resolves the session or sends the visitor to /login?redirect=<where they were going>. */
const requireMe = async (queryClient: QueryClient, href: string): Promise<Me> => {
  const me = await queryClient.ensureQueryData({ queryKey: queryKeys.me, queryFn: fetchMe, retry: retryTransient });
  if (!me) throw redirect({ to: '/login', search: { redirect: href } });
  return me;
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  // `two_factor=1`: a magic link / Google sign-in that still needs the second factor (M8 ד12).
  validateSearch: (search: Record<string, unknown>): { redirect?: string; two_factor?: 1 } => ({
    ...(typeof search.redirect === 'string' ? { redirect: safeRedirect(search.redirect) } : {}),
    ...(search.two_factor === 1 || search.two_factor === '1' ? { two_factor: 1 as const } : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.me,
      queryFn: fetchMe,
      retry: retryTransient,
    });
    if (me) throw redirect({ to: search.redirect ?? '/' });
    // A brand-new installation (no user yet): "Create the owner account" instead of a sign-in nobody can pass.
    const setup = await context.queryClient
      .fetchQuery({ queryKey: setupStatusKey, queryFn: fetchSetupStatus, staleTime: 0 })
      .catch(() => null);
    if (setup?.required) throw redirect({ to: '/setup' });
  },
  component: function Login() {
    const { redirect: target, two_factor } = loginRoute.useSearch();
    return <LoginPage redirect={target} twoFactor={two_factor === 1} />;
  },
});

// First run (no user yet): the owner account. Closed for good once anyone exists — then it is the sign-in page.
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery({
      queryKey: setupStatusKey,
      queryFn: fetchSetupStatus,
      staleTime: 0,
    });
    if (!status.required) throw redirect({ to: '/login' });
    return { status };
  },
  component: function Setup() {
    const { status } = setupRoute.useRouteContext();
    return <SetupPage status={status} />;
  },
});

// Self sign-up (D32): `/signup` (closed = "sign-up is closed"; `?error=provider` = Google / Microsoft failed),
// `/signup/verify#token=` (the email link) and `/signup/complete?via=` (back from the provider, signed in).
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  // `?plan=`: the plan chosen on the pricing page, picked in the form when it is offered.
  validateSearch: (s: Record<string, unknown>): { error?: 'provider'; plan?: string } => ({
    ...(s.error === 'provider' || (typeof s.error === 'string' && s.error) ? { error: 'provider' as const } : {}),
    ...(typeof s.plan === 'string' && /^[A-Za-z0-9]{1,26}$/.test(s.plan) ? { plan: s.plan } : {}),
  }),
  component: function Signup() {
    const { error, plan } = signupRoute.useSearch();
    return <SignupPage providerFailed={!!error} plan={plan} />;
  },
});

// The pricing page: public; `?embed=1` without the top bar, `?tab=self` the self-hosted editions.
const pricingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pricing',
  validateSearch: (s: Record<string, unknown>): { embed?: boolean; tab?: 'cloud' | 'self' } => ({
    ...(s.embed === 1 || s.embed === '1' || s.embed === true ? { embed: true } : {}),
    ...(s.tab === 'self' || s.tab === 'cloud' ? { tab: s.tab } : {}),
  }),
  component: function Pricing() {
    const { embed, tab } = pricingRoute.useSearch();
    return <PricingPage embed={embed} tab={tab} />;
  },
});
const signupVerifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup/verify',
  component: function SignupVerify() {
    return <SignupVerifyPage />;
  },
});
const signupCompleteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup/complete',
  validateSearch: (s: Record<string, unknown>): { via?: 'google' | 'microsoft' } =>
    s.via === 'google' || s.via === 'microsoft' ? { via: s.via } : {},
  // Not signed in = the provider did not sign anyone in: back to the form, which says so.
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData({ queryKey: queryKeys.me, queryFn: fetchMe });
    if (!me) throw redirect({ to: '/signup', search: { error: 'provider' } });
  },
  component: function SignupComplete() {
    const { via } = signupCompleteRoute.useSearch();
    return <SignupCompletePage via={via} />;
  },
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: function Invite() {
    const { token } = inviteRoute.useParams();
    return <InvitePage token={token} />;
  },
});

// The OAuth consent screen (מ5): an AI app asks to connect (`?request=`), or its request was invalid (`?error=`).
const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connect',
  validateSearch: (s: Record<string, unknown>): { request?: string; error?: string } => ({
    ...(typeof s.request === 'string' && /^[0-9A-Z]{26}$/.test(s.request) ? { request: s.request } : {}),
    ...(typeof s.error === 'string' && /^[a-z_]{1,40}$/.test(s.error) ? { error: s.error } : {}),
  }),
  beforeLoad: async ({ context, location, search }) =>
    search.request ? { me: await requireMe(context.queryClient, location.href) } : { me: null },
  component: function Connect() {
    const { me } = connectRoute.useRouteContext();
    const { request, error } = connectRoute.useSearch();
    return request && me ? <ConnectPage requestId={request} me={me} /> : <ConnectError code={error ?? ''} />;
  },
});

// A public form (M11): no sign-in (a members-only form asks for it itself), no shell, no account in the URL.
const publicFormRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/f/$token',
  component: function PublicForm() {
    const { token } = publicFormRoute.useParams();
    return <PublicFormPage token={token} />;
  },
});

// The public help center: `?article=<slug>` opens one article, `?locale=en` the English ones.
const helpCenterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/help',
  validateSearch: (s: Record<string, unknown>): { article?: string; locale?: 'he' | 'en' } => ({
    ...(typeof s.article === 'string' && s.article ? { article: s.article.slice(0, 120) } : {}),
    ...(s.locale === 'en' || s.locale === 'he' ? { locale: s.locale } : {}),
  }),
  component: function HelpCenter() {
    const search = helpCenterRoute.useSearch();
    const navigate = helpCenterRoute.useNavigate();
    return (
      <HelpCenterPage
        article={search.article}
        locale={search.locale}
        onArticle={(slug) => void navigate({ search: { ...search, article: slug ?? undefined } })}
      />
    );
  },
});

// Licensing (docs/LICENSING.md): the license server's public registration pages — for installations without internet
// access (`/register?instance=<id>`), and the emailed verification link that shows the key (`/register/verify`).
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  validateSearch: (s: Record<string, unknown>): { instance?: string } =>
    typeof s.instance === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s.instance) ? { instance: s.instance } : {},
  component: function Register() {
    const { instance } = registerRoute.useSearch();
    return <PublicRegisterPage instance={instance} />;
  },
});
const registerVerifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register/verify',
  validateSearch: (s: Record<string, unknown>): { token?: string } =>
    typeof s.token === 'string' && s.token.length <= 200 ? { token: s.token } : {},
  component: function RegisterVerify() {
    const { token } = registerVerifyRoute.useSearch();
    // The emailed link carries the token in the fragment (`#token=`), which never reaches a server; `?token=`
    // stays for links sent before.
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? undefined;
    return <PublicVerifyPage token={token ?? (fromHash && fromHash.length <= 200 ? fromHash : undefined)} />;
  },
});

// Licensing: buying a license online — `/buy?plan=&instance=`, and where the provider returns.
const buyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/buy',
  validateSearch: (
    s: Record<string, unknown>,
  ): { plan?: string; instance?: string; canceled?: boolean; tier?: number } => ({
    ...(s.plan === 'business' || s.plan === 'enterprise' ? { plan: s.plan } : {}),
    ...(typeof s.tier === 'number' || (typeof s.tier === 'string' && /^\d$/.test(s.tier))
      ? { tier: Math.min(9, Math.max(0, Math.floor(Number(s.tier)))) }
      : {}),
    ...(typeof s.instance === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s.instance) ? { instance: s.instance } : {}),
    ...(s.canceled === 1 || s.canceled === '1' || s.canceled === true ? { canceled: true } : {}),
  }),
  component: function Buy() {
    const search = buyRoute.useSearch();
    return <BuyPage plan={search.plan} tier={search.tier} instance={search.instance} canceled={search.canceled} />;
  },
});
const buySuccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/buy/success',
  component: function BuySuccess() {
    return <BuySuccessPage />;
  },
});

// The legal documents: `/legal` lists them, `/legal/<slug>` shows one; `?locale=en` the English text.
const legalLocaleSearch = (s: Record<string, unknown>): { locale?: 'he' | 'en' } =>
  s.locale === 'en' || s.locale === 'he' ? { locale: s.locale } : {};
const legalIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal',
  validateSearch: legalLocaleSearch,
  component: function LegalIndex() {
    const search = legalIndexRoute.useSearch();
    const navigate = legalIndexRoute.useNavigate();
    return <LegalPage locale={search.locale} onLocale={(locale) => void navigate({ search: { locale } })} />;
  },
});
const legalDocRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal/$slug',
  validateSearch: legalLocaleSearch,
  component: function LegalDoc() {
    const { slug } = legalDocRoute.useParams();
    const search = legalDocRoute.useSearch();
    const navigate = legalDocRoute.useNavigate();
    return (
      <LegalPage slug={slug} locale={search.locale} onLocale={(locale) => void navigate({ search: { locale } })} />
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context, location }) => ({ me: await requireMe(context.queryClient, location.href) }),
  component: function Index() {
    const { me } = indexRoute.useRouteContext();
    return <AccountPicker me={me} />;
  },
});

const ownerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/owner',
  // `section=support` opens the Support section (`ticket=` one ticket) — support staff see it and Errors & health
  // (`section=errors`, `error=` one error).
  // Guides: `section=guides`, `guide=install` or an owner guide's id, `anchor=` a section of it.
  // every section of the console's side nav is a `section=` value (`platform`, the old page = overview).
  validateSearch: (
    s: Record<string, unknown>,
  ): {
    section?: OwnerSection;
    ticket?: string;
    error?: string;
    guide?: string;
    anchor?: string;
  } => ({
    ...(sectionFromSearch(s.section) ? { section: sectionFromSearch(s.section) } : {}),
    ...(typeof s.ticket === 'string' && /^[0-9A-Z]{26}$/.test(s.ticket) ? { ticket: s.ticket } : {}),
    ...(typeof s.error === 'string' && /^[0-9A-Z]{26}$/.test(s.error) ? { error: s.error } : {}),
    ...(typeof s.guide === 'string' && /^(install|[0-9A-Z]{26})$/.test(s.guide) ? { guide: s.guide } : {}),
    ...(typeof s.anchor === 'string' && s.anchor && s.anchor.length <= 200 ? { anchor: s.anchor } : {}),
  }),
  beforeLoad: async ({ context, location }) => {
    const me = await requireMe(context.queryClient, location.href);
    if (!me.user.is_platform_owner && !me.user.support_role) throw notFound();
    return { me };
  },
  component: function Owner() {
    const { me } = ownerRoute.useRouteContext();
    const { section, ticket, error, guide, anchor } = ownerRoute.useSearch();
    return (
      <OwnerConsole
        // Not keyed by the section: moving between sections keeps the nav (and its search) in place.
        key={`${ticket}${error}${guide}${anchor}`}
        me={me}
        section={section}
        ticket={ticket}
        error={error}
        guide={guide}
        anchor={anchor}
      />
    );
  },
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/a/$accountSlug',
  beforeLoad: async ({ context, location, params }) => {
    const me = await requireMe(context.queryClient, location.href);
    const { data } = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.myAccounts,
      queryFn: () => api().get<{ data: MyAccount[] }>('/me/accounts'),
      // A blip while the server restarts (a deploy) is retried before the page gives up (round 12).
      retry: retryTransient,
    });
    const account = data.find((a) => a.slug === params.accountSlug);
    if (!account) throw notFound();
    // The account's region settings (A3) apply before its pages render, so no date shows in another format first.
    try {
      const detail = await context.queryClient.ensureQueryData({
        queryKey: accountDetailKey(account.id),
        queryFn: () => api(account.id).get<AccountDetail>('/accounts/me'),
      });
      applyAccountRegion(detail.settings.locale, detail.calendar);
    } catch {
      // A suspended account (or a blip): the defaults stay until the detail loads.
    }
    if (me.last_account_id !== account.id) {
      void api()
        .put('/me/last-account', { account_id: account.id })
        .then(() => context.queryClient.invalidateQueries({ queryKey: queryKeys.me }));
    }
    return { me, account };
  },
  component: function AccountLayout() {
    const { me, account } = accountRoute.useRouteContext();
    useAccountRegionSync(account);
    if (account.status === 'suspended')
      return (
        <div className="flex h-dvh flex-col bg-shell">
          <TopBar me={me} current={account} />
          <main className="flex-1 p-3 pt-0">
            <div className="app-panel mx-auto max-w-md p-6">
              <Notice tone="error">{t('account.suspended')}</Notice>
            </div>
          </main>
        </div>
      );
    return (
      // Gate order: closed account (plan-lock) → 2FA / SSO → legal consent → plan (suspended).
      <AccountClosedGate me={me} account={account}>
        <TwoFactorGate account={account}>
          {/*: a new version of the terms / privacy is accepted before going on. */}
          <LegalConsentGate>
            {/* Plans: a suspended plan shows one notice instead of the shell (admins keep "My plan"). */}
            <PlanGate me={me} account={account}>
              <AppShell me={me} account={account}>
                {/* The system announcement (A3): above every page of the account until closed or expired. */}
                <SupportBanner account={account} />
                <PlanReadOnlyBanner account={account} />
                <AnnouncementBanner account={account} userId={me.user.id} />
                <TwoFactorBanner account={account} />
                {/* The phone app (PWA): the account's manifest / icon, the install bar, the push question. */}
                <PwaAccountHost account={account} />
                {/* "First steps": the self-ticking checklist with "show me" tours. */}
                <FirstStepsPanel me={me} account={account} />
                {/* Guided tours: the offer on a first visit, the running tour, the console's picker. */}
                <TourHost me={me} account={account} />
                <Outlet />
              </AppShell>
            </PlanGate>
          </LegalConsentGate>
        </TwoFactorGate>
      </AccountClosedGate>
    );
  },
});

/**
 * An extension's panel: its own page without the app's chrome — framed by a site the owner allowed
 * (a browser side panel). Signed out it asks to sign in in a tab (sign-in pages are never framed); the account's
 * gates (2FA, legal consent, plan) are passed in the full app first.
 */
const panelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/a/$accountSlug/x/$installationId/panel',
  beforeLoad: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.me,
      queryFn: fetchMe,
      retry: retryTransient,
    });
    if (!me) return { me: null, account: null };
    const { data } = await context.queryClient.ensureQueryData({
      queryKey: queryKeys.myAccounts,
      queryFn: () => api().get<{ data: MyAccount[] }>('/me/accounts'),
      retry: retryTransient,
    });
    const account = data.find((a) => a.slug === params.accountSlug);
    if (!account) throw notFound();
    return { me, account };
  },
  component: function Panel() {
    const { me, account } = panelRoute.useRouteContext();
    const { installationId } = panelRoute.useParams();
    if (!me || !account) return <PanelSignIn />;
    if (account.status === 'suspended')
      return (
        <main className="p-4">
          <Notice tone="error">{t('account.suspended')}</Notice>
        </main>
      );
    return <PanelPage account={account} me={me} installationId={installationId} />;
  },
});

const accountHomeRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/',
  component: function Home() {
    const { account } = accountHomeRoute.useRouteContext();
    return <AccountHome account={account} />;
  },
});

const trashRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/trash',
  // Guests have no trash (the server refuses it, fix5): they go home.
  beforeLoad: ({ context, params }) => {
    if (context.account.role === 'guest') {
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug }, replace: true });
    }
  },
  component: function Trash() {
    const { account } = trashRoute.useRouteContext();
    return <TrashPage account={account} />;
  },
});

const inboxRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/inbox',
  component: function InboxRoute() {
    const { account } = inboxRoute.useRouteContext();
    return <InboxPage account={account} />;
  },
});

const myWorkRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/my-work',
  component: function MyWork() {
    const { account, me } = myWorkRoute.useRouteContext();
    return <MyWorkPage account={account} me={me} />;
  },
});

// an extension's page in the sidebar (`app_page`) — for every member the installation reaches (the
// page and the server check that; a page that is not there shows a notice).
const appPageRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/apps/$extensionKey/$featureKey',
  component: function AppPageRoute() {
    const { account } = appPageRoute.useRouteContext();
    const { extensionKey, featureKey } = appPageRoute.useParams();
    const cardOpen = useRouterState({ select: (s) => s.matches.some((m) => m.routeId === appPageItemRoute.id) });
    return (
      <>
        <AppPageView account={account} extensionKey={extensionKey} featureKey={featureKey} cardOpen={cardOpen} />
        <Outlet />
      </>
    );
  },
});

/**
 * an item the page opens (`openItemCard`) — the app's own card over the page, as over a dashboard, so
 * the member stays on the page (its frame stays mounted); closing it goes back to the page. Full screen on phones.
 */
const appPageItemRoute = createRoute({
  getParentRoute: () => appPageRoute,
  path: '/i/$boardId/$itemId',
  validateSearch: (s: Record<string, unknown>): { tab?: string; update?: string } => ({
    ...(typeof s.tab === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(s.tab) ? { tab: s.tab } : {}),
    ...(isUpdateLinkId(s[UPDATE_LINK_PARAM]) ? { update: s[UPDATE_LINK_PARAM] } : {}),
  }),
  component: function AppPageItem() {
    const { account, me } = appPageItemRoute.useRouteContext();
    const { extensionKey, featureKey, boardId, itemId } = appPageItemRoute.useParams();
    const { tab, update } = appPageItemRoute.useSearch();
    // The board's live events keep the card current, as on the board page.
    useBoardLive(account.id, boardId);
    const routes = appPageCardRoutes({ accountSlug: account.slug, extensionKey, featureKey, boardId });
    return (
      <AreaBoundary
        area="item"
        resetKey={itemId}
        fallback={({ error, retry }) => (
          <ItemCardCrash error={error} retry={retry} account={account} boardId={boardId} back={routes.back} />
        )}
      >
        <ItemCard
          key={itemId}
          account={account}
          me={me}
          boardId={boardId}
          itemId={itemId}
          initialTab={tab}
          focusUpdate={update}
          routes={routes}
        />
      </AreaBoundary>
    );
  },
});

// "הפרופיל שלי" (fix5): my details, my notification settings, my API tokens and the appearance, as tabs.
const profileRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/profile',
  validateSearch: (s: Record<string, unknown>): { tab?: ProfileTab } => (isProfileTab(s.tab) ? { tab: s.tab } : {}),
  component: function Profile() {
    const { account, me } = profileRoute.useRouteContext();
    const { tab } = profileRoute.useSearch();
    return <ProfilePage me={me} account={account} tab={tab} />;
  },
});

// The old addresses (links, bookmarks, the bell's ⚙) land in the profile's tabs.
const notificationSettingsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/settings/notifications',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/a/$accountSlug/profile',
      params: { accountSlug: params.accountSlug },
      search: { tab: 'notifications' },
      replace: true,
    });
  },
});

const automationsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/automations',
  component: function Automations() {
    const { account } = automationsRoute.useRouteContext();
    return <AccountAutomationsPage account={account} />;
  },
});

// External flows: members see the connections an admin opened to them (admins also find the screen
// under Administration → זרימות). Guests and viewers go home.
const flowsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/flows',
  // a flow notification / `{flow.url}` opens one flow's runs (`?connection=&flow=&run=`).
  // The router parses `?run=104` as a number (n8n / Make ids are often digits): ids are taken as text either way.
  validateSearch: (s: Record<string, unknown>): { connection?: string; flow?: string; run?: string } => {
    const id = (v: unknown) => (typeof v === 'string' && v) || (typeof v === 'number' ? String(v) : undefined);
    const connection = id(s.connection);
    const flow = id(s.flow);
    const run = id(s.run);
    return { ...(connection ? { connection } : {}), ...(flow ? { flow } : {}), ...(run ? { run } : {}) };
  },
  beforeLoad: ({ context, params }) => {
    if (context.account.role === 'guest' || context.account.role === 'viewer')
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Flows() {
    const { account } = flowsRoute.useRouteContext();
    const link = flowsRoute.useSearch();
    return (
      <main className="w-full px-4 py-5 md:px-6">
        <FlowsPage
          key={`${link.connection ?? ''}:${link.flow ?? ''}:${link.run ?? ''}`}
          account={account}
          link={link}
        />
      </main>
    );
  },
});

// Agents (the planning notes "AGENTS-MCP" §6): the list, the approvals inbox and runs; `/agents/new` or an agent's
// editor (`?run=` opens a run — the bell's approval requests land here). Guests and viewers go home.
const agentsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/agents',
  beforeLoad: ({ context, params }) => {
    if (context.account.role === 'guest' || context.account.role === 'viewer')
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Agents() {
    const { account } = agentsRoute.useRouteContext();
    return <AgentsPage account={account} />;
  },
});

const agentRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/agents/$agentId',
  validateSearch: (s: Record<string, unknown>): { run?: string } =>
    typeof s.run === 'string' && s.run ? { run: s.run } : {},
  beforeLoad: ({ context, params }) => {
    if (context.account.role === 'guest' || context.account.role === 'viewer')
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Agent() {
    const { account } = agentRoute.useRouteContext();
    const { agentId } = agentRoute.useParams();
    const { run } = agentRoute.useSearch();
    return <AgentEditorPage key={agentId} account={account} agentId={agentId} runId={run} />;
  },
});

// My own API tokens are a profile tab (fix5); everyone's tokens stay in Administration → חיבורים.
const tokensRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/settings/tokens',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/a/$accountSlug/profile',
      params: { accountSlug: params.accountSlug },
      search: { tab: 'tokens' },
      replace: true,
    });
  },
});

const archiveRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/archive',
  component: function Archive() {
    const { account } = archiveRoute.useRouteContext();
    return <ArchivePage account={account} />;
  },
});

const boardsRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/boards',
  component: function Boards() {
    const { account } = boardsRoute.useRouteContext();
    return <BoardsPage account={account} />;
  },
});

const meRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/me',
  component: function MeRoute() {
    const { account, me } = meRoute.useRouteContext();
    return <MePage account={account} me={me} />;
  },
});

// Administration (08 §13, plan A1): account admins only — everyone else goes home. `/admin` opens "כללי".
const adminRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/admin',
  beforeLoad: ({ context, params }) => {
    if (context.account.role !== 'admin') {
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
    }
  },
  component: function Admin() {
    const { account } = adminRoute.useRouteContext();
    return <AdminHub account={account} />;
  },
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/a/$accountSlug/admin/$section',
      params: { accountSlug: params.accountSlug, section: 'general' },
      replace: true,
    });
  },
});

const adminSectionRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/$section',
  beforeLoad: ({ params }) => {
    if (!isAdminSection(params.section)) throw notFound();
  },
  component: function AdminSection() {
    const { account } = adminSectionRoute.useRouteContext();
    const { section } = adminSectionRoute.useParams();
    return isAdminSection(section) ? <AdminSectionPage key={section} account={account} section={section} /> : null;
  },
});

// s37market: the extension developer guide and quickstart in the app shell — whoever may manage extensions (admins,
// like the Extensions section; the API checks the same). `/admin/extensions/docs/guide` | `/quickstart`.
const adminDevDocsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/extensions/docs/$doc',
  beforeLoad: ({ params }) => {
    if (!(EXTENSION_DOC_PAGES as readonly string[]).includes(params.doc)) throw notFound();
  },
  component: function AdminDevDocs() {
    const { account } = adminDevDocsRoute.useRouteContext();
    const { doc } = adminDevDocsRoute.useParams();
    return <DevDocsPage key={doc} account={account} page={doc as ExtensionDocPageKey} />;
  },
});

// Support tickets: "My tickets" and one ticket (`?approve=` marks an access request from the email).
// Guests have none; inside an account opened by a support grant there are none either.
const supportRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/support',
  beforeLoad: ({ context, params }) => {
    if (context.account.role === 'guest' || context.account.support)
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Support() {
    const { account } = supportRoute.useRouteContext();
    return <MyTicketsPage account={account} />;
  },
});

// The knowledge center's page inside the account: `?category=<id>` a category, `?article=<slug>` one
// article. Like support: not for guests, nor inside an account opened by a support grant.
const knowledgeRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/help',
  validateSearch: parseKbSearch,
  beforeLoad: ({ context, params }) => {
    if (helpHiddenFor(context.account))
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Knowledge() {
    const { account } = knowledgeRoute.useRouteContext();
    const search = knowledgeRoute.useSearch();
    const navigate = knowledgeRoute.useNavigate();
    return (
      <KnowledgeCenterPage
        account={account}
        search={search}
        onNavigate={(next) => {
          void navigate({ search: next });
          // A new view starts at the top of the panel (the page scrolls inside the shell's panel).
          document.querySelector('.app-panel')?.scrollTo({ top: 0 });
        }}
      />
    );
  },
});

// Every guided tour, from the "?" menu: what the person finished, and "run it again". Like the
// knowledge center: not for guests, nor inside an account opened by a support grant.
const toursRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/tours',
  beforeLoad: ({ context, params }) => {
    if (helpHiddenFor(context.account))
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Tours() {
    const { account } = toursRoute.useRouteContext();
    return <ToursPage account={account} />;
  },
});

// "How to start?": a full template or "Build with AI" — after a self sign-up, and from the "+" menu.
const startRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/start',
  component: function Start() {
    const { account } = startRoute.useRouteContext();
    return <StartPage account={account} />;
  },
});

// The installation and licensing guide, from the help menu: `?locale=en`, `?section=activate`.
// Like support: not for guests, nor inside an account opened by a support grant.
const guideRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/guide',
  validateSearch: (s: Record<string, unknown>): { locale?: 'he' | 'en'; section?: string } => ({
    ...(s.locale === 'en' || s.locale === 'he' ? { locale: s.locale } : {}),
    ...(typeof s.section === 'string' && s.section && s.section.length <= 200 ? { section: s.section } : {}),
  }),
  beforeLoad: ({ context, params }) => {
    if (context.account.role === 'guest' || context.account.support)
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Guide() {
    const search = guideRoute.useSearch();
    const navigate = guideRoute.useNavigate();
    return (
      <GuidePage
        locale={search.locale}
        section={search.section}
        onChange={(next) => void navigate({ search: next, replace: true })}
      />
    );
  },
});

const ticketRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/support/$ticketId',
  validateSearch: (s: Record<string, unknown>): { approve?: string } =>
    typeof s.approve === 'string' && /^[0-9A-Z]{26}$/.test(s.approve) ? { approve: s.approve } : {},
  beforeLoad: ({ context, params }) => {
    if (context.account.role === 'guest' || context.account.support)
      throw redirect({ to: '/a/$accountSlug', params: { accountSlug: params.accountSlug } });
  },
  component: function Ticket() {
    const { account } = ticketRoute.useRouteContext();
    const { ticketId } = ticketRoute.useParams();
    const { approve } = ticketRoute.useSearch();
    return <TicketPage key={ticketId} account={account} ticketId={ticketId} approve={approve} />;
  },
});

const workspaceRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/w/$workspaceId',
  component: function Workspace() {
    const { account } = workspaceRoute.useRouteContext();
    const { workspaceId } = workspaceRoute.useParams();
    return <WorkspacePage key={workspaceId} account={account} workspaceId={workspaceId} />;
  },
});

const docRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/d/$docId',
  // `thread`: open the comments on it (a doc notification).
  validateSearch: (s: Record<string, unknown>): { thread?: string } =>
    typeof s.thread === 'string' && s.thread ? { thread: s.thread } : {},
  component: function Doc() {
    const { account, me } = docRoute.useRouteContext();
    const { docId } = docRoute.useParams();
    const { thread } = docRoute.useSearch();
    return <DocPage key={docId} account={account} me={me} docId={docId} thread={thread} />;
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/dash/$dashboardId',
  component: function Dashboard() {
    const { account } = dashboardRoute.useRouteContext();
    const { dashboardId } = dashboardRoute.useParams();
    return (
      <>
        <DashboardPage key={dashboardId} account={account} dashboardId={dashboardId} />
        <Outlet />
      </>
    );
  },
});

/**
 * an item clicked in a dashboard widget opens its card over the dashboard — the board's card, with
 * its links (another item, a subitem, an update's thread) staying here and closing back to the dashboard.
 */
const dashboardItemRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: '/i/$boardId/$itemId',
  validateSearch: (s: Record<string, unknown>): { tab?: string; update?: string } => ({
    ...(typeof s.tab === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(s.tab) ? { tab: s.tab } : {}),
    ...(isUpdateLinkId(s[UPDATE_LINK_PARAM]) ? { update: s[UPDATE_LINK_PARAM] } : {}),
  }),
  component: function DashboardItem() {
    const { account, me } = dashboardItemRoute.useRouteContext();
    const { dashboardId, boardId, itemId } = dashboardItemRoute.useParams();
    const { tab, update } = dashboardItemRoute.useSearch();
    return (
      <AreaBoundary
        area="item"
        resetKey={itemId}
        fallback={({ error, retry }) => (
          <ItemCardCrash
            error={error}
            retry={retry}
            account={account}
            boardId={boardId}
            back={{ to: '/a/$accountSlug/dash/$dashboardId', params: { accountSlug: account.slug, dashboardId } }}
          />
        )}
      >
        <ItemCard
          key={itemId}
          account={account}
          me={me}
          boardId={boardId}
          itemId={itemId}
          initialTab={tab}
          focusUpdate={update}
          routes={{
            card: (id) => ({
              to: '/a/$accountSlug/dash/$dashboardId/i/$boardId/$itemId',
              params: { accountSlug: account.slug, dashboardId, boardId, itemId: id },
            }),
            back: { to: '/a/$accountSlug/dash/$dashboardId', params: { accountSlug: account.slug, dashboardId } },
          }}
        />
      </AreaBoundary>
    );
  },
});

const boardRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: '/b/$boardId',
  // ?view= opens a view, ?q= a draft query over it (15-VIEWS §2) — both shareable. ?column_settings=<key> opens that
  // column's settings (a notification's link, r19relfilter).
  validateSearch: (s: Record<string, unknown>): { view?: string; q?: string; column_settings?: string } => ({
    ...(typeof s.view === 'string' ? { view: s.view } : {}),
    ...(typeof s.q === 'string' ? { q: s.q } : {}),
    ...(typeof s.column_settings === 'string' ? { column_settings: s.column_settings } : {}),
  }),
  component: function Board() {
    const { account, me } = boardRoute.useRouteContext();
    const { boardId } = boardRoute.useParams();
    // The page reads these on mount only; afterwards it mirrors its own state into the URL.
    const search = boardRoute.useSearch();
    return (
      <>
        <BoardPage
          key={boardId}
          account={account}
          meId={me.user.id}
          boardId={boardId}
          initialViewId={search.view}
          initialQ={search.q}
        />
        <Outlet />
      </>
    );
  },
});

const itemRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: '/i/$itemId',
  // ?tab=time|activity opens the card on that tab (e.g. a time cell opens the log).
  // A card tab id (N19: the board's tabs — updates, fields, time, activity or an added fields tab).
  // ?update= (s37reply): the card shows only that update's thread; a reply id also scrolls to that reply.
  validateSearch: (s: Record<string, unknown>): { tab?: string; update?: string } => ({
    ...(typeof s.tab === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(s.tab) ? { tab: s.tab } : {}),
    ...(isUpdateLinkId(s[UPDATE_LINK_PARAM]) ? { update: s[UPDATE_LINK_PARAM] } : {}),
  }),
  component: function Item() {
    const { account, me } = itemRoute.useRouteContext();
    const { boardId, itemId } = itemRoute.useParams();
    const { tab, update } = itemRoute.useSearch();
    // Round 12: a crash in the card stays in the card's frame (it can still be closed); the board keeps working.
    return (
      <AreaBoundary
        area="item"
        resetKey={itemId}
        fallback={({ error, retry }) => (
          <ItemCardCrash error={error} retry={retry} account={account} boardId={boardId} />
        )}
      >
        <ItemCard
          key={itemId}
          account={account}
          me={me}
          boardId={boardId}
          itemId={itemId}
          initialTab={tab}
          focusUpdate={update}
        />
      </AreaBoundary>
    );
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  panelRoute,
  setupRoute,
  signupRoute,
  signupVerifyRoute,
  signupCompleteRoute,
  inviteRoute,
  connectRoute,
  publicFormRoute,
  publicDocRoute,
  helpCenterRoute,
  legalIndexRoute,
  legalDocRoute,
  registerRoute,
  registerVerifyRoute,
  buyRoute,
  pricingRoute,
  buySuccessRoute,
  indexRoute,
  ownerRoute,
  accountRoute.addChildren([
    accountHomeRoute,
    trashRoute,
    archiveRoute,
    profileRoute,
    notificationSettingsRoute,
    tokensRoute,
    automationsRoute,
    flowsRoute,
    agentsRoute,
    agentRoute,
    myWorkRoute,
    inboxRoute,
    appPageRoute.addChildren([appPageItemRoute]),
    boardsRoute,
    meRoute,
    adminRoute.addChildren([adminIndexRoute, adminSectionRoute, adminDevDocsRoute]),
    supportRoute,
    ticketRoute,
    knowledgeRoute,
    toursRoute,
    startRoute,
    guideRoute,
    workspaceRoute,
    docRoute,
    dashboardRoute.addChildren([dashboardItemRoute]),
    boardRoute.addChildren([itemRoute]),
  ]),
]);

/** The item card's frame around the error screen: closing it goes back to the board (or the dashboard). */
const ItemCardCrash = ({
  error,
  retry,
  account,
  boardId,
  back,
}: {
  error: unknown;
  retry: () => void;
  account: MyAccount;
  boardId: string;
  back?: { to: string; params: Record<string, string> };
}) => {
  const navigate = useNavigate();
  const close = () =>
    void navigate({
      ...(back ?? { to: '/a/$accountSlug/b/$boardId', params: { accountSlug: account.slug, boardId } }),
      search: (p: Record<string, unknown>) => p,
    } as never);
  return (
    <div className="anim-scrim fixed inset-0 z-panel flex justify-start bg-[var(--scrim)]" onMouseDown={close}>
      <aside
        role="dialog"
        aria-label={t('error.generic')}
        data-testid="item-card-error"
        onMouseDown={(e) => e.stopPropagation()}
        className="anim-from-start flex h-full w-full flex-col bg-surface shadow-[var(--shadow-panel)] md:max-w-[640px] md:rounded-e-[var(--radius-panel)]"
      >
        <ErrorScreen
          error={error}
          variant="panel"
          area="item"
          onRetry={retry}
          homeHref={`/a/${account.slug}`}
          extra={
            <Button variant="ghost" data-testid="item-card-error-close" onClick={close}>
              {t('item.close')}
            </Button>
          }
        />
      </aside>
    </div>
  );
};

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // Round 12: every route's crash shows our error screen in its place — inside the app shell for account pages.
    defaultErrorComponent: RouteErrorScreen,
  });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
