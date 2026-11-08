// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { API_LIMIT_BOUNDS, t, type ApiToken } from '@bines/shared';
import { Button, Dialog, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage, type MyAccount } from '../../lib/api';

const fmt = (n: number) => n.toLocaleString();

/** A budget typed in a field: '' = the default (null), else a whole number within the platform's bounds. */
export const parseLimit = (raw: string, kind: 'per_minute' | 'daily'): number | null | 'invalid' => {
  const v = raw.trim().replace(/[,\s]/g, '');
  if (!v) return null;
  if (!/^\d+$/.test(v)) return 'invalid';
  const n = Number(v);
  const b = API_LIMIT_BOUNDS[kind];
  return n >= b.min && n <= b.max ? n : 'invalid';
};

/**
 * One budget field (ANSWERS 6א.9): empty = the default shown as the placeholder. Plain text with a numeric
 * keyboard — no native number spinner.
 */
export const LimitField = ({
  label,
  kind,
  value,
  onChange,
  fallback,
  testId,
}: {
  label: string;
  kind: 'per_minute' | 'daily';
  value: string;
  onChange: (v: string) => void;
  /** What an empty field means (a number, or a sentence like "the account's default"). */
  fallback: number | string;
  testId: string;
}) => {
  const parsed = parseLimit(value, kind);
  const b = API_LIMIT_BOUNDS[kind];
  return (
    <Field
      label={label}
      hint={
        parsed === 'invalid'
          ? t('limits.invalid', { min: fmt(b.min), max: fmt(b.max) })
          : t('limits.emptyIsDefault', { value: typeof fallback === 'number' ? fmt(fallback) : fallback })
      }
    >
      <Input
        value={value}
        inputMode="numeric"
        dir="ltr"
        placeholder={typeof fallback === 'number' ? fmt(fallback) : ''}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={parsed === 'invalid' || undefined}
        className="text-start"
        data-testid={testId}
      />
    </Field>
  );
};

/** "600 / min · 10,000 / day" — what a token runs with now. */
export const limitsSummary = (tok: Pick<ApiToken, 'limits' | 'rate_limit_per_minute' | 'daily_quota'>) =>
  t('tokens.limits.summary', { minute: fmt(tok.limits.per_minute), day: fmt(tok.limits.daily) }) +
  (tok.rate_limit_per_minute != null || tok.daily_quota != null ? ` · ${t('tokens.limits.own')}` : '');

/**
 * The token dialog's budgets (PATCH /auth/tokens/{id}): its own per minute / per day, or the account's default.
 * Above the account's default only for admins (the server says so otherwise).
 */
export const TokenLimitsDialog = ({
  account,
  token,
  onClose,
}: {
  account: MyAccount;
  token: ApiToken;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [minute, setMinute] = useState(token.rate_limit_per_minute?.toString() ?? '');
  const [day, setDay] = useState(token.daily_quota?.toString() ?? '');
  const m = parseLimit(minute, 'per_minute');
  const d = parseLimit(day, 'daily');
  const save = useMutation({
    mutationFn: () =>
      api(account.id).patch<ApiToken>(`/auth/tokens/${token.id}`, { rate_limit_per_minute: m, daily_quota: d }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['account', account.id, 'tokens'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tokens.limits.title')}
      subtitle={token.name}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            busy={save.isPending}
            disabled={m === 'invalid' || d === 'invalid'}
            onClick={() => save.mutate()}
            data-testid="token-limits-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="token-limits-dialog">
        <p className="text-sm text-muted">{t('tokens.limits.hint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <LimitField
            label={t('limits.perMinute')}
            kind="per_minute"
            value={minute}
            onChange={setMinute}
            fallback={token.limits.default_per_minute}
            testId="token-limit-minute"
          />
          <LimitField
            label={t('limits.perDay')}
            kind="daily"
            value={day}
            onChange={setDay}
            fallback={token.limits.default_daily}
            testId="token-limit-day"
          />
        </div>
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
