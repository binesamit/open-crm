// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, t, type MySecurity } from '@bines/shared';
import { QrCode } from '../forms/QrCode';
import { Badge, Button, Field, Input, Notice, SkeletonRows } from '@bines/ui';
import { api, queryKeys } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { confirmDialog } from '../../lib/dialogs';
import { copyText } from '../../lib/entity-menu';
import { showToast } from '../../lib/toast';
import { reasonMessage } from './CopyLink';

/**
 * Two-factor authentication for the person (M8 ד12, D25): an authenticator app (TOTP) with 10 backup codes —
 * turned on in the profile's "כניסה ואבטחה" tab, or right after sign-in when an account requires it.
 */
export const securityKey = ['me', 'security'] as const;

export const useMySecurity = () =>
  useQuery({ queryKey: securityKey, queryFn: () => api().get<MySecurity>('/me/security') });

/** Better Auth's answer → a sentence. */
export const authFailure = (err: { status?: number; message?: string; code?: string } | null | undefined) =>
  !err
    ? t('auth.error.generic')
    : err.message === 'two_factor_required_by_policy'
      ? t('sec2.disable.required')
      : err.status === 429
        ? t('auth.rateLimited')
        : err.code === 'INVALID_PASSWORD' || /password/i.test(err.message ?? '')
          ? t('sec2.password.wrong')
          : err.status === 401 || err.status === 400
            ? t('sec2.code.invalid')
            : t('auth.error.generic');

/** A 6-digit code field (numeric keyboard on phones, one-time-code autofill). */
export const CodeInput = ({
  value,
  onChange,
  testId,
  backup,
}: {
  value: string;
  onChange: (v: string) => void;
  testId: string;
  backup?: boolean;
}) => (
  <Input
    value={value}
    onChange={(e) => onChange(backup ? e.target.value.trim() : e.target.value.replace(/\D/g, '').slice(0, 6))}
    inputMode={backup ? 'text' : 'numeric'}
    autoComplete="one-time-code"
    dir="ltr"
    className="text-center font-mono text-lg tracking-[0.3em]"
    maxLength={backup ? 32 : 6}
    placeholder={backup ? 'xxxxx-xxxxx' : '000000'}
    aria-label={backup ? t('sec2.backup.label') : t('sec2.code.label')}
    data-testid={testId}
  />
);

/** The backup codes, once: copy or save as a text file. */
export const BackupCodes = ({ codes, onDone }: { codes: string[]; onDone: () => void }) => {
  const text = codes.join('\n');
  const save = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bines-os-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3" data-testid="two-factor-backup-codes">
      <Notice tone="warn">{t('sec2.backup.once')}</Notice>
      <ul className="grid grid-cols-2 gap-1.5 rounded-[var(--radius)] bg-surface-2 p-3 font-mono text-sm" dir="ltr">
        {codes.map((c) => (
          <li key={c} data-testid="two-factor-backup-code" className="text-center">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => copyText(text)} data-testid="two-factor-backup-copy">
          {t('sec2.backup.copy')}
        </Button>
        <Button variant="secondary" size="sm" onClick={save} data-testid="two-factor-backup-save">
          {t('sec2.backup.save')}
        </Button>
        <Button size="sm" onClick={onDone} data-testid="two-factor-backup-done">
          {t('sec2.backup.done')}
        </Button>
      </div>
    </div>
  );
};

type Step = { kind: 'start' } | { kind: 'scan'; uri: string; codes: string[] } | { kind: 'codes'; codes: string[] };

/**
 * Turning it on: confirm with the password (people who sign in by link or Google have none) → scan the QR → enter the
 * first code → keep the backup codes.
 */
export const TwoFactorSetup = ({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) => {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: err } = await authClient.twoFactor.enable(hasPassword ? { password } : {});
    setBusy(false);
    if (err || !data || !('totpURI' in data) || !data.totpURI) return setError(authFailure(err));
    setPassword('');
    setStep({ kind: 'scan', uri: data.totpURI, codes: data.backupCodes ?? [] });
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'scan' || code.length !== 6) return;
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (err) return setError(authFailure(err));
    await Promise.all([
      qc.invalidateQueries({ queryKey: securityKey }),
      qc.invalidateQueries({ queryKey: queryKeys.me }),
    ]);
    setStep({ kind: 'codes', codes: step.codes });
  };

  const secret = step.kind === 'scan' ? (new URL(step.uri).searchParams.get('secret') ?? '') : '';

  return (
    <div className="space-y-4" data-testid="two-factor-setup" data-step={step.kind}>
      {step.kind === 'start' ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void start(e)} noValidate>
          <p className="text-sm text-fg-2">{t('sec2.setup.intro')}</p>
          {hasPassword ? (
            <Field label={t('sec2.password.confirm')}>
              <Input
                type="password"
                dir="ltr"
                autoComplete="current-password"
                className="text-end"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="two-factor-password"
              />
            </Field>
          ) : null}
          <div>
            <Button type="submit" busy={busy} disabled={hasPassword && !password} data-testid="two-factor-start">
              {t('sec2.setup.start')}
            </Button>
          </div>
        </form>
      ) : step.kind === 'scan' ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void verify(e)} noValidate>
          <ol className="list-decimal space-y-1 ps-5 text-sm text-fg-2">
            <li>{t('sec2.setup.step1')}</li>
            <li>{t('sec2.setup.step2')}</li>
            <li>{t('sec2.setup.step3')}</li>
          </ol>
          <div className="flex flex-wrap items-center gap-4">
            <QrCode value={step.uri} size={184} label={t('sec2.qr.label')} testId="two-factor-qr" />
            <div className="min-w-0 space-y-1 text-xs text-muted">
              <div>{t('sec2.setup.manual')}</div>
              <code
                dir="ltr"
                className="block rounded bg-surface-2 px-2 py-1 font-mono text-[0.75rem] break-all text-fg"
                data-testid="two-factor-secret"
                data-uri={step.uri}
              >
                {secret}
              </code>
            </div>
          </div>
          <Field label={t('sec2.code.label')}>
            <CodeInput value={code} onChange={setCode} testId="two-factor-code" />
          </Field>
          <div>
            <Button type="submit" busy={busy} disabled={code.length !== 6} data-testid="two-factor-verify">
              {t('sec2.setup.verify')}
            </Button>
          </div>
        </form>
      ) : (
        <BackupCodes codes={step.codes} onDone={onDone} />
      )}
      {error ? (
        <Notice tone="error">
          <span data-testid="two-factor-error">{error}</span>
        </Notice>
      ) : null}
    </div>
  );
};

