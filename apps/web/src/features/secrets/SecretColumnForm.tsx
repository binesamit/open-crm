// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { secretSettingsOf, type SecretStatus, t } from '@bines/shared';
import { Button, Notice } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { CodeInput } from '../account/TwoFactor';
import type { BoardDetail, Column } from '../board/board-api';
import { BoardAccountContext } from '../board/board-context';
import { fieldsOf, fieldsValid, SecretSettingsFields, settingsOfFields } from './SecretSettingsFields';

/**
 * Settings of a secret column — all in the UI, nothing per client: who may reveal (everyone who
 * sees the column and has 2FA, or only some people), how long a value shows, how long a fresh code counts, whether
 * copying is allowed, whether replacing / clearing a value asks for the same code, and when the admins are alerted.
 * Says plainly what the column is (and is not) for.
 *
 * these settings guard the column's secrets, so the server takes a fresh two-factor code for any change
 * to them (renaming needs none). Before saving a change the form checks the person's step-up: no 2FA → a notice with
 * the way to turn it on; no fresh code → the code field here, then the settings are saved.
 */
/** Same settings after every default is filled in (the description alone, or nothing, changed). */
const sameSettings = (a: unknown, b: unknown) => {
  const x = secretSettingsOf(a) as Record<string, unknown>;
  const y = secretSettingsOf(b) as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every(
    (key) => JSON.stringify(x[key]) === JSON.stringify(y[key]),
  );
};

type Props = {
  accountId: string;
  board: BoardDetail;
  column: Column;
  busy: boolean;
  onSave: (settings: Record<string, unknown>) => Promise<unknown>;
  shell: (body: ReactNode, save: ReactNode) => ReactNode;
};

export const SecretColumnForm = ({ accountId, board, column, busy, onSave, shell }: Props) => {
  const initial = secretSettingsOf(column.settings);
  const [fields, setFields] = useState(() => fieldsOf(initial));
  const { slug } = useContext(BoardAccountContext);
  /** The step-up before a change: null, the code field, or "turn on 2FA first". */
  const [stepUp, setStepUp] = useState<null | 'code' | 'no2fa'>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const valid = fieldsValid(fields);
  // a column that holds values keeps its kind (the board's loaded items tell; the server checks too).
  const qc = useQueryClient();
  const holdsValues = !!qc
    .getQueryData<{ data: { cells?: Record<string, unknown> }[] }>(['account', accountId, 'board', board.id, 'items'])
    ?.data?.some((i) => !!i.cells?.[column.id]);

  const next = () => ({ ...(column.settings ?? {}), ...settingsOfFields(fields) });

  /** Saves at once when nothing guarded changed or a fresh code still counts; else asks for the code first. */
  const save = async () => {
    const settings = next();
    if (sameSettings(column.settings, settings)) return void onSave(settings);
    setChecking(true);
    setCodeError(null);
    try {
      const status = await api(accountId).get<SecretStatus>('/secrets/status');
      if (!status.two_factor_enabled) return setStepUp('no2fa');
      const at = status.verified_at ? new Date(status.verified_at).getTime() : 0;
      // A little margin, so the code does not run out on the way to the server.
      if (at && Date.now() - at < initial.verify_minutes * 60_000 - 15_000) return void onSave(settings);
      setStepUp('code');
    } catch (err) {
      setCodeError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const verifyAndSave = async () => {
    if (code.length < 6) return;
    setChecking(true);
    setCodeError(null);
    try {
      await api(accountId).post('/secrets/verify', { code });
    } catch (err) {
      setCodeError(errorMessage(err));
      setChecking(false);
      return;
    }
    setChecking(false);
    setCode('');
    setStepUp(null);
    void onSave(next());
  };

  return shell(
    <div className="flex flex-col gap-3.5" data-testid="secret-settings">
      <Notice tone="warn">{t('secret.settings.about')}</Notice>
      <SecretSettingsFields
        accountId={accountId}
        value={fields}
        onChange={setFields}
        kind="column"
        kindLocked={holdsValues}
      />
      {stepUp === 'code' ? (
        <form
          className="flex flex-col gap-2 rounded-[10px] border border-line p-3"
          data-testid="secret-settings-code"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyAndSave();
          }}
        >
          <p className="text-sm font-semibold">{t('secret.settings.codeTitle')}</p>
          <p className="text-xs text-muted">{t('secret.settings.codeHint')}</p>
          <CodeInput value={code} onChange={setCode} testId="secret-settings-code-input" />
        </form>
      ) : stepUp === 'no2fa' ? (
        <Notice tone="warn">
          <span data-testid="secret-settings-no2fa">{t('secret.settings.no2fa')}</span>{' '}
          <Link
            to="/a/$accountSlug/profile"
            params={{ accountSlug: slug }}
            search={{ tab: 'security' }}
            className="font-semibold text-primary hover:underline"
          >
            {t('secret.no2fa.link')}
          </Link>
        </Notice>
      ) : null}
      {codeError ? (
        <p role="alert" className="text-xs text-danger-fg" data-testid="secret-settings-error">
          {codeError}
        </p>
      ) : null}
    </div>,
    <Button
      busy={busy || checking}
      disabled={!valid || stepUp === 'no2fa' || (stepUp === 'code' && code.length < 6)}
      data-testid="column-settings-save"
      onClick={() => void (stepUp === 'code' ? verifyAndSave() : save())}
    >
      {stepUp === 'code' ? t('secret.code.submitChange') : t('common.save')}
    </Button>,
  );
};
