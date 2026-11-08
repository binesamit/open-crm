// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { t, type MessageKey } from '@bines/shared';
import { Badge, Button, cn, Field, Input, Notice, Skeleton, SkeletonRows } from '@bines/ui';
import { authClient, INVITE_TOKEN_HEADER } from '../../lib/auth-client';
import { api, errorMessage, fetchMe, type InvitationPreview, type MyAccount, queryKeys } from '../../lib/api';
import { useBranding } from '../../lib/branding';
import { AUTH_INPUT, AuthShell } from './AuthShell';
import { isTooShort, passwordMinHint } from '../account/SecuritySection';
import { authErrorCode, captchaRefusal, useAuthCaptcha } from '../captcha/auth-captcha';
import { LegalConsentCheckbox, useConsent } from '../legal/legal-links';

/**
 * /invite/:token — preview, then either accept (signed in with the invited email) or sign up with a password.
 * The token goes in request bodies/headers only; it never reaches query strings we might log.
 */
export const InvitePage = ({ token }: { token: string }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api().post<InvitationPreview>('/invitations/preview', { token }),
    retry: false,
  });
  const me = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const { productName } = useBranding();

  // joining agrees to the current version of every legal document that requires consent.
  const [agreed, setAgreed] = useState(false);
  const consent = useConsent(agreed);
  const consentOk = consent.ok;
  const accept = useMutation({
    mutationFn: () =>
      api().post<MyAccount>('/invitations/accept', {
        token,
        ...(consent.accepted.length ? { accepted_legal: consent.accepted } : {}),
      }),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
    },
  });

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Turnstile on sign-up when the owner console asks for it.
  const captcha = useAuthCaptcha('sign_up');

  if (preview.isPending || me.isPending) {
    return (
      // The title is not known yet: a skeleton bar stands in for it (N16).
      <AuthShell title="">
        <Skeleton className="-mt-4 h-7 w-2/3" />
        <SkeletonRows rows={3} label={t('app.loading')} />
      </AuthShell>
    );
  }
  if (preview.isError) {
    return (
      <AuthShell title={t('auth.login.titleOf', { product: productName })} footer={t('auth.noAccess')}>
        <Notice tone="error">{t('invite.invalid')}</Notice>
        <Link to="/login" className="text-center text-xs font-semibold text-heading hover:underline">
          {t('auth.signIn')}
        </Link>
      </AuthShell>
    );
  }

  const inv = preview.data;
  const role = t(`role.${inv.role}` as MessageKey);
  const signedInAs = me.data?.user.email;

  // The account's minimum, else the platform's — the server checks it again.
  const minLength = inv.password_min_length;
  const onSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < minLength) return setError(passwordMinHint(minLength));
    setBusy(true);
    const { error: err } = await authClient.signUp.email({
      email: inv.email,
      password,
      name,
      fetchOptions: { headers: { [INVITE_TOKEN_HEADER]: token, ...captcha.headers() } },
    });
    setBusy(false);
    captcha.reset();
    if (err)
      return setError(
        isTooShort(err)
          ? passwordMinHint(minLength)
          : (captchaRefusal(authErrorCode(err)) ?? (err.status === 422 ? t('invite.exists') : t('auth.error.generic'))),
      );
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    accept.mutate();
  };

  return (
    <AuthShell
      title={t('invite.title', { account: inv.account.name })}
      subtitle={t('invite.details', { email: inv.email, role })}
      eyebrow={<Badge tone="warn">{t('invite.badge')}</Badge>}
      footer={t('auth.noAccess')}
    >
      {accept.isError ? <Notice tone="error">{errorMessage(accept.error)}</Notice> : null}
      {error ? (
        <Notice tone="error">
          <span data-testid="invite-error">{error}</span>
        </Notice>
      ) : null}

      {signedInAs ? (
        signedInAs.toLowerCase() === inv.email.toLowerCase() ? (
          <>
            <LegalConsentCheckbox checked={agreed} onChange={setAgreed} />
            <Button
              variant="accent"
              size="lg"
              className="w-full"
              onClick={() => accept.mutate()}
              busy={accept.isPending}
              disabled={!consentOk}
            >
              {t('invite.accept')}
            </Button>
          </>
        ) : (
          <Notice tone="error">{t('invite.wrongUser', { email: signedInAs })}</Notice>
        )
      ) : (
        <>
          <form className="flex flex-col gap-[1.125rem]" onSubmit={onSignUp}>
            <Field label={t('auth.email')}>
              <Input
                value={inv.email}
                dir="ltr"
                readOnly
                className={cn(AUTH_INPUT, 'bg-surface-3 text-end text-fg-2 focus:ring-0')}
              />
            </Field>
            <Field label={t('auth.name')}>
              <Input
                required
                autoComplete="name"
                className={AUTH_INPUT}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={t('auth.password')} hint={passwordMinHint(minLength)}>
              <Input
                type="password"
                dir="ltr"
                required
                data-testid="invite-password"
                className={cn(AUTH_INPUT, 'text-end')}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <LegalConsentCheckbox checked={agreed} onChange={setAgreed} />
            {captcha.slot}
            <Button
              type="submit"
              variant="accent"
              size="lg"
              className="w-full"
              busy={busy || accept.isPending}
              disabled={!captcha.ready || !consentOk}
            >
              {t('invite.signUp')}
            </Button>
          </form>
          <Link
            to="/login"
            search={{ redirect: `/invite/${token}` }}
            className="block text-center text-xs font-semibold text-heading hover:underline"
          >
            {t('invite.haveAccount')}
          </Link>
        </>
      )}
    </AuthShell>
  );
};
