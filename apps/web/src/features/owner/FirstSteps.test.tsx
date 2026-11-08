// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type FirstSteps } from '@bines/shared';

/**
 * Owner console, self-hosted sign-up (SIGNUP plan ה6): the "first steps" card (decision 12) — ✓ per step, a link to
 * where each is done, gone when all are done or once closed — and, on the sign-up card, the links from each missing
 * requirement.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { method: string; path: string };
const calls: Call[] = [];
let steps: FirstSteps;
const jump = vi.fn();

vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      if (path === '/platform/first-steps') return steps;
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string) => {
      calls.push({ method: 'POST', path });
      if (path === '/platform/first-steps/dismiss') return { ...steps, dismissed: true };
      throw new Error(`unexpected POST ${path}`);
    },
  }),
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('./console-links', () => ({ useConsoleJump: () => jump }));
vi.mock('../../lib/branding', () => ({ useAuthConfig: () => ({ data: {} }) }));
vi.mock('./StarterKits', () => ({ useKits: () => ({ data: { data: [] } }), kitName: () => '' }));
vi.mock('./Plans', () => ({ usePlans: () => ({ data: { data: [] } }) }));

const { FirstStepsCard } = await import('./FirstSteps');
const { SignupReadiness } = await import('./SignupSettings');

const stepsOf = (
  done: Partial<Record<FirstSteps['steps'][number]['key'], boolean>>,
  dismissed = false,
): FirstSteps => ({
  steps: (['email', 'legal', 'plan', 'signup'] as const).map((key) => ({ key, done: !!done[key] })),
  dismissed,
});

let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const render = async (el: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(createElement(QueryClientProvider, { client: qc }, el)));
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => $(id)!.click());
  await flush();
};

beforeEach(() => {
  calls.length = 0;
  jump.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the first steps card', () => {
  it('a ✓ per done step, a link on each open one, the progress', async () => {
    steps = stepsOf({ email: true, legal: true });
    await render(createElement(FirstStepsCard));
    expect($('first-steps')).not.toBeNull();
    expect($('first-steps-progress')!.textContent).toBe(t('firstSteps.progress', { done: 2, total: 4 }));
    expect($('first-step-email')!.dataset.done).toBe('true');
    expect($('first-step-go-email')).toBeNull();
    // No "register the installation" step: nothing is locked, registering is never required.
    expect($('first-step-registration')).toBeNull();
    expect($('first-step-plan')!.dataset.done).toBe('false');
    expect($('first-step-go-plan')!.textContent).toBe(t('firstSteps.go'));
    await click('first-step-go-plan');
    expect(jump).toHaveBeenLastCalledWith('plans');
    await click('first-step-go-signup');
    expect(jump).toHaveBeenLastCalledWith('signup');
  });

  it('closing it is stored on the server and the card goes', async () => {
    steps = stepsOf({});
    await render(createElement(FirstStepsCard));
    await click('first-steps-dismiss');
    expect(calls).toContainEqual({ method: 'POST', path: '/platform/first-steps/dismiss' });
    expect($('first-steps')).toBeNull();
  });

  it('hidden when every step is done, or once dismissed', async () => {
    steps = stepsOf({ email: true, legal: true, plan: true, signup: true });
    await render(createElement(FirstStepsCard));
    expect($('first-steps')).toBeNull();
    act(() => root!.unmount());
    root = createRoot(host);
    steps = stepsOf({}, true);
    await render(createElement(FirstStepsCard));
    expect($('first-steps')).toBeNull();
  });
});

describe('the sign-up card: the readiness list', () => {
  it('each missing requirement links to where it is fixed', async () => {
    await render(
      createElement(SignupReadiness, {
        missing: ['email', 'captcha', 'default_plan', 'methods', 'legal', 'mode'],
        captcha: true,
        hasPlans: false,
      }),
    );
    const expected = {
      email: 'email',
      captcha: 'captcha',
      default_plan: 'plans',
      methods: 'signup-methods',
      legal: 'legal',
      mode: 'signup-methods',
    };
    for (const [k, target] of Object.entries(expected)) {
      await click(`signup-fix-${k}`);
      expect(jump).toHaveBeenLastCalledWith(target);
    }
    expect($('signup-fix-email')!.textContent).toBe(t('signup.ready.fix'));
    // Registering, or a key, is never among the requirements.
    expect($('signup-ready-registration')).toBeNull();
    expect($('signup-ready-enterprise')).toBeNull();
  });

  it('nothing to fix on a ready item; with a public plan, the default plan is picked on the card', async () => {
    await render(createElement(SignupReadiness, { missing: ['default_plan'], captcha: false }));
    expect($('signup-fix-email')).toBeNull();
    await click('signup-fix-default_plan');
    expect(jump).toHaveBeenLastCalledWith('signup-plan');
  });
});
