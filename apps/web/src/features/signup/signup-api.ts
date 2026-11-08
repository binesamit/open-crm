// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import { formatCurrency, he, type MessageKey, type PublicPlan, type SignupConfig, t } from '@bines/shared';
import { api, errorMessage } from '../../lib/api';
import { captchaRefusal } from '../captcha/auth-captcha';

/**
 * Self sign-up (D32) in the web app: the public config (open? plans, methods, Turnstile key, consent), and the
 * words for its refusals. Everything comes from the API — the owner's settings, plans and documents.
 */

export const signupConfigKey = ['public', 'signup', 'config'] as const;

export const fetchSignupConfig = () => api().get<SignupConfig>('/public/signup/config');

/** GET /public/signup/config — always answers; `open: false` = closed (the login page's link, the closed screen). */
export const useSignupConfig = () =>
  useQuery({ queryKey: signupConfigKey, queryFn: fetchSignupConfig, staleTime: 60_000, retry: false });

/** The plan a new account starts on: the chosen one, else the default, else the first offered. */
export const initialPlanId = (c: SignupConfig, wanted?: string) =>
  (wanted && c.plans.some((p) => p.id === wanted)
    ? wanted
    : c.default_plan_id && c.plans.some((p) => p.id === c.default_plan_id)
      ? c.default_plan_id
      : c.plans[0]?.id) ?? '';

/** The trial days a plan starts with (its own, else the sign-up setting). */
export const trialDaysOf = (c: SignupConfig, plan: PublicPlan | undefined) => plan?.trial_days || c.trial_days;

/** "₪49 לחודש אחרי הניסיון" / "₪49 לחודש" / "חינם" — the plan card's line. */
export const planPriceLine = (plan: PublicPlan, trialDays: number) => {
  if (!plan.price_monthly) return t('signup.plan.free');
  const price = formatCurrency(plan.price_monthly, plan.currency);
  const key: MessageKey =
    plan.pricing === 'per_seat'
      ? trialDays
        ? 'signup.plan.perSeatAfterTrial'
        : 'signup.plan.perSeat'
      : trialDays
        ? 'signup.plan.afterTrial'
        : 'signup.plan.monthly';
  return t(key, { price });
};

/** The browser's time zone (the new account's), when it has one. */
export const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

/** The UI language for the request (the emails are written in it). */
export const pageLocale = (): 'he' | 'en' => (document.documentElement.lang === 'en' ? 'en' : 'he');

/** A sign-up refusal in words: the address rule broken, Turnstile, limits, closed — else the usual error text. */
export const signupErrorMessage = (err: unknown): string => {
  if (err instanceof ApiError) {
    const code = err.body.code;
    const captcha = captchaRefusal(code);
    if (captcha) return captcha;
    if (code === 'signup_email_not_allowed') {
      const reason = (err.body.details as { reason?: string } | undefined)?.reason;
      const key = `error.signup_email_not_allowed.${reason}` as MessageKey;
      return reason && key in he ? t(key) : t('error.signup_email_not_allowed');
    }
    if (err.status === 429 && code !== 'signup_daily_cap') return t('auth.rateLimited');
    if (err.status === 404) return t('signup.error.closed');
    if (code === 'invalid_value' && err.body.message === 'plan_unavailable') return t('signup.error.plan');
  }
  return errorMessage(err);
};
