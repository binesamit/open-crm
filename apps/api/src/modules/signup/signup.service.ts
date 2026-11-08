// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import {
  accountSlugSchema,
  AppError,
  emailDomain,
  type LegalAcceptance,
  newId,
  passwordLengthProblem,
  type RejectSignup,
  type SignupConfig,
  type SignupMethod,
  type SignupRequest,
  type SignupRequestStatus,
  type SignupComplete,
  type SignupDetail,
  type SignupResult,
  type SignupSettings,
  signupEmailProblem,
  type signupIntentSchema,
  type signupStartSchema,
  slugFromName,
} from '@bines/shared';
import type { z } from 'zod';
import { INVITE_TOKEN_HEADER } from '../../auth/auth';
import { platformPasswordMin } from '../../auth/password-policy';
import type { Db } from '../../db/client';
import { RESOLVED_IP_HEADER } from '../../lib/client-ip';
import { RateLimiter } from '../../lib/rate-limit';
import { newSecretToken, sha256 } from '../../lib/tokens';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';
import { findAccountById, findAccountBySlug, updateAccountRow } from '../accounts/accounts.repo';
import { provisionAccount } from '../accounts/accounts.service';
import { recordAudit } from '../audit/audit.repo';
import { listPlans, startSignupSubscription } from '../billing/plans.service';
import { assertCaptcha, platformCaptchaAnyKeys, platformCaptchaKeys } from '../captcha/captcha.service';
import { findPendingInvitationForAccountEmail, rotateInvitationToken } from '../invitations/invitations.repo';
import { acceptInvitationByToken, issueInvitation } from '../invitations/invitations.service';
import { acceptLegal, requiredLegal } from '../legal/legal.service';
import { appLink } from '../platform/public-address';
import { FIRST_ADMIN_PAYLOAD } from '../support/support.access';
import { findUserById, findUserIdByEmail, updateUserProfile } from '../users/users.repo';
import { liveIntent } from './signup.intent';
import { findJoinTarget } from './signup.domain';
import { mailOwners, mailSignup } from './signup.mail';
import { sendDueTrialEmails } from './signup.trial';
import {
  claimSignupRequest,
  countSignupRequests,
  expireOpenRequestsOf,
  findSignupRequest,
  findSignupRequestByToken,
  insertSignupRequest,
  latestSignupRequest,
  listSignupRequests,
  membershipCount,
  ownsAccount,
  type SignupRequestRow,
  sweepSignupRequests,
  updateSignupRequest,
} from './signup.repo';
import { offeredPlans, signupMissing } from './signup.settings';
import { loadSignupSettings, saveSignupSettings } from './signup.store';
import { startScreenOffered } from '../onboarding/onboarding.service';

/**
 * Self sign-up (D32, the approved SIGNUP plan, stages ה1 + ה3). A person opens an account of their own through the
 * doors that already exist — the account and its starter kit (`provisionAccount`), the first-admin invitation
 * (`issueInvitation`: edition limits, plan seats), a Better Auth sign-up with that invitation's token (the password
 * policy, the user hooks) and accepting it (edition limits, membership) — then the plan's trial and the consent the
 * form recorded. Nothing here answers while the owner's switch is off (404); a switch that is on while something is
 * missing (a key removed, email gone) answers 503 `signup_unavailable`.
 *
 * Protections (ה3): Turnstile (mandatory by default), the honeypot, the owner's address rules (block / allow lists,
 * throw-away inboxes, work email), per-address-per-hour and per-email-per-day limits and a platform daily cap — all
 * counted from the requests table, so they hold across restarts and replicas — and an optional manual approval.
 * Every start answers the same `{ok: true}`; only the email differs ("verify" / "you already have an account").
 */
type Deps = AppDeps;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Ended requests stay this many days for the owner's queue, then the daily sweep removes them. */
export const SIGNUP_KEEP_DAYS = 30;
/** The invitation behind the account's first admin lives only for the request that uses it. */
const INVITE_MINUTES = 10;

/** "Send again" from one client address: a burst guard on top of the per-request cooldown (in memory). */
const resendPerIp = new RateLimiter(20, HOUR);
export const forgetSignupLimits = () => resendPerIp.clear();

const OK = { ok: true as const };

// ------------------------------------------------------------------------------------------------ guards

/** The settings when sign-up answers: 404 while the switch is off, 503 while it cannot work. */
const openSettings = async (deps: Deps) => {
  const s = await loadSignupSettings(deps.db);
  if (!s.enabled) throw new AppError('not_found', 'Not found');
  const missing = await signupMissing(deps, s);
  if (missing.length) {
    deps.logger.warn({ missing }, 'self sign-up is on but cannot work: refused');
    throw new AppError('signup_unavailable', 'Sign-up is not available right now');
  }
  return s;
};

