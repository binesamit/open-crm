// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t, type ErasureRequestResult, type MyErasureRequest } from '@bines/shared';
import { Button, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { downloadFrom } from '../../lib/download';

/**
 * Profile → Security → "My data" (privacy — the right of access / portability): one button that
 * downloads everything the platform holds about me as a JSON file (`GET /me/export`).
 */
export const MyDataSection = ({ accountId }: { accountId: string }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadFrom(accountId, '/me/export', `my-data-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      role="group"
      aria-label={t('privacy.myData.title')}
      data-testid="profile-my-data"
      className="max-w-[480px] space-y-2"
    >
      <h2 className="font-display text-base leading-snug font-bold text-heading">{t('privacy.myData.title')}</h2>
      <p className="text-sm text-muted">{t('privacy.myData.hint')}</p>
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      <Button
        size="sm"
        variant="secondary"
        busy={busy}
        onClick={() => void run()}
        data-testid="profile-my-data-download"
      >
        {t('privacy.myData.download')}
      </Button>
      <ErasureRequest />
    </section>
  );
};

const erasureKey = ['me', 'erasure-request'] as const;

/**
 * "Delete my details" (privacy — the right to erasure): the person types their email to ask. In an
 * account the admins are told and carry it out; with no account the details go at once (and the person is signed out).
 */
const ErasureRequest = () => {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const state = useQuery({ queryKey: erasureKey, queryFn: () => api().get<MyErasureRequest>('/me/erasure-request') });
  const ask = useMutation({
    mutationFn: () => api().post<ErasureRequestResult>('/me/erasure-request', { confirm_email: email }),
    onSuccess: (r) => {
      if (r.status === 'erased') {
        window.location.assign('/');
        return;
      }
      setOpen(false);
      setEmail('');
      void qc.invalidateQueries({ queryKey: erasureKey });
    },
  });
  const withdraw = useMutation({
    mutationFn: () => api().delete('/me/erasure-request'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: erasureKey }),
  });
  if (!state.data) return null;
  const error = ask.error ?? withdraw.error;
  return (
    <div className="space-y-2 border-t border-line pt-3" data-testid="profile-erasure">
      <h3 className="text-sm text-heading">{t('privacy.erasure.title')}</h3>
      {state.data.pending ? (
        <>
          <Notice tone="info">{t('privacy.erasure.pending')}</Notice>
          <Button
            size="sm"
            variant="secondary"
            busy={withdraw.isPending}
            onClick={() => withdraw.mutate()}
            data-testid="profile-erasure-withdraw"
          >
            {t('privacy.erasure.withdraw')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            {t(state.data.has_accounts ? 'privacy.erasure.hint' : 'privacy.erasure.hintNoAccount')}
          </p>
          {open ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                ask.mutate();
              }}
            >
              <Field label={t('privacy.erasure.confirmLabel')}>
                <Input
                  type="email"
                  value={email}
                  autoComplete="off"
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="profile-erasure-email"
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  type="submit"
                  busy={ask.isPending}
                  disabled={!email.trim()}
                  data-testid="profile-erasure-submit"
                >
                  {t(state.data.has_accounts ? 'privacy.erasure.submit' : 'privacy.erasure.submitNow')}
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="profile-erasure-open">
              {t('privacy.erasure.open')}
            </Button>
          )}
        </>
      )}
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
    </div>
  );
};
