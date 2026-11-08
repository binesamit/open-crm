// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  billingSettingsSchema,
  DISPOSABLE_EMAIL_DOMAINS,
  domainMatches,
  emailDomain,
  signupEmailProblem,
  signupSettingsSchema,
  signupStartSchema,
  slugFromName,
  subscriptionStateAt,
  updateSignupSettingsSchema,
} from '../src';

/** Self sign-up (D32): the settings' defaults, the address rules, the slug, and the trial's own end rule. */
describe('sign-up settings', () => {
  it('defaults: switched off, the approved recommendations', () => {
    expect(signupSettingsSchema.parse({})).toMatchObject({
      enabled: false,
      mode: 'open',
      methods: ['password', 'google', 'microsoft'],
      trial_days: 14,
      trial_end_status: 'read_only',
      default_plan_id: null,
      choose_plan: true,
      starter_kit: 'empty',
      approval: false,
      require_captcha: true,
      block_disposable: true,
      require_work_email: false,
      rate_ip_hour: 5,
      rate_email_day: 3,
      daily_cap: 50,
      notify_owner: true,
    });
  });

  it('domains are normalised and validated; unknown fields are dropped', () => {
    expect(updateSignupSettingsSchema.parse({ domain_block: [' Spam.Example '] }).domain_block).toEqual([
      'spam.example',
    ]);
    expect(updateSignupSettingsSchema.safeParse({ domain_allow: ['not a domain'] }).success).toBe(false);
    expect(updateSignupSettingsSchema.safeParse({ daily_cap: 0 }).success).toBe(false);
  });

  it('a start needs a real address and a password within the floor and the ceiling', () => {
    const base = { name: 'A', org_name: 'B', email: 'a@b.io', password: 'long-enough' };
    expect(signupStartSchema.safeParse(base).success).toBe(true);
    expect(signupStartSchema.safeParse({ ...base, email: 'nope' }).success).toBe(false);
    expect(signupStartSchema.safeParse({ ...base, password: 'abc' }).success).toBe(false);
    // ה7: no organisation is fine at the schema (an address may join its organisation's account); the server decides.
    expect(signupStartSchema.safeParse({ ...base, org_name: '   ' }).success).toBe(true);
  });
});

describe('address rules', () => {
  const rules = signupSettingsSchema.parse({});

  it('domains match themselves and their subdomains, case-insensitively', () => {
    expect(emailDomain('A@Sub.Example.COM')).toBe('sub.example.com');
    expect(domainMatches('sub.example.com', ['example.com'])).toBe(true);
    expect(domainMatches('notexample.com', ['example.com'])).toBe(false);
    expect(DISPOSABLE_EMAIL_DOMAINS).toContain('mailinator.com');
  });

  it('block → allow → throw-away → work email, in that order', () => {
    expect(signupEmailProblem('a@acme.io', rules)).toBeNull();
    expect(signupEmailProblem('a@mailinator.com', rules)).toBe('disposable');
    expect(signupEmailProblem('a@mailinator.com', { ...rules, block_disposable: false })).toBeNull();
    expect(signupEmailProblem('a@my.burner', { ...rules, disposable_domains: ['my.burner'] })).toBe('disposable');
    expect(signupEmailProblem('a@acme.io', { ...rules, domain_block: ['acme.io'] })).toBe('domain_blocked');
    expect(signupEmailProblem('a@other.io', { ...rules, domain_allow: ['acme.io'] })).toBe('domain_not_allowed');
    expect(signupEmailProblem('a@gmail.com', rules)).toBeNull();
    expect(signupEmailProblem('a@gmail.com', { ...rules, require_work_email: true })).toBe('work_email_required');
  });

  it('a slug from an organisation name (Latin letters and digits; none = empty)', () => {
    expect(slugFromName('Acme Labs, Inc.')).toBe('acme-labs-inc');
    expect(slugFromName('Café Ünïcode')).toBe('cafe-unicode');
    expect(slugFromName('כפר הנוער')).toBe('');
    expect(slugFromName('x'.repeat(80)).length).toBe(40);
  });
});

describe('a trial with its own end rule (self sign-up)', () => {
  const settings = billingSettingsSchema.parse({});
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-01-15T00:00:00Z');
  const day = 86_400_000;
  const clock = (trialEndStatus: string | null) => ({
    status: 'trial' as const,
    statusSince: start,
    trialEndsAt: end,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndStatus,
  });
  const at = (ms: number, own: string | null) =>
    subscriptionStateAt(clock(own), settings, new Date(end.getTime() + ms));

  it('read-only at once, suspended `read_only_days` later, never closed', () => {
    expect(at(-1000, 'read_only')).toEqual({ status: 'trial', since: start, read_only_at: end });
    expect(at(1000, 'read_only')).toMatchObject({ status: 'read_only', since: end, read_only_at: end });
    expect(at(30 * day - 1000, 'read_only').status).toBe('read_only');
    expect(at(30 * day, 'read_only')).toMatchObject({ status: 'suspended', read_only_at: end });
    expect(at(10_000 * day, 'read_only').status).toBe('suspended');
    expect(
      subscriptionStateAt(
        clock('read_only'),
        { ...settings, read_only_days: null },
        new Date(end.getTime() + 999 * day),
      ).status,
    ).toBe('read_only');
  });

  it('no own rule: exactly the billing settings, as before (past due, then read-only after the grace)', () => {
    expect(at(1000, null)).toMatchObject({ status: 'past_due' });
    expect(at(8 * day, null)).toMatchObject({ status: 'read_only' });
    // A value that is not a status is ignored.
    expect(at(1000, 'nonsense')).toMatchObject({ status: 'past_due' });
    const old = { ...clock(null) } as Record<string, unknown>;
    delete old.trialEndStatus;
    expect(subscriptionStateAt(old as never, settings, new Date(end.getTime() + 1000))).toMatchObject({
      status: 'past_due',
    });
  });
});
