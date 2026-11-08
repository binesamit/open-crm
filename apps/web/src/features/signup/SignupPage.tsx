// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { t, type SignupConfig, type SignupProviderMethod } from '@bines/shared';
import { Badge, Button, cn, Field, Input, Notice, RadioCard, Skeleton, SkeletonRows } from '@bines/ui';
import { api } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { useAuthConfig } from '../../lib/branding';
import { useLocale } from '../../lib/locale';
import { passwordMinHint } from '../account/SecuritySection';
import { AUTH_INPUT, AuthShell, Divider, GoogleMark, MicrosoftMark } from '../auth/AuthShell';
import { useTurnstile } from '../forms/turnstile';
import { LegalConsentCheckbox, MarketingOptInCheckbox, useConsent } from '../legal/legal-links';
import {
  browserTimeZone,
  initialPlanId,
  pageLocale,
  planPriceLine,
  signupErrorMessage,
  trialDaysOf,
  useSignupConfig,
} from './signup-api';
import { InfoLines, SignupClosed, StatusIcon } from './SignupStates';

/**
 * /signup (D32, canvas Main + Verify screen 2): open a new account of your own — Google / Microsoft (only those the
 * owner turned on and configured), or name, organisation, work email and password; the plan (when the owner lets
 * people choose), the consent to the published documents and Turnstile (the owner's key). Always "check your email"
 * after a password start — whoever the address belongs to (the email says the rest). Closed = screen 5.
 */
export const SignupPage = ({ providerFailed, plan }: { providerFailed?: boolean; plan?: string }) => {
  const config = useSignupConfig();
  if (config.isPending)
    return (
      <AuthShell title="" wide>
        <Skeleton className="-mt-4 h-7 w-2/3" />
        <SkeletonRows rows={4} label={t('app.loading')} />
      </AuthShell>
    );
  if (!config.data?.open) return <SignupClosed />;
  return <SignupForm config={config.data} providerFailed={providerFailed} plan={plan} />;
};

type Draft = { name: string; org: string; email: string; password: string; planId: string; agreed: boolean };

