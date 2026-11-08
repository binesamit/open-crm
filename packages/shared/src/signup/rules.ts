// SPDX-License-Identifier: AGPL-3.0-only
import { DISPOSABLE_EMAIL_DOMAINS, FREE_EMAIL_DOMAINS } from './email-domains';

/** Why an address may not sign up (422 `signup_email_not_allowed`, `details.reason`). */
export const SIGNUP_EMAIL_PROBLEMS = [
  'domain_blocked',
  'domain_not_allowed',
  'disposable',
  'work_email_required',
] as const;
export type SignupEmailProblem = (typeof SIGNUP_EMAIL_PROBLEMS)[number];

/** The rules of the sign-up settings that judge an address. */
export type SignupEmailRules = {
  block_disposable: boolean;
  require_work_email: boolean;
  disposable_domains: readonly string[];
  domain_allow: readonly string[];
  domain_block: readonly string[];
};

/** The domain of an address, lower case (`''` when there is none). */
export const emailDomain = (email: string) => {
  const at = email.lastIndexOf('@');
  return at < 0
    ? ''
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
};

/** Does `domain` equal one of `list` or sit under one of them (a subdomain)? */
export const domainMatches = (domain: string, list: readonly string[]) =>
  list.some((d) => {
    const x = d.trim().toLowerCase();
    return !!x && (domain === x || domain.endsWith(`.${x}`));
  });

/**
 * Whether an address may sign up under these rules (null = yes). The order is the one the screen explains: the
 * owner's block list, then the allow list (when it has anything, only its domains), throw-away inboxes, free mailboxes.
 */
export const signupEmailProblem = (email: string, rules: SignupEmailRules): SignupEmailProblem | null => {
  const domain = emailDomain(email);
  if (!domain) return 'domain_not_allowed';
  if (domainMatches(domain, rules.domain_block)) return 'domain_blocked';
  if (rules.domain_allow.length && !domainMatches(domain, rules.domain_allow)) return 'domain_not_allowed';
  if (rules.block_disposable && domainMatches(domain, [...DISPOSABLE_EMAIL_DOMAINS, ...rules.disposable_domains]))
    return 'disposable';
  if (rules.require_work_email && domainMatches(domain, FREE_EMAIL_DOMAINS)) return 'work_email_required';
  return null;
};

/**
 * An account slug from an organisation's name: Latin letters and digits kept, the rest becomes dashes. A name with
 * no Latin letters (Hebrew) gives `''` — the caller falls back to its own base. Never longer than `max`.
 */
export const slugFromName = (name: string, max = 40) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
