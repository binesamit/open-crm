// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ApiError } from '@bines/sdk';
import {
  type SignupComplete,
  type SignupConfig,
  type SignupDetail,
  type SignupProviderMethod,
  type SignupResult,
  t,
} from '@bines/shared';
import { Avatar, Button, Field, Input, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, fetchMe, queryKeys } from '../../lib/api';
import { AUTH_INPUT, AuthShell } from '../auth/AuthShell';
import { LegalConsentCheckbox, MarketingOptInCheckbox, useConsent } from '../legal/legal-links';
import { initialPlanId, signupErrorMessage, useSignupConfig } from './signup-api';
import { DONE_MS, STEP_MS } from './SignupVerifyPage';
import { SignupClosed, SignupPending, SignupPreparing, SignupProblem } from './SignupStates';

/** The first try (no details) runs once per page load, however often React mounts the page. */
let firstTry: Promise<SignupResult> | null = null;
const complete = (body: SignupComplete) => api().post<SignupResult>('/public/signup/complete', body);
/** Tests: forget the page load's first try. */
export const resetCompleteTry = () => {
  firstTry = null;
};

type State =
  | { kind: 'working' }
  | { kind: 'details'; missing: SignupDetail[] }
  | { kind: 'done'; result: SignupResult }
  | { kind: 'pending'; result: SignupResult }
  | { kind: 'registered' }
  | { kind: 'closed' }
  | { kind: 'problem'; message: string };

const stateOfError = (err: unknown): State => {
  if (err instanceof ApiError) {
    const code = err.body.code;
    if (code === 'signup_details_required') {
      const missing = ((err.body.details ?? {}) as { missing?: SignupDetail[] }).missing ?? [];
      return { kind: 'details', missing };
    }
    if (code === 'signup_already_registered') return { kind: 'registered' };
    if (code === 'not_found') return { kind: 'closed' };
    if (code === 'verification_invalid' || err.status === 401)
      return { kind: 'problem', message: t('signup.problem.expired') };
  }
  return { kind: 'problem', message: signupErrorMessage(err) };
};

/**
 * /signup/complete (canvas screen 6): back from Google / Microsoft, signed in. The account is made at once when the
 * form already held everything; otherwise "two more details" — the organisation, the plan, the consent — then the
 * same "preparing" steps, or "being reviewed" with manual approval on. An address that already had an account is
 * told so (it is signed in to it).
 */
export const SignupCompletePage = ({ via }: { via?: SignupProviderMethod }) => {
  const config = useSignupConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'working' });
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let live = true;
    firstTry ??= complete({});
    firstTry.then(
      (result) =>
        live && setState(result.status === 'pending_approval' ? { kind: 'pending', result } : { kind: 'done', result }),
      (err) => live && setState(stateOfError(err)),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (state.kind !== 'working') return;
    const id = window.setInterval(() => setProgress((p) => Math.min(p + 1, 2)), STEP_MS);
    return () => window.clearInterval(id);
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== 'done' || !state.result.account) return;
    const slug = state.result.account.slug;
    const id = window.setTimeout(() => {
      void (async () => {
        await qc.invalidateQueries({ queryKey: queryKeys.me });
        await qc.invalidateQueries({ queryKey: queryKeys.myAccounts });
        await navigate({ to: '/a/$accountSlug', params: { accountSlug: slug } });
      })();
    }, DONE_MS);
    return () => window.clearTimeout(id);
  }, [state, qc, navigate]);

  const send = async (body: SignupComplete) => {
    setProgress(0);
    try {
      const result = await complete(body);
      setState(result.status === 'pending_approval' ? { kind: 'pending', result } : { kind: 'done', result });
    } catch (err) {
      const next = stateOfError(err);
      // A refusal of what was just filled in stays on the form, with its reason.
      if (next.kind === 'problem' && state.kind === 'details') throw err;
      setState(next);
    }
  };

  if (state.kind === 'closed' || (config.data && !config.data.open)) return <SignupClosed />;
  if (state.kind === 'problem') return <SignupProblem message={state.message} testId="signup-complete-problem" />;
  if (state.kind === 'pending') return <SignupPending request={state.result.request} />;
  if (state.kind === 'registered')
    return (
      <AuthShell title={t('signup.registered.title')} centered testId="signup-registered">
        <p className="text-[0.875rem] leading-relaxed text-fg-2">{t('error.signup_already_registered')}</p>
        <Link
          to="/"
          className="flex h-11 w-full items-center justify-center rounded-[var(--radius)] bg-accent text-sm text-on-accent hover:brightness-105"
        >
          {t('signup.registered.open')}
        </Link>
      </AuthShell>
    );
  if (state.kind === 'details') {
    if (!config.data)
      return (
        <AuthShell title="">
          <SkeletonRows rows={3} label={t('app.loading')} />
        </AuthShell>
      );
    return <CompleteDetails config={config.data} missing={state.missing} via={via} onSend={send} />;
  }
  const request = state.kind === 'done' ? state.result.request : undefined;
  return (
    <SignupPreparing
      progress={state.kind === 'done' ? 99 : progress}
      orgName={request?.org_name}
      trialDays={request?.trial_days ?? config.data?.trial_days}
      sampleBoards={config.data?.sample_boards}
    />
  );
};

