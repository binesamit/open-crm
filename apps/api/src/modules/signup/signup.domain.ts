// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  DISPOSABLE_EMAIL_DOMAINS,
  DOMAIN_VERIFY_PREFIX,
  type DomainJoinResponse,
  type DomainJoinState,
  domainJoinStateSchema,
  domainMatches,
  emailDomain,
  FREE_EMAIL_DOMAINS,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accounts, accountSettings } from '../../db/schema';
import { assertAccountAdmin } from '../../lib/account-admin';
import type { AccountContext, AppDeps, SessionUser } from '../../types';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { securityOf } from '../admin/security.service';
import { recordAudit } from '../audit/audit.repo';
import { appLink } from '../platform/public-address';
import { signupMissing } from './signup.settings';
import { loadSignupSettings } from './signup.store';

/**
 * Domain join (D32 decision 11, plan ה7). The account's domains and "auto join" with its role already live in admin →
 * security (`settings.domains`, `security.auto_join`, `security.auto_join_role`); this adds what makes them safe to
 * act on: a domain counts for joining once verified — the admin verifying it has a verified address at it, or its
 * DNS holds the TXT record `bines-domain-verification=<token>` — and a verified domain belongs to one account. Free
 * and throw-away mailboxes never qualify. People at a joinable domain then join the account through the sign-up page
 * with the chosen role (signup.service.ts); the usual invitation underneath keeps edition limits and seats.
 */

type Deps = Pick<AppDeps, 'db' | 'env' | 'emailEnabled'>;
type Actor = { ctx: AccountContext; user: SessionUser; requestId?: string };

/** DNS lookups (tests replace `resolveTxt`). */
export const domainResolver = { resolveTxt: (domain: string) => resolveTxt(domain) };

const stateOf = (settings: Record<string, unknown>): DomainJoinState => {
  const parsed = domainJoinStateSchema.safeParse(settings.domain_join ?? {});
  return parsed.success ? parsed.data : domainJoinStateSchema.parse({});
};
const domainsOf = (settings: Record<string, unknown>) =>
  Array.isArray(settings.domains)
    ? (settings.domains as unknown[]).filter((d): d is string => typeof d === 'string')
    : [];
const freeMail = (domain: string) =>
  domainMatches(domain, FREE_EMAIL_DOMAINS) || domainMatches(domain, DISPOSABLE_EMAIL_DOMAINS);
const newToken = () => randomBytes(16).toString('hex');

/** Is sign-up open on this platform (its owner's switch on and nothing missing)? Joining goes through its page. */
const signupOpen = async (deps: Deps) => {
  const s = await loadSignupSettings(deps.db);
  return s.enabled && (await signupMissing(deps, s)).length === 0;
};

/** The account's settings with a verification entry (and token) for every one of its domains. */
const withTokens = (settings: Record<string, unknown>) => {
  const state = stateOf(settings);
  const domains = domainsOf(settings);
  const missing = domains.filter((d) => !state.verifications.some((v) => v.domain === d));
  if (!missing.length) return { settings, changed: false };
  const verifications = [
    ...state.verifications,
    ...missing.map((domain) => ({ domain, method: null, token: newToken(), verified_at: null, verified_by: null })),
  ];
  return { settings: { ...settings, domain_join: { ...state, verifications } }, changed: true };
};

const dto = async (deps: Deps, settings: Record<string, unknown>): Promise<DomainJoinResponse> => {
  const security = securityOf(settings);
  const state = stateOf(settings);
  return {
    enabled: security.auto_join,
    role: security.auto_join_role,
    domains: domainsOf(settings).map((domain) => {
      const v = state.verifications.find((x) => x.domain === domain);
      return {
        domain,
        verified: !!v?.verified_at && !freeMail(domain),
        method: v?.method ?? null,
        verified_at: v?.verified_at ?? null,
        free_mail: freeMail(domain),
        record: { type: 'TXT' as const, name: domain, value: `${DOMAIN_VERIFY_PREFIX}=${v?.token ?? ''}` },
      };
    }),
    available: await signupOpen(deps),
    join_url: await appLink(deps, '/signup'),
  };
};