/** The Turnstile keys a sign-up checks with: always the platform's when it is mandatory, else the `sign_up` place's. */
const captchaKeys = async (db: Db, s: SignupSettings) =>
  s.require_captcha ? platformCaptchaAnyKeys(db) : platformCaptchaKeys(db, 'sign_up');

const tooMany = (retryMs: number) =>
  new AppError('rate_limited', 'Too many sign-up attempts', { retry_after_ms: Math.max(1000, retryMs) });

/** The plan version a request starts on: the chosen public plan's current version, else the default plan's. */
const chosenVersion = async (db: Db, s: SignupSettings, planId: string | undefined) => {
  const offered = await offeredPlans(db);
  const id = s.choose_plan && planId ? planId : s.default_plan_id;
  if (!id || !offered.some((p) => p.id === id)) throw new AppError('invalid_value', 'plan_unavailable');
  const plan = (await listPlans(db)).find((p) => p.id === id);
  return plan?.current_version_id ?? null;
};

/**
 * What every start (password or provider) checks before anything is stored — in the order the screen explains. A
 * provider's intent may come without the consent (`requireLegal: false`): the screen after the provider asks for it,
 * and only the versions actually accepted are kept.
 */
const checkStart = async (
  deps: Deps,
  s: SignupSettings,
  input: z.output<typeof signupStartSchema> | z.output<typeof signupIntentSchema>,
  method: SignupMethod,
  meta: RequestMeta,
  email: string | null,
  requireLegal = true,
  join = false,
) => {
  if (!s.methods.includes(method)) throw new AppError('signup_method_unavailable', 'This sign-up method is off');
  await assertCaptcha(deps.secrets, await captchaKeys(deps.db, s), input.captcha_token, meta.ip);
  if (email) {
    const problem = signupEmailProblem(email, s);
    if (problem) throw new AppError('signup_email_not_allowed', 'This address may not sign up', { reason: problem });
  }
  const required = await requiredLegal(deps.db);
  const accepted = (d: { slug: string; version: number }) =>
    input.accept_legal.some((a) => a.slug === d.slug && a.version === d.version);
  const missing = required.filter((d) => !accepted(d));
  if (missing.length && requireLegal)
    throw new AppError('legal_consent_required', 'Accept the current terms to join', {
      slugs: missing.map((d) => d.slug),
    });
  const now = Date.now();
  if ((await countSignupRequests(deps.db, new Date(now - DAY))) >= s.daily_cap) {
    deps.logger.warn({ cap: s.daily_cap }, 'self sign-up daily cap reached');
    throw new AppError('signup_daily_cap', 'Sign-up is full for today — try again tomorrow');
  }
  if (meta.ip && (await countSignupRequests(deps.db, new Date(now - HOUR), { ip: meta.ip })) >= s.rate_ip_hour)
    throw tooMany(HOUR);
  if (email && (await countSignupRequests(deps.db, new Date(now - DAY), { email })) >= s.rate_email_day)
    throw tooMany(DAY);
  return {
    // Joining an existing account (domain join) starts no plan: the account has its own.
    versionId: join ? null : await chosenVersion(deps.db, s, input.plan_id),
    consents: required.filter(accepted).map((d) => ({ slug: d.slug, version: d.version })),
  };
};

const requestBase = (
  input: z.output<typeof signupStartSchema> | z.output<typeof signupIntentSchema>,
  meta: RequestMeta,
  checked: { versionId: string | null; consents: LegalAcceptance[] },
) => ({
  name: input.name,
  orgName: input.org_name,
  planVersionId: checked.versionId,
  locale: input.locale ?? null,
  timezone: input.timezone ?? null,
  currency: input.currency ?? null,
  consents: checked.consents,
  // The marketing box: only ever a tick the person made.
  marketingOptIn: input.marketing_opt_in === true,
  ip: meta.ip?.slice(0, 64) ?? null,
  userAgent: meta.userAgent?.slice(0, 300) ?? null,
});

/** What a request asked for, as the "being reviewed" screen shows it: the organisation, the plan, its trial days. */
const requestSummary = async (db: Db, s: SignupSettings, r: Pick<SignupRequestRow, 'orgName' | 'planVersionId'>) => {
  const plan = r.planVersionId
    ? (await listPlans(db)).find((p) => p.versions.some((v) => v.id === r.planVersionId))
    : undefined;
  const version = plan?.versions.find((v) => v.id === r.planVersionId);
  return {
    org_name: r.orgName,
    plan_name: plan?.name ?? null,
    trial_days: version?.trial_days || s.trial_days,
  };
};

