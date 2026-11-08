// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { formatDateTime, type LoginProvider, t } from '@bines/shared';
import { Button, SkeletonRows } from '@bines/ui';
import { fetchMe, type MyAccount, queryKeys } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { Icon } from '../../lib/icons';
import { AuthShell, GoogleMark, MicrosoftMark } from '../auth/AuthShell';
import { TwoFactorSetup, useMySecurity } from './TwoFactor';

const useMe = () => useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });

/**
 * M8 ד12: when an account requires 2FA and its grace period is over, the person turns it on right here, before
 * anything else (the account's API answers 403 two_factor_required until then). Signing out is the only other way.
 */
export const TwoFactorGate = ({ account, children }: { account: MyAccount; children: ReactNode }) => {
  const qc = useQueryClient();
  const me = useMe();
  const state = me.data?.user.two_factor;
  // Plan: the account requires Google / Microsoft sign-in and this session came another way.
  const sso = me.data?.user.sso_gate?.find((g) => g.account_id === account.id);
  // Held until the setup's last step: the first code turns 2FA on (must_enroll clears with the refetch), and the
  // backup codes — shown once — come after it. Let go if the requirement went away without 2FA being turned on.
  const [enrolling, setEnrolling] = useState(false);
  if (state?.must_enroll && !enrolling) setEnrolling(true);
  if (enrolling && !state?.must_enroll && !state?.enabled) setEnrolling(false);
  if (sso) return <SsoNow providers={sso.providers} organization={!!sso.organization} />;
  if (!state?.must_enroll && !(enrolling && state?.enabled)) return <>{children}</>;
  return (
    <EnrolNow
      onDone={async () => {
        await qc.invalidateQueries({ queryKey: queryKeys.me });
        setEnrolling(false);
      }}
    />
  );
};

/**
 * S-77: the owner console requires two-factor sign-in (owner console → Platform settings → Security) and this platform
 * owner / support person has not turned it on — they turn it on here; the console opens after.
 */
export const ConsoleTwoFactorGate = ({ children }: { children: ReactNode }) => {
  const qc = useQueryClient();
  const me = useMe();
  const required = !!me.data?.user.console_two_factor_required;
  const enabled = !!me.data?.user.two_factor?.enabled;
  // Held until the setup's last step (the backup codes come after 2FA is on and the requirement clears).
  const [enrolling, setEnrolling] = useState(false);
  if (required && !enrolling) setEnrolling(true);
  if (enrolling && !required && !enabled) setEnrolling(false);
  if (!enrolling) return <>{children}</>;
  return (
    <EnrolNow
      title={t('sec2.console.title')}
      subtitle={t('sec2.console.subtitle')}
      testId="console-two-factor-gate"
      onDone={async () => {
        await qc.invalidateQueries({ queryKey: queryKeys.me });
        setEnrolling(false);
      }}
    />
  );
};

const EnrolNow = ({
  onDone,
  title = t('sec2.gate.title'),
  subtitle = t('sec2.gate.subtitle'),
  testId = 'two-factor-gate',
}: {
  onDone: () => Promise<void>;
  title?: string;
  subtitle?: string;
  testId?: string;
}) => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const security = useMySecurity();
  const signOut = async () => {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: '/login' });
  };
  return (
    <AuthShell title={title} subtitle={subtitle}>
      <div data-testid={testId}>
        {security.data ? (
          <TwoFactorSetup hasPassword={security.data.has_password} onDone={() => void onDone()} />
        ) : (
          <SkeletonRows rows={3} label={t('app.loading')} />
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={() => void signOut()} data-testid="two-factor-gate-sign-out">
        {t('auth.signOut')}
      </Button>
    </AuthShell>
  );
};

/** During the grace period: a line at the top of every page with the date and a link to turn it on. */
export const TwoFactorBanner = ({ account }: { account: MyAccount }) => {
  const me = useMe();
  const state = me.data?.user.two_factor;
  if (!state?.required || state.enabled || state.must_enroll) return null;
  return (
    <div
      role="status"
      data-testid="two-factor-banner"
      className="flex shrink-0 items-center gap-2.5 border-b border-line bg-accent-soft px-4 py-2 text-sm text-fg max-md:px-3"
    >
      <Icon name="lock" size={16} className="shrink-0" />
      <p className="min-w-0 flex-1">
        {state.deadline ? t('sec2.banner.until', { date: formatDateTime(state.deadline) }) : t('sec2.required.now')}{' '}
        <Link
          to="/a/$accountSlug/profile"
          params={{ accountSlug: account.slug }}
          search={{ tab: 'security' }}
          className="font-semibold text-heading underline underline-offset-2 hover:no-underline"
          data-testid="two-factor-banner-link"
        >
          {t('sec2.banner.action')}
        </Link>
      </p>
    </div>
  );
};

/**
 * Plan: this account lets its people in only through Google / Microsoft (Administration → אבטחה). The
 * buttons sign in again through the provider and come back to this page; signing out is the other way.
 */
const SsoNow = ({ providers, organization }: { providers: LoginProvider[]; organization: boolean }) => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<LoginProvider | null>(null);
  const back = window.location.pathname + window.location.search;
  const go = async (provider: LoginProvider) => {
    setBusy(provider);
    const { error } = await authClient.signIn.social({ provider, callbackURL: back, errorCallbackURL: '/login' });
    if (error) setBusy(null);
  };
  const signOut = async () => {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: '/login' });
  };
  return (
    // S-72: signed in through the right provider with another organisation's (or a personal) account.
    <AuthShell
      title={t('sso.gate.title')}
      subtitle={t(organization ? 'sso.gate.subtitleOrganization' : 'sso.gate.subtitle')}
    >
      <div className="flex flex-col gap-2.5" data-testid="sso-gate">
        {providers.map((p) => (
          <Button
            key={p}
            variant="secondary"
            size="lg"
            className="w-full"
            busy={busy === p}
            onClick={() => void go(p)}
            data-testid={`sso-gate-${p}`}
          >
            {busy === p ? null : p === 'google' ? <GoogleMark /> : <MicrosoftMark />}
            {t(`sso.gate.continue.${p}`)}
          </Button>
        ))}
      </div>
      <Button variant="ghost" size="sm" onClick={() => void signOut()} data-testid="sso-gate-sign-out">
        {t('auth.signOut')}
      </Button>
    </AuthShell>
  );
};