/** Is `domain` verified by an account other than `accountId` (which still lists it)? */
const takenBy = async (db: Db, domain: string, accountId: string) => {
  const rows = await db
    .select({ accountId: accountSettings.accountId, settings: accountSettings.settings })
    .from(accountSettings)
    .innerJoin(accounts, eq(accounts.id, accountSettings.accountId))
    .where(and(isNull(accounts.deletedAt), sql`${accountSettings.settings} ? 'domain_join'`));
  return rows.some((r) => {
    const s = r.settings as Record<string, unknown>;
    return (
      r.accountId !== accountId &&
      domainsOf(s).includes(domain) &&
      stateOf(s).verifications.some((v) => v.domain === domain && v.verified_at)
    );
  });
};

/** GET /security/domain-join (account admins): the account domains' verification, the record to add for each. */
export const getDomainJoin = async (deps: Deps, a: Actor) => {
  assertAccountAdmin(a.ctx);
  const raw = (await getAccountSettings(deps.db, a.ctx.accountId)) as Record<string, unknown>;
  const { settings, changed } = withTokens(raw);
  if (changed) await upsertAccountSettings(deps.db, a.ctx.accountId, settings, a.user.id);
  return dto(deps, settings);
};

/**
 * POST /security/domain-join/domains/{domain}/verify: one of the account's domains. Verified by the admin's own
 * verified address at it, else by its TXT record (422 domain_record_not_found). Free mailboxes never (422
 * domain_free_mail); a domain another account verified, never twice (409 domain_taken).
 */
export const verifyJoinDomain = async (deps: Deps, a: Actor, raw: string) => {
  assertAccountAdmin(a.ctx);
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed');
  const domain = raw.trim().toLowerCase();
  const { settings } = withTokens((await getAccountSettings(deps.db, a.ctx.accountId)) as Record<string, unknown>);
  if (!domainsOf(settings).includes(domain)) throw new AppError('not_found', 'Domain not found');
  if (freeMail(domain)) throw new AppError('invalid_value', 'domain_free_mail', { domain });
  const state = stateOf(settings);
  const entry = state.verifications.find((v) => v.domain === domain)!;
  if (entry.verified_at) return dto(deps, settings);
  let method: 'email' | 'dns';
  if (a.user.emailVerified && emailDomain(a.user.email) === domain) method = 'email';
  else {
    const want = `${DOMAIN_VERIFY_PREFIX}=${entry.token}`;
    const records = await domainResolver.resolveTxt(domain).catch(() => [] as string[][]);
    if (!records.some((chunks) => chunks.join('').trim() === want))
      throw new AppError('invalid_value', 'domain_record_not_found', { domain, record: want });
    method = 'dns';
  }
  if (await takenBy(deps.db, domain, a.ctx.accountId)) throw new AppError('conflict', 'domain_taken', { domain });
  const next = {
    ...settings,
    domain_join: {
      ...state,
      verifications: state.verifications.map((v) =>
        v.domain === domain ? { ...v, method, verified_at: new Date().toISOString(), verified_by: a.user.id } : v,
      ),
    },
  };
  await upsertAccountSettings(deps.db, a.ctx.accountId, next, a.user.id);
  await recordAudit(deps.db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'domain_join.domain_verified',
    targetType: 'account',
    targetId: a.ctx.accountId,
    payload: { domain, method },
  });
  return dto(deps, next);
};

/**
 * The account an address joins by its domain: auto join on, the domain (or a parent of it) among its domains and
 * verified; null = none. Used when sign-up starts and again when the account is about to be joined.
 */
export const findJoinTarget = async (db: Db, email: string) => {
  const domain = emailDomain(email);
  if (!domain || freeMail(domain)) return null;
  const rows = await db
    .select({ accountId: accountSettings.accountId, settings: accountSettings.settings })
    .from(accountSettings)
    .innerJoin(accounts, eq(accounts.id, accountSettings.accountId))
    .where(
      and(
        isNull(accounts.deletedAt),
        sql`(${accountSettings.settings} -> 'security' ->> 'auto_join') = 'true'`,
        sql`${accountSettings.settings} ? 'domain_join'`,
      ),
    );
  for (const r of rows) {
    const s = r.settings as Record<string, unknown>;
    const listed = domainsOf(s);
    const verified = stateOf(s)
      .verifications.filter((v) => v.verified_at && listed.includes(v.domain))
      .map((v) => v.domain);
    if (verified.length && domainMatches(domain, verified))
      return { accountId: r.accountId, role: securityOf(s).auto_join_role };
  }
  return null;
};