const verifyUrl = (deps: Deps, token: string) => appLink(deps, `/signup/verify#token=${token}`);

/**
 * May a registered person open an account of their own by signing up ? Yes while they own none — someone
 * only invited into other accounts. Never a platform owner (the installation's own accounts are theirs).
 */
const mayOpenAccount = async (deps: Deps, row: { id: string; email: string; isPlatformOwner: boolean }) =>
  !row.isPlatformOwner &&
  row.email.toLowerCase() !== deps.env.SEED_ADMIN_EMAIL?.toLowerCase() &&
  !(await ownsAccount(deps.db, row.id));

// ------------------------------------------------------------------------------------------------ public

/** GET /public/signup/config: what the sign-up screen shows; closed = `open: false` and nothing else. */
export const signupConfig = async (deps: Deps): Promise<SignupConfig> => {
  const s = await loadSignupSettings(deps.db);
  const password_min_length = await platformPasswordMin(deps.db);
  const open = s.enabled && (await signupMissing(deps, s)).length === 0;
  if (!open)
    return {
      open: false,
      methods: [],
      choose_plan: false,
      default_plan_id: null,
      plans: [],
      trial_days: 0,
      legal: [],
      captcha_site_key: null,
      password_min_length,
      link_hours: s.link_hours,
      resend_seconds: s.resend_seconds,
      sample_boards: false,
      mode: s.mode,
    };
  const plans = await offeredPlans(deps.db);
  return {
    open: true,
    methods: s.methods,
    choose_plan: s.choose_plan,
    default_plan_id: s.default_plan_id,
    plans: s.choose_plan ? plans : plans.filter((p) => p.id === s.default_plan_id),
    trial_days: s.trial_days,
    legal: await requiredLegal(deps.db),
    captcha_site_key: (await captchaKeys(deps.db, s))?.site_key ?? null,
    password_min_length,
    link_hours: s.link_hours,
    resend_seconds: s.resend_seconds,
    sample_boards: s.starter_kit !== 'empty',
    mode: s.mode,
  };
};

/**
 * POST /public/signup/start: always `{ok: true}`. A new address gets the verification link (the password is kept
 * only as its hash, until the account exists); a registered one that owns no account yet — only invited into others —
 * gets a link that opens one for them as they are; any other registered one (or one already waiting for
 * approval) gets an email saying so. The honeypot answers the same and stores nothing.
 */
export const startSignup = async (deps: Deps, input: z.output<typeof signupStartSchema>, meta: RequestMeta) => {
  const s = await openSettings(deps);
  if (input.website?.trim()) {
    deps.logger.info('self sign-up: honeypot filled, ignored');
    return OK;
  }
  const email = input.email.trim().toLowerCase();
  // Domain join (ה7): an address at a verified, joinable domain joins that account; in `domain_join` mode nothing else.
  const target = await findJoinTarget(deps.db, email);
  if (!target && s.mode === 'domain_join')
    throw new AppError('signup_domain_not_joinable', 'This address cannot join an organisation here');
  if (!target && !input.org_name.trim()) throw new AppError('invalid_value', 'org_name_required');
  const checked = await checkStart(deps, s, input, 'password', meta, email, true, !!target);
  const min = await platformPasswordMin(deps.db);
  if (passwordLengthProblem(input.password, min))
    throw new AppError('invalid_value', 'password_min_length', { min_length: min });
  // Hashed for every address alike (the work, and so the time, does not tell a registered address apart).
  const passwordHash = await (await deps.auth.$context).password.hash(input.password);
  const now = new Date();
  const base = {
    id: newId(),
    email,
    method: 'password',
    ...requestBase(input, meta, checked),
    joinAccountId: target?.accountId ?? null,
  };

  const owner = deps.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const userId = await findUserIdByEmail(deps.db, email);
  const existing = userId ? await findUserById(deps.db, userId) : undefined;
  // Someone only invited into other accounts opens one of their own: the link is for them as they are
  // their password stays theirs, the one typed here is not used. Never for a domain join (that is another door).
  const opener = !!existing && !target && (await mayOpenAccount(deps, existing));
  const registered = (!!owner && owner === email) || (!!existing && !opener);
  const waiting = registered ? undefined : await latestSignupRequest(deps.db, email, ['pending_approval', 'approved']);
  if (registered || waiting) {
    await insertSignupRequest(deps.db, {
      ...base,
      status: 'existing_user',
      reason: registered ? 'registered' : 'pending_request',
      sends: 1,
      lastSentAt: now,
    });
    await mailSignup(deps, registered ? 'exists' : 'pending', base);
    return OK;
  }

  await expireOpenRequestsOf(deps.db, email);
  const token = newSecretToken();
  await insertSignupRequest(deps.db, {
    ...base,
    status: 'pending_email',
    tokenHash: sha256(token),
    ...(opener ? { userId: existing.id, passwordHash: null } : { passwordHash }),
    sends: 1,
    lastSentAt: now,
    expiresAt: new Date(now.getTime() + s.link_hours * HOUR),
  });
  await mailSignup(deps, opener ? 'open' : 'verify', base, { url: await verifyUrl(deps, token), hours: s.link_hours });
  return OK;
};

