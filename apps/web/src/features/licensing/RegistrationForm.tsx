// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getLocale,
  type LicenseStatus,
  type LicensingSettings,
  REGISTRATION_SIZES,
  REGISTRATION_USE_CASES,
  type RegistrationSize,
  type RegistrationUseCase,
  t,
} from '@bines/shared';
import { Button, Field, Input, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { useTurnstile } from '../forms/turnstile';
import { licensingKeys, useLicensingSettings, useRegistrationForm } from './licensing-api';

const POLL_MS = 5_000;

/**
 * The registration questionnaire (docs/LICENSING.md, part C) — the first-run screen and the license card's "Get a
 * free key". Everything but the email is optional; the marketing box starts unticked; "Skip" is always there in the
 * first-run screen. Sending posts ONLY these answers (+ the installation's random id and version) to the license
 * server; a verification email follows and the Registered key installs itself once the address is verified.
 * With no license server configured: "registration unavailable". Offline: a link to register from another browser.
 */
export const RegistrationForm = ({
  onSkip,
  onDone,
  testId = 'registration',
}: {
  /** First run only: "Skip" (never asked again). */
  onSkip?: () => void;
  /** Registered (the key is installed), or the owner closed it. */
  onDone?: () => void;
  testId?: string;
}) => {
  const qc = useQueryClient();
  const settings = useLicensingSettings();
  const s = settings.data;
  const form = useRegistrationForm(!!s?.server_url);
  const lang = getLocale() === 'en' ? 'en' : 'he';
  const {
    ref: captchaRef,
    token: captchaToken,
    reset: resetCaptcha,
  } = useTurnstile(form.data?.captcha_site_key ?? null, lang);
  const [company, setCompany] = useState('');
  const [size, setSize] = useState<RegistrationSize | ''>('');
  const [role, setRole] = useState('');
  const [useCase, setUseCase] = useState<RegistrationUseCase | ''>('');
  const [email, setEmail] = useState('');
  const [marketing, setMarketing] = useState(false);

  const submit = useMutation({
    mutationFn: () =>
      api().post<LicensingSettings>('/platform/registration', {
        company,
        size: size || null,
        role,
        use_case: useCase || null,
        email: email.trim(),
        marketing_opt_in: marketing,
        locale: lang,
        ...(captchaToken ? { captcha_token: captchaToken } : {}),
      }),
    onSuccess: (res) => qc.setQueryData(licensingKeys.settings, res),
    onError: () => resetCaptcha(),
  });
  const poll = useMutation({
    mutationFn: () =>
      api().post<{ settings: LicensingSettings; license: LicenseStatus }>('/platform/registration/poll'),
    onSuccess: (res) => {
      qc.setQueryData(licensingKeys.settings, res.settings);
      qc.setQueryData(licensingKeys.license, res.license);
      if (res.settings.registration.status === 'registered') {
        void qc.invalidateQueries({ queryKey: queryKeys.myAccounts });
        // A license server registering with itself: its own Installations and Licenses lists show the new row.
        void qc.invalidateQueries({ queryKey: ['platform', 'installations'] });
        void qc.invalidateQueries({ queryKey: ['platform', 'licenses'] });
        onDone?.();
      }
    },
  });
  const pending = s?.registration.status === 'pending';
  // While the email waits to be verified: ask the license server every few seconds.
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => poll.mutate(), POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  if (settings.isPending) return <SkeletonRows rows={3} label={t('app.loading')} />;
  if (settings.isError) return <Notice tone="error">{errorMessage(settings.error)}</Notice>;
  if (!s) return null;

  const offline = s.offline_register_url ? (
    <p className="text-xs text-muted" data-testid={`${testId}-offline`}>
      {t('licensing.register.offline')}{' '}
      <a
        href={s.offline_register_url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-primary underline underline-offset-2"
      >
        {t('licensing.register.offlineLink')}
      </a>
    </p>
  ) : null;
  const skip = onSkip ? (
    <Button variant="ghost" size="sm" onClick={onSkip} data-testid={`${testId}-skip`}>
      {t('licensing.register.skip')}
    </Button>
  ) : null;

  if (!s.server_url || (form.data && !form.data.available) || form.isError)
    return (
      <div className="space-y-3" data-testid={testId} data-state="unavailable">
        <Notice tone="info">
          {s.server_url ? t('licensing.register.unreachable') : t('licensing.register.unavailable')}
        </Notice>
        {offline}
        {skip}
      </div>
    );
  if (s.registration.status === 'registered')
    return (
      <div className="space-y-3" data-testid={testId} data-state="registered">
        <Notice tone="success">{t('licensing.register.done')}</Notice>
      </div>
    );
  if (pending)
    return (
      <div className="space-y-3" data-testid={testId} data-state="pending">
        <Notice tone="info">{t('licensing.register.checkInbox', { email: s.registration.email ?? '' })}</Notice>
        <p className="text-xs text-muted">{t('licensing.register.pendingHint')}</p>
        {poll.isError ? <Notice tone="error">{errorMessage(poll.error)}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            busy={poll.isPending}
            onClick={() => poll.mutate()}
            data-testid={`${testId}-poll`}
          >
            {t('licensing.register.checkNow')}
          </Button>
          {onSkip ? (
            <Button variant="ghost" size="sm" onClick={onDone ?? onSkip} data-testid={`${testId}-later`}>
              {t('licensing.register.later')}
            </Button>
          ) : null}
        </div>
        {offline}
      </div>
    );

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <form
      className="space-y-3"
      data-testid={testId}
      data-state="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) submit.mutate();
      }}
    >
      <Field label={t('licensing.register.company')}>
        <Input
          value={company}
          maxLength={200}
          onChange={(e) => setCompany(e.target.value)}
          data-testid={`${testId}-company`}
        />
      </Field>
      <Field label={t('licensing.register.size')}>
        <Segmented
          label={t('licensing.register.size')}
          value={size}
          onChange={setSize}
          testId={`${testId}-size`}
          options={REGISTRATION_SIZES.map((v) => ({
            value: v,
            label: <span dir="ltr">{v}</span>,
            testId: `${testId}-size-${v}`,
          }))}
        />
      </Field>
      <Field label={t('licensing.register.role')}>
        <Input value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} data-testid={`${testId}-role`} />
      </Field>
      <Field label={t('licensing.register.useCase')}>
        <Segmented
          label={t('licensing.register.useCase')}
          value={useCase}
          onChange={setUseCase}
          testId={`${testId}-use`}
          options={REGISTRATION_USE_CASES.map((v) => ({
            value: v,
            label: t(`licensing.useCase.${v}`),
            testId: `${testId}-use-${v}`,
          }))}
        />
      </Field>
      <Field label={t('licensing.register.email')}>
        <Input
          type="email"
          dir="ltr"
          required
          value={email}
          maxLength={320}
          onChange={(e) => setEmail(e.target.value)}
          data-testid={`${testId}-email`}
        />
      </Field>
      <label className="flex items-start gap-2 text-sm text-fg-2">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
          checked={marketing}
          onChange={(e) => setMarketing(e.target.checked)}
          data-testid={`${testId}-marketing`}
        />
        <span>{t('licensing.register.marketing')}</span>
      </label>
      <p className="text-xs text-muted">{t('licensing.register.privacy')}</p>
      {form.data?.captcha_site_key ? <div ref={captchaRef} /> : null}
      {submit.isError ? <Notice tone="error">{errorMessage(submit.error)}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" busy={submit.isPending} disabled={!valid} data-testid={`${testId}-submit`}>
          {t('licensing.register.submit')}
        </Button>
        {skip}
      </div>
      {offline}
    </form>
  );
};