/** Profile → "כניסה ואבטחה": the person's 2FA — on/off, new backup codes, and whether an account requires it. */
export const TwoFactorSection = () => {
  const qc = useQueryClient();
  const security = useMySecurity();
  const [setup, setSetup] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'codes' | 'off' | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (security.isPending) return <SkeletonRows rows={2} label={t('app.loading')} />;
  if (security.isError) return <Notice tone="error">{reasonMessage(security.error)}</Notice>;
  const { has_password: hasPassword, two_factor: state } = security.data;
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: securityKey }), qc.invalidateQueries({ queryKey: queryKeys.me })]);

  const newCodes = async () => {
    setBusy('codes');
    setError(null);
    const { data, error: err } = await authClient.twoFactor.generateBackupCodes(hasPassword ? { password } : {});
    setBusy(null);
    if (err || !data) return setError(authFailure(err));
    setPassword('');
    setCodes(data.backupCodes);
  };
  const turnOff = async () => {
    const ok = await confirmDialog({
      title: t('sec2.disable.confirm'),
      message: t('sec2.disable.hint'),
      confirmLabel: t('sec2.disable.action'),
      danger: true,
    });
    if (!ok) return;
    setBusy('off');
    setError(null);
    const { error: err } = await authClient.twoFactor.disable(hasPassword ? { password } : {});
    setBusy(null);
    if (err) return setError(authFailure(err));
    setPassword('');
    await refresh();
    showToast({ message: t('sec2.disable.done') });
  };

  return (
    <section
      className="mt-8 max-w-[520px] space-y-4 border-t border-line-soft pt-6"
      data-testid="profile-two-factor"
      data-enabled={state.enabled}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base leading-snug font-bold text-heading">{t('sec2.title')}</h2>
        <Badge tone={state.enabled ? 'ok' : 'neutral'}>
          {state.enabled ? t('sec2.status.on') : t('sec2.status.off')}
        </Badge>
      </div>
      <p className="text-sm text-muted">{t('sec2.subtitle')}</p>
      {state.required && !state.enabled ? (
        <Notice tone={state.must_enroll ? 'error' : 'warn'}>
          <span data-testid="two-factor-required">
            {state.deadline && !state.must_enroll
              ? t('sec2.required.until', { date: formatDateTime(state.deadline) })
              : t('sec2.required.now')}
          </span>
        </Notice>
      ) : null}
      {codes ? (
        <BackupCodes codes={codes} onDone={() => setCodes(null)} />
      ) : setup ? (
        // Kept until its last step is done: the first code turns 2FA on (state.enabled flips with the refetch), and
        // the backup codes come after that — shown once.
        <TwoFactorSetup
          hasPassword={hasPassword}
          onDone={() => {
            setSetup(false);
            void refresh();
            showToast({ message: t('sec2.setup.done') });
          }}
        />
      ) : !state.enabled ? (
        <Button onClick={() => setSetup(true)} data-testid="two-factor-enable">
          {t('sec2.enable')}
        </Button>
      ) : (
        <div className="space-y-3">
          {hasPassword ? (
            <Field label={t('sec2.password.confirmChange')}>
              <Input
                type="password"
                dir="ltr"
                autoComplete="current-password"
                className="max-w-[320px] text-end"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="two-factor-manage-password"
              />
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              busy={busy === 'codes'}
              disabled={hasPassword && !password}
              onClick={() => void newCodes()}
              data-testid="two-factor-new-codes"
            >
              {t('sec2.backup.regenerate')}
            </Button>
            <Button
              variant="danger-outline"
              busy={busy === 'off'}
              disabled={(hasPassword && !password) || state.required}
              title={state.required ? t('sec2.disable.required') : undefined}
              onClick={() => void turnOff()}
              data-testid="two-factor-disable"
            >
              {t('sec2.disable.action')}
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <Notice tone="error">
          <span data-testid="two-factor-manage-error">{error}</span>
        </Notice>
      ) : null}
    </section>
  );
};
