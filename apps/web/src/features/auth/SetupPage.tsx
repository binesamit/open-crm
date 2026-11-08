// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LANGUAGE_NAMES, t, type Locale, type SetupResult, type SetupStatus } from '@bines/shared';
import { Badge, Button, cn, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { applyLocale, useLocale } from '../../lib/locale';
import { AUTH_INPUT, AuthShell } from './AuthShell';
import { passwordMinHint } from '../account/SecuritySection';

/** The setup status query (public): the sign-in route reads it to send a brand-new installation here. */
export const setupStatusKey = ['setup', 'status'] as const;
export const fetchSetupStatus = () => api().get<SetupStatus>('/setup');

const LANGUAGES: { value: Locale; label: string }[] = [
  { value: 'he', label: LANGUAGE_NAMES.he },
  { value: 'en', label: LANGUAGE_NAMES.en },
];

/**
 * /setup — first run of a new installation (no user yet): "Create the owner account". The person becomes the
 * platform owner and the admin of the first account, and is signed in. The server allows it once, while nobody
 * exists (POST /setup); the product name is optional (owner console → Platform settings later).
 */
export const SetupPage = ({ status }: { status: SetupStatus }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [productName, setProductName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const min = status.password_min_length;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < min) return setError(passwordMinHint(min));
    setBusy(true);
    try {
      await api().post<SetupResult>('/setup', {
        name: name.trim(),
        email: email.trim(),
        password,
        locale,
        ...(productName.trim() ? { product_name: productName.trim() } : {}),
      });
      // Signed in now (the answer set the session): the product name and "who am I" changed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.authConfig }),
        queryClient.invalidateQueries({ queryKey: setupStatusKey }),
        queryClient.refetchQueries({ queryKey: queryKeys.me }),
      ]);
      await navigate({ to: '/' });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={t('setup.title')}
      subtitle={t('setup.subtitle')}
      eyebrow={<Badge tone="warn">{t('setup.badge')}</Badge>}
      footer={t('setup.footer')}
    >
      <div className="flex justify-end gap-1" role="group" aria-label={t('setup.language')}>
        {LANGUAGES.map((l) => (
          <button
            key={l.value}
            type="button"
            onClick={() => applyLocale(l.value)}
            aria-pressed={locale === l.value}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-semibold',
              locale === l.value ? 'bg-surface-3 text-heading' : 'text-muted hover:text-heading',
            )}
            data-testid={`setup-lang-${l.value}`}
          >
            {l.label}
          </button>
        ))}
      </div>
      {!status.email_enabled ? <Notice>{t('setup.emailOff')}</Notice> : null}
      <form className="flex flex-col gap-[1.125rem]" onSubmit={onSubmit} data-testid="setup-form">
        <Field label={t('auth.name')}>
          <Input
            required
            autoComplete="name"
            className={AUTH_INPUT}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="setup-name"
          />
        </Field>
        <Field label={t('auth.email')}>
          <Input
            type="email"
            dir="ltr"
            required
            autoComplete="email"
            className={cn(AUTH_INPUT, 'text-end')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="setup-email"
          />
        </Field>
        <Field label={t('auth.password')} hint={passwordMinHint(min)}>
          <Input
            type="password"
            dir="ltr"
            required
            autoComplete="new-password"
            className={cn(AUTH_INPUT, 'text-end')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="setup-password"
          />
        </Field>
        <Field label={t('setup.productName')} hint={t('setup.productName.hint')}>
          <Input
            className={AUTH_INPUT}
            maxLength={60}
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            data-testid="setup-product"
          />
        </Field>
        {error ? (
          <Notice tone="error">
            <span data-testid="setup-error">{error}</span>
          </Notice>
        ) : null}
        <Button type="submit" variant="accent" size="lg" className="w-full" busy={busy} data-testid="setup-submit">
          {t('setup.submit')}
        </Button>
      </form>
    </AuthShell>
  );
};
