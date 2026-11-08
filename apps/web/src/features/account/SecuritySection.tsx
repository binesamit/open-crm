// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MAX_LENGTH, passwordLengthProblem, t, type MySecurity } from '@bines/shared';
import { Button, Field, Input, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { reasonMessage } from './CopyLink';

const securityKey = ['me', 'security'] as const;

/** "At least N characters" — N is a setting (the account's, else the platform's), from the server. */
export const passwordMinHint = (minLength: number) => t('password.minHint', { n: minLength });

/** The password rule: the configured minimum (`minLength`, from the server) up to 128 characters. */
export const passwordProblem = (password: string, confirm: string, minLength: number): string | null => {
  const length = passwordLengthProblem(password, minLength);
  return length === 'too_short'
    ? passwordMinHint(minLength)
    : length === 'too_long'
      ? t('password.tooLong', { n: PASSWORD_MAX_LENGTH })
      : password !== confirm
        ? t('password.mismatch')
        : null;
};

/** Better Auth refused a password shorter than the minimum (auth.ts passwordGuard). */
export const isTooShort = (error: { code?: string } | null | undefined) => error?.code === 'PASSWORD_TOO_SHORT';

/** New password + confirmation, with the rule shown under the first field. */
export const NewPasswordFields = ({
  password,
  confirm,
  onPassword,
  onConfirm,
  testId,
  minLength,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  testId: string;
  minLength: number;
}) => (
  <>
    <Field label={t('password.new')} hint={passwordMinHint(minLength)}>
      <Input
        type="password"
        dir="ltr"
        autoComplete="new-password"
        className="text-end"
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        data-testid={`${testId}-new`}
      />
    </Field>
    <Field label={t('password.confirm')}>
      <Input
        type="password"
        dir="ltr"
        autoComplete="new-password"
        className="text-end"
        value={confirm}
        onChange={(e) => onConfirm(e.target.value)}
        data-testid={`${testId}-confirm`}
      />
    </Field>
  </>
);

/**
 * Profile → "כניסה ואבטחה" (fix8, product owner: "אי אפשר ליצור סיסמה כאן עדיין"): someone who signs in by email link or
 * Google sets a password, so a missing email never locks them out; someone with one changes it (the current one
 * is required, and every other session is signed out).
 */
export const SecuritySection = () => {
  const qc = useQueryClient();
  const security = useQuery({ queryKey: securityKey, queryFn: () => api().get<MySecurity>('/me/security') });
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = () => {
    setCurrent('');
    setPassword('');
    setConfirm('');
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!security.data?.has_password) {
        await api().post('/me/password', { new_password: password });
        return t('password.set.done');
      }
      const { error } = await authClient.changePassword({
        currentPassword: current,
        newPassword: password,
        revokeOtherSessions: true,
      });
      if (error)
        throw new Error(
          isTooShort(error)
            ? passwordMinHint(security.data?.password_min_length ?? password.length + 1)
            : error.status === 400
              ? t('password.wrongCurrent')
              : t('error.generic'),
        );
      return t('password.change.done');
    },
    onSuccess: async (message) => {
      reset();
      setDone(message);
      await qc.invalidateQueries({ queryKey: securityKey });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    const p = passwordProblem(password, confirm, security.data?.password_min_length ?? 0);
    setProblem(p);
    if (!p) save.mutate();
  };

  if (security.isPending) return <SkeletonRows rows={3} label={t('app.loading')} />;
  if (security.isError) return <Notice tone="error">{reasonMessage(security.error)}</Notice>;
  const has = security.data.has_password;

  return (
    <section className="max-w-[480px] space-y-4" data-testid="profile-security" data-has-password={has}>
      <div className="space-y-1">
        <h2 className="font-display text-base leading-snug font-bold text-heading">
          {t(has ? 'password.change.title' : 'password.set.title')}
        </h2>
        <p className="text-sm text-muted">{t(has ? 'password.change.subtitle' : 'password.set.subtitle')}</p>
      </div>
      <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
        {has ? (
          <Field label={t('password.current')}>
            <Input
              type="password"
              dir="ltr"
              autoComplete="current-password"
              className="text-end"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              data-testid="security-current"
            />
          </Field>
        ) : null}
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
          testId="security"
          minLength={security.data.password_min_length}
        />
        <div>
          <Button type="submit" busy={save.isPending} disabled={has && !current} data-testid="security-save">
            {t(has ? 'password.change.save' : 'password.set.save')}
          </Button>
        </div>
      </form>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {save.isError ? (
        <Notice tone="error">
          {save.error instanceof Error && !('body' in save.error) ? save.error.message : errorMessage(save.error)}
        </Notice>
      ) : null}
      {done ? (
        <Notice tone="success">
          <span data-testid="security-done">{done}</span>
        </Notice>
      ) : null}
      <div className="space-y-1 border-t border-line-soft pt-3 text-xs text-muted">
        {security.data.providers.includes('google') ? <p>{t('password.google')}</p> : null}
        <p>{t('password.backup')}</p>
      </div>
    </section>
  );
};
