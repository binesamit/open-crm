// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ApiError } from '@bines/sdk';
import { t, type SignupResult } from '@bines/shared';
import { api, queryKeys } from '../../lib/api';
import { signupErrorMessage, useSignupConfig } from './signup-api';
import { SignupClosed, SignupPending, SignupPreparing, SignupProblem } from './SignupStates';

/** The email link opens /signup/verify#token=<token> (a fragment never reaches a server log). */
const TOKEN_HASH = /^#token=([\w-]{16,200})$/;

/**
 * One request per token, however often the page mounts (React's dev double effects, a re-render): the link works
 * once, so a second POST would answer "invalid" to a person whose account was just made.
 */
const once = new Map<string, Promise<SignupResult>>();
export const verifyOnce = (token: string) => {
  let p = once.get(token);
  if (!p) {
    p = api().post<SignupResult>('/public/signup/verify', { token });
    once.set(token, p);
  }
  return p;
};

/** How fast the "preparing" steps advance while the server works (it answers in one call). */
export const STEP_MS = 650;
/** A moment on "all done" before the account opens. */
export const DONE_MS = 700;

type State =
  | { kind: 'working' }
  | { kind: 'done'; result: SignupResult }
  | { kind: 'pending'; result: SignupResult }
  | { kind: 'closed' }
  | { kind: 'invalid'; message: string };

/**
 * /signup/verify (canvas screen 3): the email link. Creates the account and signs in (the steps tick while it
 * works, then the new account opens), or — with manual approval on — "your request is being reviewed" (screen 4).
 */
export const SignupVerifyPage = () => {
  const [token] = useState(() => TOKEN_HASH.exec(window.location.hash)?.[1] ?? null);
  const config = useSignupConfig().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<State>(() =>
    token ? { kind: 'working' } : { kind: 'invalid', message: t('signup.problem.invalid') },
  );
  const [progress, setProgress] = useState(0);

  // The token leaves the address bar at once (history, screenshots).
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (!token) return;
    let live = true;
    verifyOnce(token).then(
      (result) =>
        live && setState(result.status === 'pending_approval' ? { kind: 'pending', result } : { kind: 'done', result }),
      (err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404 && err.body.code === 'not_found')
          setState({ kind: 'closed' });
        else
          setState({
            kind: 'invalid',
            message:
              err instanceof ApiError && err.body.code === 'verification_invalid'
                ? t('signup.problem.invalid')
                : signupErrorMessage(err),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  // The steps advance while the server works, and stop one short of the end until it answered.
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

  if (state.kind === 'closed') return <SignupClosed />;
  if (state.kind === 'invalid') return <SignupProblem message={state.message} testId="signup-verify-invalid" />;
  if (state.kind === 'pending') return <SignupPending request={state.result.request} />;
  const request = state.kind === 'done' ? state.result.request : undefined;
  return (
    <SignupPreparing
      progress={state.kind === 'done' ? 99 : progress}
      orgName={request?.org_name}
      trialDays={request?.trial_days ?? config?.trial_days}
      sampleBoards={config?.sample_boards}
    />
  );
};