/**
 * POST /public/signup/resend: always `{ok: true}`. A live request of the address gets a new link (the old one stops)
 * once `resend_seconds` passed since the last email, at most `rate_email_day` emails per request.
 */
export const resendSignup = async (deps: Deps, input: { email: string }, meta: RequestMeta) => {
  const s = await openSettings(deps);
  if (resendPerIp.hit(`signup-resend:${meta.ip ?? 'unknown'}`) > 0) throw tooMany(HOUR);
  const email = input.email.trim().toLowerCase();
  const r = await latestSignupRequest(deps.db, email, ['pending_email']);
  const now = new Date();
  if (
    !r ||
    !r.expiresAt ||
    r.expiresAt <= now ||
    r.sends >= s.rate_email_day ||
    (r.lastSentAt && now.getTime() - r.lastSentAt.getTime() < s.resend_seconds * 1000)
  )
    return OK;
  const token = newSecretToken();
  await updateSignupRequest(deps.db, r.id, {
    tokenHash: sha256(token),
    sends: r.sends + 1,
    lastSentAt: now,
    expiresAt: new Date(now.getTime() + s.link_hours * HOUR),
  });
  await mailSignup(deps, opensForExisting(r) ? 'open' : 'verify', r, {
    url: await verifyUrl(deps, token),
    hours: s.link_hours,
  });
  return OK;
};

/** A password request of someone already registered: no password of its own, the person is known. */
const opensForExisting = (r: Pick<SignupRequestRow, 'method' | 'userId' | 'passwordHash'>) =>
  r.method === 'password' && !!r.userId && !r.passwordHash;

/**
 * POST /public/signup/verify: the email link. Creates the account and signs the person in (the session cookie), or —
 * with manual approval on — leaves the request waiting for the platform owner. A link used, expired or unknown =
 * 404 `verification_invalid`.
 */
export const verifySignup = async (
  deps: Deps,
  input: { token: string },
  meta: RequestMeta,
): Promise<{ result: SignupResult; cookies: string[] }> => {
  const s = await openSettings(deps);
  const now = new Date();
  const r = await findSignupRequestByToken(deps.db, sha256(input.token));
  if (!r || r.status !== 'pending_email' || !r.expiresAt || r.expiresAt <= now)
    throw new AppError('verification_invalid', 'The link is invalid or expired');
  // The platform owner's approval is for new accounts; a domain join was allowed by the account's own admins.
  if (s.approval && !r.joinAccountId) {
    const claimed = await claimSignupRequest(deps.db, r.id, ['pending_email'], 'pending_approval', {
      tokenHash: null,
      verifiedAt: now,
    });
    if (!claimed) throw new AppError('verification_invalid', 'The link is invalid or expired');
    if (s.notify_owner) await mailOwners(deps, 'approval', r);
    return {
      result: { status: 'pending_approval', account: null, request: await requestSummary(deps.db, s, r) },
      cookies: [],
    };
  }
  if (!(await claimSignupRequest(deps.db, r.id, ['pending_email'], 'approved', { verifiedAt: now })))
    throw new AppError('verification_invalid', 'The link is invalid or expired');
  const done = await provision(deps, r, { meta, signIn: true, back: 'pending_email' });
  return {
    result: {
      status: 'provisioned',
      account: done.account,
      request: await requestSummary(deps.db, s, r),
      ...(r.joinAccountId ? { joined: true } : {}),
    },
    cookies: done.cookies,
  };
};

/**
 * POST /public/signup/intent (before Google / Microsoft): the same checks as a start, minus the address (the
 * provider tells it); stores a `pending_provider` request for half an hour and answers the cookie that lets the
 * provider's callback create the person (signup.intent.ts).
 */
export const startSignupIntent = async (
  deps: Deps,
  input: z.output<typeof signupIntentSchema>,
  meta: RequestMeta,
  minutes: number,
): Promise<{ token: string | null }> => {
  const s = await openSettings(deps);
  if (input.website?.trim()) return { token: null };
  const checked = await checkStart(deps, s, input, input.method, meta, null, false);
  const token = newSecretToken();
  await insertSignupRequest(deps.db, {
    id: newId(),
    // The address comes from the provider (complete); until then the request has none.
    email: '',
    method: input.method,
    status: 'pending_provider',
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + minutes * 60_000),
    ...requestBase(input, meta, checked),
  });
  return { token };
};

