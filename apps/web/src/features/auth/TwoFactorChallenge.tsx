// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { t } from '@bines/shared';
import { Button, Field, Notice } from '@bines/ui';
import { authClient } from '../../lib/auth-client';
import { CheckRow } from '../board/toolbar/parts';
import { authFailure, CodeInput } from '../account/TwoFactor';
import { AuthShell } from './AuthShell';

/**
 * The sign-in's second step (M8 ד12): after the password, a magic link, Google or a recovery link, a person with 2FA
 * enters the 6-digit code from their app — or one of their backup codes — and may trust this device for 30 days.
 * The pending sign-in lives 10 minutes in an http-only cookie; when it is gone, back to the first step.
 */
export const TwoFactorChallenge = ({ onDone, onRestart }: { onDone: () => Promise<void>; onRestart: () => void }) => {
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code) return;
    setBusy(true);
    setError(null);
    const { error: err } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: trust })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: trust });
    if (err) {
      setBusy(false);
      // The pending sign-in expired (or was used up by too many tries): start over.
      if (err.code === 'INVALID_TWO_FACTOR_COOKIE' || err.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE')
        return setError(t('sec2.challenge.expired'));
      return setError(authFailure(err));
    }
    await onDone();
  };

  return (
    <AuthShell
      title={t('sec2.challenge.title')}
      subtitle={backup ? t('sec2.challenge.backupHint') : t('sec2.challenge.hint')}
      footer={t('auth.noAccess')}
    >
      <form
        className="flex flex-col gap-[1.125rem]"
        onSubmit={(e) => void submit(e)}
        noValidate
        data-testid="two-factor-challenge"
        data-mode={backup ? 'backup' : 'totp'}
      >
        <Field label={backup ? t('sec2.backup.label') : t('sec2.code.label')}>
          <CodeInput
            value={code}
            onChange={setCode}
            backup={backup}
            testId={backup ? 'two-factor-challenge-backup' : 'two-factor-challenge-code'}
          />
        </Field>
        <CheckRow checked={trust} onToggle={() => setTrust((v) => !v)} className="px-0">
          <span data-testid="two-factor-trust">{t('sec2.challenge.trust')}</span>
        </CheckRow>
        <Button
          type="submit"
          variant="accent"
          size="lg"
          className="w-full"
          busy={busy}
          disabled={backup ? code.length < 6 : code.length !== 6}
          data-testid="two-factor-challenge-submit"
        >
          {t('sec2.challenge.submit')}
        </Button>
      </form>
      {error ? (
        <Notice tone="error">
          <span data-testid="two-factor-challenge-error">{error}</span>
        </Notice>
      ) : null}
      <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold text-heading">
        <button
          type="button"
          className="hover:underline"
          onClick={() => {
            setBackup((v) => !v);
            setCode('');
            setError(null);
          }}
          data-testid="two-factor-use-backup"
        >
          {backup ? t('sec2.challenge.useApp') : t('sec2.challenge.useBackup')}
        </button>
        <button type="button" className="hover:underline" onClick={onRestart} data-testid="two-factor-restart">
          {t('sec2.challenge.restart')}
        </button>
      </div>
    </AuthShell>
  );
};