/** Screen 6: who signed in (and with what), then only what is still missing. */
const CompleteDetails = ({
  config,
  missing,
  via,
  onSend,
}: {
  config: SignupConfig;
  missing: SignupDetail[];
  via?: SignupProviderMethod;
  onSend: (body: SignupComplete) => Promise<void>;
}) => {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe }).data;
  const [org, setOrg] = useState('');
  const [planId, setPlanId] = useState(() => initialPlanId(config));
  const [agreed, setAgreed] = useState(false);
  const consent = useConsent(agreed);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const askOrg = missing.includes('org_name');
  const askLegal = missing.includes('legal');
  const askPlan = config.plans.length > 1;
  const asked = [askOrg, askPlan, askLegal].filter(Boolean).length;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSend({
        ...(askOrg ? { org_name: org.trim() } : {}),
        ...(askPlan && planId ? { plan_id: planId } : {}),
        ...(consent.accepted.length ? { accept_legal: consent.accepted } : {}),
        ...(marketing ? { marketing_opt_in: true } : {}),
      });
    } catch (err) {
      setError(signupErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={asked > 1 ? t('signup.complete.titleMany') : t('signup.complete.titleOne')}
      testId="signup-complete"
    >
      {me ? (
        <div
          className="-order-1 flex items-center gap-2.5 rounded-[12px] bg-surface-3 px-3 py-2.5"
          data-testid="signup-complete-who"
        >
          <Avatar name={me.user.name || me.user.email} url={me.user.avatar_url} size={32} />
          <span className="flex min-w-0 flex-col text-[0.8125rem]">
            <span className="truncate" dir="auto">
              {me.user.name}
            </span>
            <span className="truncate text-xs text-muted [unicode-bidi:isolate]" dir="ltr">
              {me.user.email}
            </span>
          </span>
          {via ? (
            <span className="ms-auto shrink-0 text-[0.6875rem] text-muted">
              {t(via === 'google' ? 'signup.complete.viaGoogle' : 'signup.complete.viaMicrosoft')}
            </span>
          ) : null}
        </div>
      ) : null}
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        {askOrg ? (
          <Field label={t('signup.org')}>
            <Input
              required
              autoComplete="organization"
              className={AUTH_INPUT}
              placeholder={t('signup.org.placeholder')}
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              data-testid="signup-complete-org"
            />
          </Field>
        ) : null}
        {askPlan ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-fg-2">{t('signup.plan')}</span>
            <Segmented
              label={t('signup.plan')}
              value={planId}
              onChange={setPlanId}
              className="flex w-full [&>button]:flex-1"
              options={config.plans.map((p) => ({
                value: p.id,
                label: p.name,
                testId: `signup-complete-plan-${p.id}`,
              }))}
            />
          </div>
        ) : null}
        {askLegal ? <LegalConsentCheckbox checked={agreed} onChange={setAgreed} /> : null}
        {askLegal ? <MarketingOptInCheckbox checked={marketing} onChange={setMarketing} /> : null}
        {error ? (
          <Notice tone="error">
            <span data-testid="signup-complete-error">{error}</span>
          </Notice>
        ) : null}
        <Button
          type="submit"
          variant="accent"
          size="lg"
          className="w-full"
          busy={busy}
          disabled={(askOrg && !org.trim()) || (askLegal && !consent.ok)}
          data-testid="signup-complete-submit"
        >
          {t('signup.submit')}
        </Button>
      </form>
    </AuthShell>
  );
};
