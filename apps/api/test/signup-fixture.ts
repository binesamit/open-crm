// SPDX-License-Identifier: AGPL-3.0-only
import { expect, vi, type MockInstance } from 'vitest';
import { turnstile } from '../src/modules/forms/forms.turnstile';
import { forgetSignupLimits } from '../src/modules/signup/signup.service';
import { WEB_ORIGIN, type TestContext } from './helpers';

/** Shared steps of the self sign-up tests (D32). Cloudflare is never called: `turnstile.verify` is mocked. */
export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
export const PASSWORD = 'correct-horse-battery';

let ipSeq = 10;
/** A fresh client address per call, so one test's attempts never count against another's. */
export const nextIp = () => `203.0.113.${ipSeq++ % 250}`;

export const mockTurnstile = (): MockInstance<typeof turnstile.verify> =>
  vi.spyOn(turnstile, 'verify').mockImplementation(async (_secret, tok) => tok === 'good');

/** A public call (no session) to /api/v1, from a given client address. */
export const pub = (t: TestContext, method: string, path: string, payload?: unknown, ip = nextIp(), cookie?: string) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

/** Turnstile keys, a public plan (no trial days of its own) and the switch on. Returns the plan's id. */
export const openSignup = async (t: TestContext, owner: string, patch: Json = {}) => {
  forgetSignupLimits();
  expect(
    (await t.api(owner).patch('/platform/captcha', { site_key: '0xSIGNUP', secret: 'signup-secret' })).status,
  ).toBe(200);
  const plan = await body(await t.api(owner).post('/platform/plans', { name: 'Starter', version: { trial_days: 0 } }));
  const res = await t.api(owner).patch('/platform/signup-settings', {
    enabled: true,
    default_plan_id: plan.id,
    ...patch,
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return plan.id as string;
};

/** The consent the sign-up screen sends: the current version of every document that asks for it. */
export const consents = async (t: TestContext) =>
  ((await body(await pub(t, 'GET', '/public/signup/config'))).legal as Json[]).map((d) => ({
    slug: d.slug,
    version: d.version,
  }));

export const startBody = async (t: TestContext, email: string, extra: Json = {}) => ({
  email,
  password: PASSWORD,
  name: 'Dana Cohen',
  org_name: 'Acme Labs',
  accept_legal: await consents(t),
  captcha_token: 'good',
  locale: 'en',
  ...extra,
});

/** The token of the latest verification email to `email`. */
export const verifyTokenFor = (t: TestContext, email: string) => {
  const mail = t.lastMailTo(email);
  const m = /signup\/verify#token=([\w-]+)/.exec(mail.text);
  expect(m, mail.text).toBeTruthy();
  return m![1]!;
};

export const errorOf = async (res: Response) => (await body(res)).error as Json;