const SignupForm = ({
  config,
  providerFailed,
  plan: wantedPlan,
}: {
  config: SignupConfig;
  providerFailed?: boolean;
  plan?: string;
}) => {
  const auth = useAuthConfig().data;
  const lang = useLocale();
  const [draft, setDraft] = useState<Draft>(() => ({
    name: '',
    org: '',
    email: '',
    password: '',
    planId: initialPlanId(config, wantedPlan),
    agreed: false,
  }));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  // A field people never see (bots fill it): the server answers the same and stores nothing.
  const [website, setWebsite] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(providerFailed ? t('signup.error.provider') : null);
  const [busy, setBusy] = useState<'password' | SignupProviderMethod | null>(null);
  const consent = useConsent(draft.agreed);
  // The marketing box: separate, unticked; sent only when ticked.
  const [marketing, setMarketing] = useState(false);
  const {
    ref: captchaRef,
    token: captchaToken,
    failed: captchaFailed,
    reset: resetCaptcha,
  } = useTurnstile(config.captcha_site_key, lang);
  const captchaReady = !config.captcha_site_key || !!captchaToken || captchaFailed;

  // Plan ה7: the platform lets people only join their organisation's account (by the address's domain) — no
  // organisation to name, no plan, no trial.
  const joinOnly = config.mode === 'domain_join';
  const plan = config.plans.find((p) => p.id === draft.planId);
  const trialDays = joinOnly ? 0 : trialDaysOf(config, plan);
  const password = config.methods.includes('password');
  // A provider shows only when the owner offers it for sign-up AND it is configured for sign-in.
  const providers = (['google', 'microsoft'] as const).filter((m) => config.methods.includes(m) && auth?.[m]);

  const common = () => ({
    plan_id: draft.planId || undefined,
    accept_legal: consent.accepted,
    ...(marketing ? { marketing_opt_in: true } : {}),
    captcha_token: captchaToken ?? undefined,
    locale: pageLocale(),
    timezone: browserTimeZone(),
    ...(website ? { website } : {}),
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (draft.password.length < config.password_min_length)
      return setError(passwordMinHint(config.password_min_length));
    setBusy('password');
    try {
      await api().post('/public/signup/start', {
        ...common(),
        name: draft.name.trim(),
        org_name: draft.org.trim(),
        email: draft.email.trim(),
        password: draft.password,
      });
      setSentTo(draft.email.trim());
    } catch (err) {
      setError(signupErrorMessage(err));
    } finally {
      setBusy(null);
      resetCaptcha();
    }
  };

  const onProvider = async (method: SignupProviderMethod) => {
    setError(null);
    setBusy(method);
    try {
      // The details on the form so far (the rest is asked after the provider) and the cookie that lets it create me.
      await api().post('/public/signup/intent', {
        ...common(),
        method,
        name: draft.name.trim(),
        org_name: draft.org.trim(),
      });
      const { error: err } = await authClient.signIn.social({
        provider: method,
        callbackURL: `/signup/complete?via=${method}`,
        newUserCallbackURL: `/signup/complete?via=${method}`,
        errorCallbackURL: '/signup?error=provider',
      });
      if (err) {
        setBusy(null);
        setError(t('signup.error.provider'));
      }
    } catch (err) {
      setBusy(null);
      resetCaptcha();
      setError(signupErrorMessage(err));
    }
  };

  if (sentTo)
    return (
      <CheckEmail
        email={sentTo}
        hours={config.link_hours}
        cooldown={config.resend_seconds}
        onBack={() => {
          setSentTo(null);
          set('password', '');
        }}
      />
    );

  return (
    <AuthShell
      wide
      title={joinOnly ? t('signup.join.title') : t('signup.title')}
      subtitle={
        joinOnly ? t('signup.join.subtitle') : config.sample_boards ? t('signup.subtitle.boards') : t('signup.subtitle')
      }
      eyebrow={
        trialDays ? (
          <Badge tone="warn">
            <span data-testid="signup-trial">{t('signup.trialChip', { n: trialDays })}</span>
          </Badge>
        ) : null
      }
      testId="signup-page"
    >
      {providers.map((m) => (
        <Button
          key={m}
          variant="secondary"
          size="lg"
          className="w-full disabled:opacity-60"
          busy={busy === m}
          disabled={!captchaReady || (busy !== null && busy !== m)}
          onClick={() => void onProvider(m)}
          data-testid={`signup-${m}`}
        >
          {busy === m ? null : m === 'google' ? <GoogleMark /> : <MicrosoftMark />}
          {t(m === 'google' ? 'signup.google' : 'signup.microsoft')}
        </Button>
      ))}
      {providers.length && password ? <Divider label={t('signup.orEmail')} /> : null}

      <form className="flex flex-col gap-4" onSubmit={onSubmit} data-testid="signup-form">
        {password ? (
          <>
            <div className={cn('grid gap-3', joinOnly ? 'grid-cols-1' : 'grid-cols-2 max-sm:grid-cols-1')}>
              <Field label={t('auth.name')}>
                <Input
                  required
                  autoComplete="name"
                  className={AUTH_INPUT}
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                  data-testid="signup-name"
                />
              </Field>
              {joinOnly ? null : (
                <Field label={t('signup.org')}>
                  <Input
                    required
                    autoComplete="organization"
                    className={AUTH_INPUT}
                    placeholder={t('signup.org.placeholder')}
                    value={draft.org}
                    onChange={(e) => set('org', e.target.value)}
                    data-testid="signup-org"
                  />
                </Field>
              )}
            </div>
            <Field label={t('signup.email')} hint={joinOnly ? t('signup.join.emailHint') : undefined}>
              <Input
                type="email"
                dir="ltr"
                required
                autoComplete="email"
                className={cn(AUTH_INPUT, 'text-end')}
                value={draft.email}
                onChange={(e) => set('email', e.target.value)}
                data-testid="signup-email"
              />
            </Field>
            <Field label={t('auth.password')} hint={passwordMinHint(config.password_min_length)}>
              <Input
                type="password"
                dir="ltr"
                required
                autoComplete="new-password"
                className={cn(AUTH_INPUT, 'text-end')}
                value={draft.password}
                onChange={(e) => set('password', e.target.value)}
                data-testid="signup-password"
              />
            </Field>
          </>
        ) : null}

        {!joinOnly && config.plans.length > 1 ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-semibold text-fg-2">{t('signup.plan')}</legend>
            <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1" data-testid="signup-plans">
              {config.plans.map((p) => (
                <RadioCard
                  key={p.id}
                  name="signup-plan"
                  checked={draft.planId === p.id}
                  onSelect={() => set('planId', p.id)}
                  title={p.name}
                  hint={planPriceLine(p, trialDaysOf(config, p))}
                  testId={`signup-plan-${p.id}`}
                />
              ))}
            </div>
          </fieldset>
        ) : null}

        {/* Turnstile ("interaction-only"): a challenge shows here only when Cloudflare asks for one. */}
        {config.captcha_site_key ? (
          <>
            <div ref={captchaRef} data-testid="signup-captcha" />
            {captchaFailed ? <Notice tone="warn">{t('captcha.loadFailed')}</Notice> : null}
          </>
        ) : null}

        <LegalConsentCheckbox checked={draft.agreed} onChange={(on) => set('agreed', on)} />
        <MarketingOptInCheckbox checked={marketing} onChange={setMarketing} />

        {/* The honeypot: off-screen, out of the tab order and hidden from screen readers. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="absolute -start-[9999px] size-px opacity-0"
        />

        {error ? (
          <Notice tone="error">
            <span data-testid="signup-error">{error}</span>
          </Notice>
        ) : null}

        {password ? (
          <Button
            type="submit"
            variant="accent"
            size="lg"
            className="w-full"
            busy={busy === 'password'}
            disabled={!captchaReady || !consent.ok || (busy !== null && busy !== 'password')}
            data-testid="signup-submit"
          >
            {t('signup.submit')}
          </Button>
        ) : null}
      </form>
      <Link to="/login" className="self-center text-xs text-heading underline-offset-2 hover:underline">
        {t('signup.haveAccount')}
      </Link>
    </AuthShell>
  );
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Screen 2: "check your email" — the address, tips, "send again" after the cooldown, "wrong address". */
export const CheckEmail = ({
  email,
  hours,
  cooldown,
  onBack,
}: {
  email: string;
  hours: number;
  cooldown: number;
  onBack: () => void;
}) => {
  const [left, setLeft] = useState(cooldown);
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  const resend = useMutation({
    mutationFn: () => api().post('/public/signup/resend', { email }),
    onSuccess: () => setLeft(cooldown),
  });
  return (
    <AuthShell
      title={t('signup.check.title')}
      icon={<StatusIcon name="mail" tone="warn" />}
      centered
      testId="signup-check-email"
    >
      <p className="text-[0.875rem] leading-relaxed text-fg-2">
        {t('signup.check.bodyPrefix')}{' '}
        <span dir="ltr" className="text-heading [unicode-bidi:isolate]" data-testid="signup-check-address">
          {email}
        </span>
        {t('signup.check.bodySuffix')}
      </p>
      <InfoLines lines={[t('signup.check.spam'), t('signup.check.valid', { n: hours })]} />
      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={left > 0}
        busy={resend.isPending}
        onClick={() => resend.mutate()}
        data-testid="signup-resend"
      >
        {left > 0 ? t('signup.check.resendIn', { time: clock(left) }) : t('signup.check.resend')}
      </Button>
      {resend.isSuccess && left > 0 ? (
        <Notice tone="success">
          <span data-testid="signup-resent">{t('signup.check.resent')}</span>
        </Notice>
      ) : null}
      {resend.isError ? <Notice tone="error">{signupErrorMessage(resend.error)}</Notice> : null}
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-heading underline-offset-2 hover:underline"
        data-testid="signup-wrong-address"
      >
        {t('signup.check.wrongAddress')}
      </button>
    </AuthShell>
  );
};
