// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ApiError } from '@bines/sdk';
import { CAPTCHA_EXEMPT_HEADER, t } from '@bines/shared';
import { Button, cn, Field, Input, Notice, SkeletonRows } from '@bines/ui';
import { authClient } from '../../lib/auth-client';
import { api, queryKeys } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { isTooShort, NewPasswordFields, passwordMinHint, passwordProblem } from '../account/SecuritySection';
import { useAuthConfig, useBranding } from '../../lib/branding';
import { AUTH_INPUT, AuthShell, Divider, GoogleMark, MicrosoftMark } from './AuthShell';
import { TwoFactorChallenge } from './TwoFactorChallenge';
import { authErrorCode, captchaRefusal, useAuthCaptcha } from '../captcha/auth-captcha';
import { safeRedirect } from '../../lib/safe-redirect';
import { useSignupConfig } from '../signup/signup-api';

/**
 * Same-origin paths only, so ?redirect= cannot bounce users to another site (`lib/safe-redirect.ts`; the service
 * worker's `navigate` messages go through the same check).
 */
export { safeRedirect };

/** A one-time sign-in / new-password link opens /login#reset=<token> (a fragment never reaches a server log). */
const RESET_HASH = /^#reset=([\w-]{20,200})$/;

/** What to say when an auth email could not go out, or too many were asked for. */
const sendFailure = (status: number | undefined, message: string | undefined): string =>
  message === 'email_not_sent'
    ? t('auth.emailNotSent')
    : status === 429
      ? t('auth.rateLimited')
      : t('auth.error.generic');

type Mode = 'signin' | 'forgot';
type Provider = 'google' | 'microsoft';

/**
 * A provider sign-in that did not end in a session comes back as /login?error=<code> (Better Auth's
 * errorCallbackURL): most often no invitation for that address, or an address the provider does not vouch for.
 */
const providerError = (): string | null => {
  const code = new URLSearchParams(window.location.search).get('error');
  if (!code) return null;
  return /unable_to_create_user|invitation|signup/i.test(code)
    ? t('sso.login.noInvitation')
    : /email_not_verified|account_not_linked/i.test(code)
      ? t('sso.login.notVerified')
      : t('sso.login.failed');
};

