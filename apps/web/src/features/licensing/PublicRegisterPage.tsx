// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CAPTCHA_TOKEN_HEADER,
  getLocale,
  type PublicRegisterResult,
  type PublicVerifyResult,
  REGISTRATION_SIZES,
  REGISTRATION_USE_CASES,
  type RegistrationForm,
  type RegistrationSize,
  type RegistrationUseCase,
  t,
} from '@bines/shared';
import { Button, Field, Input, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { AuthShell } from '../auth/AuthShell';
import { useTurnstile } from '../forms/turnstile';

/**
 * The license server's public pages (docs/LICENSING.md, part C) — for installations without internet access:
 * `/register?instance=<id>` takes the questionnaire in any browser and emails a verification link;
 * `/register/verify?token=…` (that link) verifies the address and shows the Registered key to paste into the
 * installation's owner console. On an installation that is not a license server the API answers 404 and the page
 * says so.
 */
export const PublicRegisterPage = ({ instance }: { instance?: string }) => {
  const lang = getLocale() === 'en' ? 'en' : 'he';
  const config = useQuery({
    queryKey: ['public', 'installations', 'config'],
    queryFn: () => api().get<RegistrationForm>('/public/installations/config'),
    retry: false,
  });
  const {
    ref: captchaRef,
    token: captchaToken,
    reset: resetCaptcha,
  } = useTurnstile(config.data?.captcha_site_key ?? null, lang);
  const [instanceId, setInstanceId] = useState(instance ?? '');
  const [company, setCompany] = useState('');
  const [size, setSize] = useState<RegistrationSize | ''>('');
  const [role, setRole] = useState('');
  const [useCase, setUseCase] = useState<RegistrationUseCase | ''>('');
  const [email, setEmail] = useState('');
  const [marketing, setMarketing] = useState(false);
  const submit = useMutation({
    mutationFn: () =>
      api().post<PublicRegisterResult>(
        '/public/installations/register',
        {
          instance_id: instanceId.trim(),
          company,
          size: size || null,
          role,
          use_case: useCase || null,
          email: email.trim(),
          marketing_opt_in: marketing,
          locale: lang,
        },
        captchaToken ? { [CAPTCHA_TOKEN_HEADER]: captchaToken } : undefined,
      ),
    onError: () => resetCaptcha(),
  });
  const valid = /^[A-Za-z0-9-]{8,64}$/.test(instanceId.trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <AuthShell title={t('licensing.public.title')} subtitle={t('licensing.public.subtitle')}>
      <div data-testid="public-register">
        {config.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {config.isError ? <Notice tone="info">{t('licensing.server.off')}</Notice> : null}
        {submit.isSuccess ? (
          <Notice tone="success">{t('licensing.register.checkInbox', { email: email.trim() })}</Notice>
        ) : null}
        {config.data && !submit.isSuccess ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) submit.mutate();
            }}
          >
            <Field label={t('licensing.public.instance')} hint={t('licensing.public.instanceHint')}>
              <Input
                dir="ltr"
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
                data-testid="public-register-instance"
              />
            </Field>
            <Field label={t('licensing.register.company')}>
              <Input value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} />
            </Field>
            <Field label={t('licensing.register.size')}>
              <Segmented
                label={t('licensing.register.size')}
                value={size}
                onChange={setSize}
                options={REGISTRATION_SIZES.map((v) => ({ value: v, label: <span dir="ltr">{v}</span> }))}
              />
            </Field>
            <Field label={t('licensing.register.role')}>
              <Input value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} />
            </Field>
            <Field label={t('licensing.register.useCase')}>
              <Segmented
                label={t('licensing.register.useCase')}
                value={useCase}
                onChange={setUseCase}
                options={REGISTRATION_USE_CASES.map((v) => ({ value: v, label: t(`licensing.useCase.${v}`) }))}
              />
            </Field>
            <Field label={t('licensing.register.email')}>
              <Input
                type="email"
                dir="ltr"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="public-register-email"
              />
            </Field>
            <label className="flex items-start gap-2 text-sm text-fg-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
              />
              <span>{t('licensing.register.marketing')}</span>
            </label>
            <p className="text-xs text-muted">{t('licensing.register.privacy')}</p>
            {config.data.captcha_site_key ? <div ref={captchaRef} /> : null}
            {submit.isError ? <Notice tone="error">{errorMessage(submit.error)}</Notice> : null}
            <Button type="submit" busy={submit.isPending} disabled={!valid} data-testid="public-register-submit">
              {t('licensing.register.submit')}
            </Button>
          </form>
        ) : null}
      </div>
    </AuthShell>
  );
};

export const PublicVerifyPage = ({ token }: { token?: string }) => {
  const verify = useMutation({
    mutationFn: () => api().post<PublicVerifyResult>('/public/installations/verify', { token }),
  });
  const started = useRef(false);
  useEffect(() => {
    if (token && !started.current) {
      started.current = true;
      verify.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const [copied, setCopied] = useState(false);
  const key = verify.data?.key;
  return (
    <AuthShell title={t('licensing.verify.title')}>
      <div className="space-y-3" data-testid="public-verify">
        {!token ? <Notice tone="error">{t('error.verification_invalid')}</Notice> : null}
        {verify.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
        {verify.isError ? <Notice tone="error">{errorMessage(verify.error)}</Notice> : null}
        {key ? (
          <>
            <Notice tone="success">{t('licensing.verify.done')}</Notice>
            <p className="text-sm text-fg-2">{t('licensing.verify.paste')}</p>
            <textarea
              readOnly
              rows={4}
              dir="ltr"
              value={key}
              data-testid="public-verify-key"
              className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 font-mono text-xs text-fg"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(key)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }
            >
              {copied ? t('licensing.licenses.copied') : t('licensing.licenses.copy')}
            </Button>
          </>
        ) : null}
      </div>
    </AuthShell>
  );
};
