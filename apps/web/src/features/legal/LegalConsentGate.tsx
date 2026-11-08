// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t, type LegalLocale, type MyLegal } from '@bines/shared';
import { Button, Notice } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { authClient } from '../../lib/auth-client';
import { AuthShell } from '../auth/AuthShell';
import { legalHref } from './legal-links';

export const myLegalKey = ['legal', 'mine'] as const;

/**
 * when the owner publishes a new version of a document that requires consent (terms, privacy …), each
 * person accepts it before going on — a link to every changed document, one checkbox, "continue". Signing out is the
 * other way. Nothing pending (or the check failed) = the app as usual.
 */
export const LegalConsentGate = ({ children }: { children: ReactNode }) => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const mine = useQuery({
    queryKey: myLegalKey,
    queryFn: () => api().get<MyLegal>('/me/legal'),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const [agreed, setAgreed] = useState(false);
  const accept = useMutation({
    mutationFn: (pending: MyLegal['pending']) =>
      api().post<MyLegal>('/me/legal/accept', { accepted: pending.map((d) => ({ slug: d.slug, version: d.version })) }),
    onSuccess: (res) => qc.setQueryData(myLegalKey, res),
  });
  const pending = mine.data?.pending ?? [];
  if (!pending.length) return <>{children}</>;
  const lang: LegalLocale = document.documentElement.lang === 'en' ? 'en' : 'he';
  const signOut = async () => {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: '/login' });
  };
  return (
    <AuthShell title={t('legal.gate.title')} subtitle={t('legal.gate.subtitle')}>
      <div className="flex flex-col gap-4" data-testid="legal-gate">
        <ul className="space-y-1.5 text-sm">
          {pending.map((d) => (
            <li key={d.slug}>
              <a
                href={legalHref(d.slug)}
                target="_blank"
                rel="noopener"
                className="font-bold text-primary underline underline-offset-2"
                data-testid={`legal-gate-doc-${d.slug}`}
              >
                {d.title[lang]}
              </a>
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-2 text-sm text-fg-2">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            data-testid="legal-gate-checkbox"
          />
          <span>{t('legal.gate.agree')}</span>
        </label>
        {accept.isError ? <Notice tone="error">{errorMessage(accept.error)}</Notice> : null}
        <Button
          variant="accent"
          size="lg"
          className="w-full"
          disabled={!agreed}
          busy={accept.isPending}
          onClick={() => accept.mutate(pending)}
          data-testid="legal-gate-continue"
        >
          {t('legal.gate.continue')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void signOut()} data-testid="legal-gate-sign-out">
          {t('auth.signOut')}
        </Button>
      </div>
    </AuthShell>
  );
};