/** A sign-in that answered "now the second factor" (M8 ד12) instead of a session. */
const needsSecondFactor = (data: unknown) => !!(data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect;

export const LoginPage = ({ redirect, twoFactor }: { redirect?: string; twoFactor?: boolean }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const target = safeRedirect(redirect);
  const config = useAuthConfig();
  // Email off (no mail transport on this installation): no sign-in link and no reset by email — password only.
  const emailOn = config.data?.magic_link !== false;
  // The platform's branding (owner console): the product name in the title, the tagline under it (none = no line).
  const branding = useBranding();
  // The token is read (also when the link opens in this very tab), then dropped from the address bar.
  const [resetToken, setResetToken] = useState(() => RESET_HASH.exec(window.location.hash)?.[1] ?? null);
  useEffect(() => {
    const read = () => {
      const token = RESET_HASH.exec(window.location.hash)?.[1];
      if (token) setResetToken(token);
    };
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    if (resetToken && window.location.hash)
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [resetToken]);

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'magic' | Provider | null>(null);
  const [error, setError] = useState<string | null>(providerError);
  const [magicSent, setMagicSent] = useState(false);
  // The code step: after a password here, or arriving from a magic link / Google (?two_factor=1).
  const [challenge, setChallenge] = useState(!!twoFactor);
  // Turnstile on sign-in when the owner console asks for it: password and magic link alike.
  const captcha = useAuthCaptcha('sign_in');
  // Self sign-up (D32): "no account? sign up" only while the owner has it open (else "by invitation only").
  const signupOpen = !!useSignupConfig().data?.open;

  const signedIn = async () => {
    // Refetch even while nothing observes it: the routes' guards read the cached "me" (null before signing in).
    await queryClient.refetchQueries({ queryKey: queryKeys.me });
    await navigate({ to: target });
  };

  if (challenge)
    return (
      <TwoFactorChallenge
        onDone={signedIn}
        onRestart={() => {
          setChallenge(false);
          setPassword('');
          void navigate({ to: '/login', search: target === '/' ? {} : { redirect: target }, replace: true });
        }}
      />
    );
  if (resetToken)
    return (
      <ResetPassword
        key={resetToken}
        token={resetToken}
        onDone={signedIn}
        onSecondFactor={() => {
          setResetToken(null);
          setChallenge(true);
        }}
      />
    );

  const onPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('password');
    setError(null);
    const { data, error: err } = await authClient.signIn.email({
      email,
      password,
      fetchOptions: { headers: captcha.headers() },
    });
    setBusy(null);
    captcha.reset();
    if (!err && needsSecondFactor(data)) return setChallenge(true);
    if (err)
      return setError(
        captchaRefusal(authErrorCode(err)) ??
          (err.status === 401
            ? t('auth.error.invalid')
            : err.status === 429
              ? t('auth.rateLimited')
              : t('auth.error.generic')),
      );
    await signedIn();
  };

  const onMagicLink = async () => {
    if (!email) return setError(t('auth.email'));
    setBusy('magic');
    setError(null);
    const { error: err } = await authClient.signIn.magicLink({
      email,
      callbackURL: target,
      fetchOptions: { headers: captcha.headers() },
    });
    setBusy(null);
    captcha.reset();
    if (err) return setError(captchaRefusal(authErrorCode(err)) ?? sendFailure(err.status, err.message));
    setMagicSent(true);
  };

  const onProvider = async (provider: Provider) => {
    setBusy(provider);
    setError(null);
    const { error: err } = await authClient.signIn.social({
      provider,
      callbackURL: target,
      errorCallbackURL: target === '/' ? '/login' : `/login?redirect=${encodeURIComponent(target)}`,
    });
    if (err) {
      setBusy(null);
      setError(t('sso.login.failed'));
    }
  };

  if (mode === 'forgot')
    return (
      <ForgotPassword
        email={email}
        onEmail={setEmail}
        onBack={() => {
          setMode('signin');
          setError(null);
        }}
      />
    );

  return (
    <AuthShell
      title={t('auth.login.titleOf', { product: branding.productName })}
      subtitle={branding.loginSubtitle ? <span data-testid="login-subtitle">{branding.loginSubtitle}</span> : null}
      footer={
        signupOpen ? (
          <>
            {t('signup.noAccount')}{' '}
            <Link to="/signup" className="text-shell-strong underline underline-offset-2" data-testid="login-signup">
              {t('signup.link')}
            </Link>
          </>
        ) : (
          t('auth.noAccess')
        )
      }
    >
      {magicSent ? <Notice tone="success">{t('auth.magicLink.sent')}</Notice> : null}

      <form className="flex flex-col gap-[1.125rem]" onSubmit={onPassword}>
        <Field label={t('auth.email')}>
          <Input
            type="email"
            dir="ltr"
            autoComplete="email"
            required
            className={cn(AUTH_INPUT, 'text-end')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t('auth.password')}>
          <Input
            type="password"
            dir="ltr"
            autoComplete="current-password"
            className={cn(AUTH_INPUT, 'text-end')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {emailOn ? (
          <button
            type="button"
            className="-mt-2 self-start text-xs font-semibold text-heading hover:underline"
            onClick={() => {
              setMode('forgot');
              setError(null);
            }}
            data-testid="login-forgot"
          >
            {t('auth.forgot.link')}
          </button>
        ) : null}
        {captcha.slot}
        <Button
          type="submit"
          variant="accent"
          size="lg"
          className="w-full"
          busy={busy === 'password'}
          disabled={!password || !captcha.ready}
        >
          {t('auth.signIn')}
        </Button>
      </form>

      {emailOn || config.data?.google || config.data?.microsoft ? <Divider label={t('auth.or')} /> : null}

      {emailOn ? (
        <Button
          variant="secondary"
          size="lg"
          className="w-full disabled:opacity-60"
          onClick={onMagicLink}
          busy={busy === 'magic'}
          disabled={!captcha.ready}
        >
          {busy === 'magic' ? null : <Icon name="mail" size={16} />}
          {t('auth.magicLink.send')}
        </Button>
      ) : null}
      {config.data?.google ? (
        <Button
          variant="secondary"
          size="lg"
          className="w-full disabled:opacity-60"
          onClick={() => void onProvider('google')}
          busy={busy === 'google'}
          data-testid="login-google"
        >
          {busy === 'google' ? null : <GoogleMark />}
          {t('auth.google')}
        </Button>
      ) : null}
      {config.data?.microsoft ? (
        <Button
          variant="secondary"
          size="lg"
          className="w-full disabled:opacity-60"
          onClick={() => void onProvider('microsoft')}
          busy={busy === 'microsoft'}
          data-testid="login-microsoft"
        >
          {busy === 'microsoft' ? null : <MicrosoftMark />}
          {t('sso.login.microsoft')}
        </Button>
      ) : null}
      {error ? (
        <Notice tone="error">
          <span data-testid="login-error">{error}</span>
        </Notice>
      ) : null}
    </AuthShell>
  );
};

/** "שכחתי סיסמה": a link to choose a new one by email — and, when email fails, where else to turn. */
const ForgotPassword = ({
  email,
  onEmail,
  onBack,
}: {
  email: string;
  onEmail: (v: string) => void;
  onBack: () => void;
}) => {
  const captcha = useAuthCaptcha('forgot_password');
  const request = useMutation({
    mutationFn: () => api().post('/auth/forgot-password', { email: email.trim() }, captcha.headers()),
    onSettled: () => captcha.reset(),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) request.mutate();
  };
  const failure = request.error
    ? request.error instanceof ApiError
      ? (captchaRefusal(request.error.body.code) ?? sendFailure(request.error.status, request.error.body.message))
      : t('auth.error.generic')
    : null;
  return (
    <AuthShell title={t('auth.forgot.title')} subtitle={t('auth.forgot.subtitle')} footer={t('auth.noAccess')}>
      <form className="flex flex-col gap-[1.125rem]" onSubmit={onSubmit} noValidate data-testid="forgot-form">
        <Field label={t('auth.email')}>
          <Input
            type="email"
            dir="ltr"
            autoComplete="email"
            className={cn(AUTH_INPUT, 'text-end')}
            value={email}
            onChange={(e) => onEmail(e.target.value)}
            data-testid="forgot-email"
          />
        </Field>
        {captcha.slot}
        <Button
          type="submit"
          variant="accent"
          size="lg"
          className="w-full"
          busy={request.isPending}
          disabled={!email.trim() || !captcha.ready}
          data-testid="forgot-send"
        >
          {t('auth.forgot.send')}
        </Button>
      </form>
      {request.isSuccess ? (
        <Notice tone="success">
          <span data-testid="forgot-sent">{t('auth.forgot.sent')}</span>
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="error">
          <span data-testid="forgot-error">{failure}</span>
        </Notice>
      ) : null}
      <button
        type="button"
        onClick={onBack}
        className="text-center text-xs font-semibold text-heading hover:underline"
        data-testid="forgot-back"
      >
        {t('auth.forgot.back')}
      </button>
    </AuthShell>
  );
};

/** /login#reset=… — choose a new password with a one-time link, then sign in with it. */
const ResetPassword = ({
  token,
  onDone,
  onSecondFactor,
}: {
  token: string;
  onDone: () => Promise<void>;
  onSecondFactor: () => void;
}) => {
  const preview = useQuery({
    queryKey: ['auth', 'recovery', token],
    queryFn: () =>
      api().post<{ email: string; expires_at: string; password_min_length: number }>('/auth/recovery/preview', {
        token,
      }),
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const back = () => window.location.assign('/login');

  if (preview.isPending)
    return (
      <AuthShell title={t('auth.reset.title')}>
        <SkeletonRows rows={3} label={t('app.loading')} />
      </AuthShell>
    );
  if (preview.isError)
    return (
      <AuthShell title={t('auth.reset.title')} footer={t('auth.noAccess')}>
        <Notice tone="error">
          <span data-testid="reset-invalid">{t('auth.reset.invalid')}</span>
        </Notice>
        <button type="button" onClick={back} className="text-center text-xs font-semibold text-heading hover:underline">
          {t('auth.signIn')}
        </button>
      </AuthShell>
    );

  const { email, password_min_length: minLength } = preview.data;
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const p = passwordProblem(password, confirm, minLength);
    setProblem(p);
    if (p) return;
    setBusy(true);
    // While sign-in asks for Turnstile, the reset answers with a one-use pass for the sign-in right after.
    let exempt: string | null = null;
    const { error: err } = await authClient.resetPassword({
      newPassword: password,
      token,
      fetchOptions: {
        onResponse: (ctx) => {
          exempt = ctx.response.headers.get(CAPTCHA_EXEMPT_HEADER);
        },
      },
    });
    if (err) {
      setBusy(false);
      return setProblem(
        isTooShort(err)
          ? passwordMinHint(minLength)
          : err.status === 400
            ? t('auth.reset.invalid')
            : t('auth.error.generic'),
      );
    }
    const pass: string | null = exempt;
    const signIn = await authClient.signIn.email({
      email,
      password,
      fetchOptions: { headers: pass ? { [CAPTCHA_EXEMPT_HEADER]: pass } : {} },
    });
    setBusy(false);
    if (signIn.error) return back();
    // A new password does not skip the second factor (M8 ד12).
    if (needsSecondFactor(signIn.data)) return onSecondFactor();
    await onDone();
  };

  return (
    <AuthShell
      title={t('auth.reset.title')}
      subtitle={
        <span dir="ltr" className="[unicode-bidi:isolate]">
          {email}
        </span>
      }
      footer={t('auth.noAccess')}
    >
      <form className="flex flex-col gap-[1.125rem]" onSubmit={onSubmit} noValidate data-testid="reset-form">
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
          testId="reset"
          minLength={minLength}
        />
        <Button type="submit" variant="accent" size="lg" className="w-full" busy={busy} data-testid="reset-save">
          {t('auth.reset.save')}
        </Button>
      </form>
      {problem ? (
        <Notice tone="error">
          <span data-testid="reset-error">{problem}</span>
        </Notice>
      ) : null}
    </AuthShell>
  );
};