/**
 * The organisation, plan and consent of a provider sign-up: the intent's, completed by what the "two more details"
 * screen sent. Something still lacking = 422 `signup_details_required` (details.missing) and the intent stays live.
 */
const completedDetails = async (
  deps: Deps,
  s: SignupSettings,
  r: SignupRequestRow,
  user: SessionUser,
  more: SignupComplete,
  join = false,
) => {
  const required = await requiredLegal(deps.db);
  const given = [...((r.consents ?? []) as LegalAcceptance[]), ...(more.accept_legal ?? [])];
  const consents = required
    .filter((d) => given.some((a) => a.slug === d.slug && a.version === d.version))
    .map((d) => ({ slug: d.slug, version: d.version }));
  const orgName = more.org_name?.trim() || r.orgName.trim();
  const missing: SignupDetail[] = [];
  if (!orgName && !join) missing.push('org_name');
  if (consents.length < required.length) missing.push('legal');
  if (missing.length) throw new AppError('signup_details_required', 'A few details are still missing', { missing });
  const planVersionId = join ? null : more.plan_id ? await chosenVersion(deps.db, s, more.plan_id) : r.planVersionId;
  return {
    orgName,
    consents,
    planVersionId,
    name: r.name.trim() || user.name.trim() || orgName,
    marketingOptIn: r.marketingOptIn || more.marketing_opt_in === true,
  };
};

/**
 * POST /public/signup/complete (signed in by Google / Microsoft, with the intent cookie): the person the provider's
 * callback just created — or someone only invited into other accounts — becomes the new account's admin
 * or waits for approval. What the intent did not hold (organisation, plan, consent) comes in the body. Someone who
 * already owns an account is refused (409 `signup_already_registered`: they are signed in to it).
 */
export const completeSignup = async (
  deps: Deps,
  user: SessionUser,
  cookieHeader: string | undefined,
  meta: RequestMeta,
  more: SignupComplete = {},
): Promise<SignupResult> => {
  const s = await openSettings(deps);
  const r = await liveIntent(deps.db, cookieHeader);
  if (!r) throw new AppError('verification_invalid', 'The sign-up expired — start again');
  const row = await findUserById(deps.db, user.id);
  const email = user.email.toLowerCase();
  const fresh =
    !!row && row.createdAt.getTime() >= r.createdAt.getTime() && (await membershipCount(deps.db, user.id)) === 0;
  // Someone only invited into other accounts may open one of their own — a new account, not a domain join.
  const opener =
    !fresh &&
    !!row &&
    !(await findJoinTarget(deps.db, email)) &&
    s.mode !== 'domain_join' &&
    (await mayOpenAccount(deps, row));
  if (!fresh && !opener) {
    await updateSignupRequest(deps.db, r.id, {
      status: 'existing_user',
      reason: 'registered',
      email,
      userId: user.id,
      tokenHash: null,
    });
    throw new AppError('signup_already_registered', 'You already have an account — you are signed in to it');
  }
  const problem = signupEmailProblem(email, s);
  if (problem) throw new AppError('signup_email_not_allowed', 'This address may not sign up', { reason: problem });
  // The provider tells the address only now: domain join decided here (ה7).
  const target = await findJoinTarget(deps.db, email);
  if (!target && s.mode === 'domain_join')
    throw new AppError('signup_domain_not_joinable', 'This address cannot join an organisation here');
  const details = await completedDetails(deps, s, r, user, more, !!target);
  const now = new Date();
  const ready = {
    email,
    userId: user.id,
    verifiedAt: now,
    tokenHash: null,
    ...details,
    joinAccountId: target?.accountId ?? null,
  };
  if (s.approval && !target) {
    if (!(await claimSignupRequest(deps.db, r.id, ['pending_provider'], 'pending_approval', ready)))
      throw new AppError('verification_invalid', 'The sign-up expired — start again');
    if (s.notify_owner) await mailOwners(deps, 'approval', { ...r, ...ready });
    return { status: 'pending_approval', account: null, request: await requestSummary(deps.db, s, ready) };
  }
  if (!(await claimSignupRequest(deps.db, r.id, ['pending_provider'], 'approved', ready)))
    throw new AppError('verification_invalid', 'The sign-up expired — start again');
  const done = await provision(deps, { ...r, ...ready }, { meta, signIn: false, user, back: 'pending_provider' });
  return {
    status: 'provisioned',
    account: done.account,
    request: await requestSummary(deps.db, s, ready),
    ...(target ? { joined: true } : {}),
  };
};

// ------------------------------------------------------------------------------------------------ provisioning

/** A free account slug from the organisation's name (else the address's name, else random), never a reserved one. */
const freeSlug = async (db: Db, orgName: string, email: string) => {
  const fromName = slugFromName(orgName);
  const fromEmail = slugFromName(email.split('@')[0] ?? '');
  const base = [fromName, fromEmail].find((b) => b.length >= 3) ?? `x${randomBytes(4).toString('hex')}`;
  const random = () => randomBytes(3).toString('hex');
  const candidates = [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}-${n}`)];
  for (let i = 0; i < 20; i++) candidates.push(`${base}-${random()}`);
  for (const slug of candidates)
    if (accountSlugSchema.safeParse(slug).success && !(await findAccountBySlug(db, slug))) return slug;
  throw new AppError('conflict', 'no_free_slug');
};

const sessionUserOf = (row: NonNullable<Awaited<ReturnType<typeof findUserById>>>): SessionUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  emailVerified: row.emailVerified,
  isPlatformOwner: row.isPlatformOwner,
  locale: row.locale ?? 'he',
  timezone: row.timezone ?? null,
});

/**
 * The account for a verified (or approved) request, through the existing doors. Leaves nothing half made: when a
 * step fails the account is soft-deleted, a person created here is removed and the request goes back to `back`.
 * `signIn`: hand the new session to the caller (the email link); otherwise (the owner approving) it is dropped.
 */
const provision = async (
  deps: Deps,
  r: SignupRequestRow,
  o: { meta: RequestMeta; signIn: boolean; back: SignupRequestStatus; user?: SessionUser; actorId?: string },
) => {
  const s = await loadSignupSettings(deps.db);
  const email = r.email.toLowerCase();
  const authCtx = await deps.auth.$context;
  let accountId: string | undefined;
  let createdUserId: string | undefined;
  // Domain join (ה7): the organisation's existing account, if it still lets this address in — else a new account.
  const join = r.joinAccountId ? await findJoinTarget(deps.db, email) : null;
  if (r.joinAccountId && join?.accountId !== r.joinAccountId) {
    await updateSignupRequest(deps.db, r.id, { status: o.back }).catch(() => undefined);
    throw new AppError('signup_domain_not_joinable', 'This address cannot join that organisation any more');
  }
  const role = join ? join.role : 'admin';
  // Someone already registered: the account is theirs as they are — no new person, no password, and no
  // session either (their own sign-in, two-step included, opens it). Only while they still own no account.
  let known = o.user;
  if (!known && opensForExisting(r)) {
    const row = await findUserById(deps.db, r.userId!);
    if (!row || row.email.toLowerCase() !== email || join || !(await mayOpenAccount(deps, row))) {
      await updateSignupRequest(deps.db, r.id, { status: 'existing_user', reason: 'registered', tokenHash: null });
      throw new AppError('signup_already_registered', 'You already have an account — sign in to it');
    }
    known = sessionUserOf(row);
  }
  try {
    if (!known && (await findUserIdByEmail(deps.db, email))) throw new AppError('conflict', 'signup_email_taken');
    // The slug is found before the transaction (one connection: a query outside it inside would wait for itself).
    const slug = join ? '' : await freeSlug(deps.db, r.orgName, email);
    // "How to start?": the account opens empty; the sign-up kit waits for its admin's choice.
    const startScreen = !join && (await startScreenOffered(deps));
    const account = join
      ? (await findAccountById(deps.db, join.accountId))!
      : await deps.db.transaction(async (tx) =>
          provisionAccount(tx, {
            name: r.orgName,
            slug,
            templateSet: startScreen ? 'empty' : s.starter_kit,
            timezone: r.timezone ?? undefined,
            currency: r.currency ?? undefined,
            createdBy: null,
            origin: 'signup',
            onboarding: startScreen,
          }),
        );
    if (!join) accountId = account.id;
    await issueInvitation(deps, {
      account,
      email,
      role,
      invitedBy: null,
      sendEmail: false,
      ...(join ? {} : { payload: FIRST_ADMIN_PAYLOAD }),
      auditPayload: { via: join ? 'domain_join' : 'signup', signup_request: r.id },
    });
    const invitation = await findPendingInvitationForAccountEmail(deps.db, account.id, email);
    if (!invitation) throw new AppError('conflict', 'no_invitation');
    // A token only this request knows, valid a few minutes (as the first-run setup does).
    const token = newSecretToken();
    await rotateInvitationToken(deps.db, invitation.id, sha256(token), new Date(Date.now() + INVITE_MINUTES * 60_000));

    let user = known;
    let cookies: string[] = [];
    if (!user) {
      if (!r.passwordHash) throw new AppError('verification_invalid', 'The link is invalid or expired');
      const headers = new Headers({ [INVITE_TOKEN_HEADER]: token });
      if (o.meta.ip) headers.set(RESOLVED_IP_HEADER, o.meta.ip);
      if (o.meta.userAgent) headers.set('user-agent', o.meta.userAgent);
      // The password door with the invitation's token; the real password (its stored hash) replaces the throw-away
      // one right after, so the plain password was never kept anywhere.
      const signUp = await deps.auth.api.signUpEmail({
        body: { email, password: newSecretToken(24), name: r.name },
        headers,
        asResponse: true,
      });
      if (!signUp.ok) throw new AppError('bad_request', 'signup_failed');
      createdUserId = ((await signUp.clone().json()) as { user?: { id?: string } }).user?.id;
      const row = createdUserId ? await findUserById(deps.db, createdUserId) : undefined;
      if (!row) throw new AppError('bad_request', 'signup_failed');
      await authCtx.internalAdapter.updatePassword(row.id, r.passwordHash);
      if (o.signIn) cookies = signUp.headers.getSetCookie();
      else await authCtx.internalAdapter.deleteUserSessions(row.id);
      if (r.locale) await updateUserProfile(deps.db, row.id, { locale: r.locale as 'he' | 'en' });
      user = sessionUserOf({ ...row, locale: r.locale ?? row.locale });
    }
    const joined = await acceptInvitationByToken(deps.db, user, token, o.meta);

    // A member joining by domain gets no plan (the account has its own), no trial emails, no "new account" email.
    const versions = join ? [] : (await listPlans(deps.db)).flatMap((p) => p.versions.map((v) => v.id));
    const versionId = join
      ? null
      : r.planVersionId && versions.includes(r.planVersionId)
        ? r.planVersionId
        : await chosenVersion(deps.db, s, undefined).catch(() => null);
    // The plan's trial (no card): the version shown on the form, else the default plan's current one.
    if (versionId)
      await startSignupSubscription(deps.db, {
        accountId: account.id,
        versionId,
        trialDays: s.trial_days,
        trialEndStatus: s.trial_end_status,
        actorId: user.id,
      });

    // Joining agrees to the versions the form showed (a newer one is asked for by the usual prompt).
    const current = await requiredLegal(deps.db);
    const accepted = ((r.consents ?? []) as LegalAcceptance[]).filter((c) =>
      current.some((d) => d.slug === c.slug && d.version === c.version),
    );
    if (accepted.length) await acceptLegal(deps, user, accepted, 'signup', o.meta);
    // The marketing box ticked on the form (a separate consent, kept with its date).
    if (r.marketingOptIn) await updateUserProfile(deps.db, user.id, { marketingOptInAt: new Date() });

    await recordAudit(deps.db, {
      accountId: account.id,
      actorId: user.id,
      action: join ? 'member.joined_by_domain' : 'account.created',
      targetType: join ? 'user' : 'account',
      targetId: join ? user.id : account.id,
      payload: join
        ? { via: 'domain_join', signup_request: r.id, role, domain: emailDomain(email) }
        : { via: 'signup', signup_request: r.id, template_set: s.starter_kit, plan_version_id: versionId },
      ip: o.meta.ip,
      userAgent: o.meta.userAgent,
    });
    await updateSignupRequest(deps.db, r.id, {
      status: 'provisioned',
      accountId: account.id,
      userId: user.id,
      passwordHash: null,
      tokenHash: null,
    });
    await insertPlatformAudit(deps.db, {
      action: join ? 'signup.joined' : 'signup.provisioned',
      targetType: 'signup_request',
      targetId: r.id,
      actorId: o.actorId ?? user.id,
      payload: { account_id: account.id, domain: emailDomain(email), method: r.method },
    });
    if (!join) {
      if (s.notify_owner && !o.actorId) await mailOwners(deps, 'created', r);
      // The trial's welcome email goes at once (the hourly job sends what follows).
      await sendDueTrialEmails(deps, new Date(), { accountId: account.id }).catch((err) =>
        deps.logger.warn({ err, account: account.id }, 'trial welcome email failed'),
      );
    }
    deps.logger.info({ account: account.id, request: r.id, joined: !!join }, 'self sign-up: done');
    return { account: { id: joined.id, slug: joined.slug, name: joined.name }, cookies, userId: user.id };
  } catch (err) {
    if (accountId) await updateAccountRow(deps.db, accountId, { deletedAt: new Date() }).catch(() => undefined);
    if (createdUserId) await authCtx.internalAdapter.deleteUser(createdUserId).catch(() => undefined);
    await updateSignupRequest(deps.db, r.id, { status: o.back }).catch(() => undefined);
    deps.logger.warn({ err, request: r.id }, 'self sign-up: provisioning failed, rolled back');
    throw err;
  }
};

// ------------------------------------------------------------------------------------------------ owner

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const signupRequestDto = (r: SignupRequestRow): SignupRequest => ({
  id: r.id,
  email: r.email,
  name: r.name,
  org_name: r.orgName,
  method: r.method as SignupMethod,
  status: r.status as SignupRequestStatus,
  plan_version_id: r.planVersionId,
  locale: r.locale,
  ip: r.ip,
  user_agent: r.userAgent,
  account_id: r.accountId,
  user_id: r.userId,
  reason: r.reason,
  decided_by: r.decidedBy,
  decided_at: iso(r.decidedAt),
  verified_at: iso(r.verifiedAt),
  expires_at: iso(r.expiresAt),
  created_at: r.createdAt.toISOString(),
});

/** GET /platform/signup-requests (platform owner): newest first, by status / text, a page at a time. */
export const listSignupRequestsFor = async (
  deps: Pick<AppDeps, 'db'>,
  q: { status?: SignupRequestStatus; q?: string; limit: number; before?: string },
) => {
  const rows = await listSignupRequests(deps.db, q);
  const page = rows.slice(0, q.limit);
  return {
    data: page.map(signupRequestDto),
    next: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
  };
};

const mustFind = async (db: Db, id: string) => {
  const r = await findSignupRequest(db, id);
  if (!r) throw new AppError('not_found', 'Sign-up request not found');
  return r;
};

/**
 * POST /platform/signup-requests/{id}/approve (platform owner): a verified request waiting for approval gets its
 * account (the same provisioning) and an email "your account is ready". 409 when it is not waiting.
 */
export const approveSignupRequest = async (deps: Deps, owner: SessionUser, id: string, meta: RequestMeta) => {
  const r = await mustFind(deps.db, id);
  const now = new Date();
  if (
    !(await claimSignupRequest(deps.db, id, ['pending_approval'], 'approved', { decidedBy: owner.id, decidedAt: now }))
  )
    throw new AppError('conflict', 'signup_request_not_pending');
  let user: SessionUser | undefined;
  if (r.method !== 'password') {
    const row = r.userId ? await findUserById(deps.db, r.userId) : undefined;
    if (!row) {
      await updateSignupRequest(deps.db, id, { status: 'pending_approval' });
      throw new AppError('conflict', 'signup_user_missing');
    }
    user = sessionUserOf(row);
  }
  await provision(deps, r, { meta, signIn: false, back: 'pending_approval', user, actorId: owner.id });
  await mailSignup(deps, 'approved', r);
  return signupRequestDto((await findSignupRequest(deps.db, id))!);
};

/**
 * POST /platform/signup-requests/{id}/reject (platform owner): the request ends (its password hash with it); a
 * verified person gets an email with the reason; `block_domain` adds the address's domain to the block list.
 */
export const rejectSignupRequest = async (
  deps: Deps,
  owner: SessionUser,
  id: string,
  input: RejectSignup,
  _meta: RequestMeta,
) => {
  const r = await mustFind(deps.db, id);
  const claimed = await claimSignupRequest(
    deps.db,
    id,
    ['pending_approval', 'pending_email', 'pending_provider'],
    'rejected',
    { decidedBy: owner.id, decidedAt: new Date(), reason: input.reason || null, passwordHash: null, tokenHash: null },
  );
  if (!claimed) throw new AppError('conflict', 'signup_request_not_pending');
  const domain = emailDomain(r.email);
  if (input.block_domain && domain) {
    const s = await loadSignupSettings(deps.db);
    if (!s.domain_block.includes(domain))
      await saveSignupSettings(deps.db, owner.id, { ...s, domain_block: [...s.domain_block, domain] });
  }
  await insertPlatformAudit(deps.db, {
    action: 'signup.rejected',
    targetType: 'signup_request',
    targetId: id,
    actorId: owner.id,
    payload: { domain, blocked_domain: !!input.block_domain, had_reason: !!input.reason },
  });
  // Only someone who proved the address hears about it (an unverified one may not be theirs).
  if (r.status === 'pending_approval') await mailSignup(deps, 'rejected', r, { reason: input.reason ?? null });
  return signupRequestDto((await findSignupRequest(deps.db, id))!);
};

/** The daily sweep (worker): expired links, and ended requests older than SIGNUP_KEEP_DAYS. */
export const sweepSignup = (db: Db, now = new Date()) => sweepSignupRequests(db, now, SIGNUP_KEEP_DAYS);
