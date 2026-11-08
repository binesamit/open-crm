// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import {
  AppError,
  type ChangeLicensePlan,
  DEFAULT_GRACE_DAYS,
  EDITION_FEATURES,
  EDITION_SUPPORT,
  type Heartbeat,
  type Installation,
  type InstallationsQuery,
  type IssuedLicense,
  type IssueLicense,
  LICENSE_PLANS,
  LICENSE_TERM_DAYS,
  type LicensePayload,
  type LicensePlan,
  licenseTiming,
  newId,
  type PublicPollResult,
  type PublicRegister,
  type PublicRegisterResult,
  type PublicLicenseCheckResult,
  type PublicVerifyResult,
  SUPPORT_LEVELS,
  type SupportLevel,
  t,
  toCsv,
} from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { AppDeps, SessionUser } from '../../types';
import { RateLimiter } from '../../lib/rate-limit';
import { ipBucket } from '../../lib/client-ip';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';
import { assertCaptcha, platformCaptchaKeys } from '../captcha/captcha.service';
import { platformMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { verifyLicenseKey } from './license-key';
import { licenseSigner, signLicense } from './license-signing';
import {
  findInstallation,
  findInstallationByInstance,
  findInstallationByVerifyHash,
  findIssuedLicense,
  findIssuedLicenseByRef,
  findLatestLicenseForInstance,
  insertIssuedLicense,
  type InstallationRow,
  type IssuedLicenseRow,
  listInstallations,
  listIssuedLicenses,
  type ReminderRow,
  remindersFor,
  updateInstallation,
  updateIssuedLicense,
  upsertInstallation,
} from './license.repo';
import { loadLicenseOps, paymentsReady } from './license-ops.settings';

/**
 * The license server (docs/LICENSING.md, parts B–C): active only where `LICENSE_SIGNING_KEY` is set — the
 * licensor's own installation. It takes registrations from installations (public, rate-limited, Turnstile when the
 * owner turned it on, email verified before any key), issues signed keys, and keeps both lists for the owner
 * console. Everywhere else these calls answer 404 (public) or 503 `license_server_unavailable` (owner screens).
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'mailer' | 'secrets'>;

const DAY_MS = 86_400_000;
const VERIFY_HOURS = 48;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Public calls per client address: registrations (each sends an email) and the light ones (poll, verify, check). */
const registerPerIp = new RateLimiter(10, 60 * 60_000);
const registerPerTarget = new RateLimiter(5, 60 * 60_000);
const lightPerIp = new RateLimiter(600, 60 * 60_000);
/** Tests: forget every counter. */
export const resetLicenseServerLimits = () => {
  registerPerIp.clear();
  registerPerTarget.clear();
  lightPerIp.clear();
};

export const limited = (limiter: RateLimiter, key: string) => {
  const waitMs = limiter.hit(key);
  if (waitMs > 0) throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: waitMs });
};

export const signerOr404 = async (deps: Deps) => {
  const signer = await licenseSigner(deps);
  if (!signer) throw new AppError('not_found', 'Not found');
  return signer;
};
export const signerOr503 = async (deps: Deps) => {
  const signer = await licenseSigner(deps);
  if (!signer) throw new AppError('license_server_unavailable', 'This installation is not a license server');
  return signer;
};

// ---------------------------------------------------------------- issuing

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
export const asPlan = (p: string): LicensePlan =>
  (LICENSE_PLANS as readonly string[]).includes(p) ? (p as LicensePlan) : 'registered';
const asSupport = (s: string): SupportLevel =>
  (SUPPORT_LEVELS as readonly string[]).includes(s) ? (s as SupportLevel) : 'community';

export const issuedLicenseDto = (
  row: IssuedLicenseRow,
  now = new Date(),
  reminders: ReminderRow[] = [],
): IssuedLicense => ({
  id: row.id,
  ref: row.ref,
  licensee: row.licensee,
  plan: asPlan(row.plan),
  features: row.features,
  seats: row.seats,
  instance_id: row.instanceId,
  expires: isoOrNull(row.expires),
  grace_days: row.graceDays,
  support: asSupport(row.support),
  email: row.email,
  state: row.revokedAt
    ? 'revoked'
    : licenseTiming({ expires: isoOrNull(row.expires), grace_days: row.graceDays }, now).phase,
  key: row.key,
  issued_at: row.issuedAt.toISOString(),
  revoked_at: isoOrNull(row.revokedAt),
  // Only the reminders of the current expiry (a renewal starts them over).
  reminders: reminders
    .filter((r) => r.licenseId === row.id && row.expires && r.expires.getTime() === row.expires.getTime())
    .sort((a, b) => b.days - a.days)
    .map((r) => ({ days: r.days, sent_at: r.sentAt.toISOString() })),
  payment_provider: row.paymentProvider,
});

type KeyFields = {
  ref: string;
  licensee: string;
  plan: LicensePlan;
  features: string[];
  seats: number | null;
  instanceId: string | null;
  expires: Date | null;
  graceDays: number;
  support: SupportLevel;
};

const signFields = async (deps: Deps, f: KeyFields) => {
  const signer = await signerOr503(deps);
  const payload: LicensePayload = {
    licensee: f.licensee,
    features: f.features,
    expires: isoOrNull(f.expires),
    id: f.ref,
    issued_at: new Date().toISOString(),
    plan: f.plan,
    seats: f.seats,
    instance_id: f.instanceId,
    grace_days: f.graceDays,
    support: f.support,
  };
  return signLicense(signer.privateKey, payload);
};

const fieldsOf = (row: IssuedLicenseRow): KeyFields => ({
  ref: row.ref,
  licensee: row.licensee,
  plan: asPlan(row.plan),
  features: row.features,
  seats: row.seats,
  instanceId: row.instanceId,
  expires: row.expires,
  graceDays: row.graceDays,
  support: asSupport(row.support),
});

export const newRef = () => `LIC-${newId()}`;

type Payment = { paymentProvider: string; paymentCustomerId: string | null; paymentSubscriptionId: string | null };

export const insertSigned = async (
  deps: Deps,
  f: KeyFields,
  extra: { email: string | null; issuedBy: string | null; payment?: Payment },
) =>
  insertIssuedLicense(deps.db, {
    ...f,
    key: await signFields(deps, f),
    email: extra.email,
    issuedBy: extra.issuedBy,
    ...(extra.payment ?? {}),
  });

/** POST /platform/licenses: sign and keep a new license. */
export const issueLicense = async (deps: Deps, owner: SessionUser, input: IssueLicense) => {
  await signerOr503(deps);
  const row = await insertSigned(
    deps,
    {
      ref: newRef(),
      licensee: input.licensee,
      plan: input.plan,
      features: [...new Set(input.features)],
      seats: input.seats ?? null,
      instanceId: input.instance_id ?? null,
      expires: input.expires ? new Date(input.expires) : null,
      graceDays: input.grace_days ?? DEFAULT_GRACE_DAYS,
      support: input.support ?? EDITION_SUPPORT[input.plan],
    },
    { email: input.email ?? null, issuedBy: owner.id },
  );
  return issuedLicenseDto(row);
};

const loadOr404 = async (deps: Deps, id: string) => {
  await signerOr503(deps);
  const row = await findIssuedLicense(deps.db, id);
  if (!row) throw new AppError('not_found', 'License not found');
  return row;
};

const resign = async (deps: Deps, row: IssuedLicenseRow, next: KeyFields) => {
  const updated = await updateIssuedLicense(deps.db, row.id, {
    ...next,
    key: await signFields(deps, next),
    issuedAt: new Date(),
  });
  return issuedLicenseDto(updated!);
};

/** A new key, one more year (from its expiry, or from today if past) — the owner's button and a paid renewal. */
export const renewRow = async (deps: Deps, row: IssuedLicenseRow) => {
  if (row.revokedAt) throw new AppError('conflict', 'A revoked license is not renewed');
  const from = Math.max(Date.now(), row.expires?.getTime() ?? Date.now());
  return resign(deps, row, { ...fieldsOf(row), expires: new Date(from + LICENSE_TERM_DAYS * DAY_MS) });
};

/** POST /platform/licenses/{id}/renew. */
export const renewLicense = async (deps: Deps, _owner: SessionUser, id: string) =>
  renewRow(deps, await loadOr404(deps, id));

/** POST /platform/licenses/{id}/plan: another edition (features = the edition's unless sent). */
export const changeLicensePlan = async (deps: Deps, _owner: SessionUser, id: string, input: ChangeLicensePlan) => {
  const row = await loadOr404(deps, id);
  if (row.revokedAt) throw new AppError('conflict', 'A revoked license is not changed');
  return resign(deps, row, {
    ...fieldsOf(row),
    plan: input.plan,
    features: [...new Set(input.features ?? EDITION_FEATURES[input.plan])],
    support: EDITION_SUPPORT[input.plan],
  });
};

/** POST /platform/licenses/{id}/revoke: marked here; the installation learns it on its optional online check. */
export const revokeLicense = async (deps: Deps, owner: SessionUser, id: string) => {
  const row = await loadOr404(deps, id);
  if (row.revokedAt) return issuedLicenseDto(row);
  const updated = await updateIssuedLicense(deps.db, row.id, { revokedAt: new Date(), revokedBy: owner.id });
  return issuedLicenseDto(updated!);
};

export const sendKeyEmail = async (deps: Deps, to: string, row: IssuedLicenseRow, locale: unknown) => {
  const brand = await platformMailBrand(deps, locale);
  const l = brand.locale;
  await deps.mailer.send(
    noticeEmail({
      to,
      brand,
      subject: t('licensing.mail.key.subject', { product: brand.product }, l),
      title: t('licensing.mail.key.title', undefined, l),
      ...(row.key.length <= 48 && row.key.includes('-')
        ? {
            hero: {
              kind: 'code' as const,
              caption: row.licensee,
              code: row.key,
              meta: [t(`licensing.plan.${asPlan(row.plan)}`, undefined, l), ''] as [string, string],
            },
          }
        : { hero: { kind: 'seal' as const, letter: t('mail.obj.seal.license', undefined, l) } }),
      lines: [
        t(
          'licensing.mail.key.intro',
          { licensee: row.licensee, plan: t(`licensing.plan.${asPlan(row.plan)}`, undefined, l) },
          l,
        ),
        t('licensing.mail.key.howto', undefined, l),
        row.key,
      ],
      reason: t('licensing.mail.reason', { email: to, product: brand.product }, l),
    }),
  );
};

/** POST /platform/licenses/{id}/email: the key by email (to the license's address unless another is given). */
export const emailLicense = async (deps: Deps, owner: SessionUser, id: string, to?: string) => {
  const row = await loadOr404(deps, id);
  const address = to ?? row.email;
  if (!address) throw new AppError('invalid_value', 'license_email_missing');
  await sendKeyEmail(deps, address, row, owner.locale);
  if (!row.email && to) await updateIssuedLicense(deps.db, row.id, { email: to });
  return { ok: true as const };
};

export const listLicenses = async (deps: Deps) => {
  await signerOr503(deps);
  const now = new Date();
  const rows = await listIssuedLicenses(deps.db);
  const reminders = await remindersFor(
    deps.db,
    rows.filter((r) => r.expires).map((r) => r.id),
  );
  return rows.map((r) => issuedLicenseDto(r, now, reminders));
};

// ---------------------------------------------------------------- installations

export const installationDto = (r: InstallationRow): Installation => ({
  id: r.id,
  instance_id: r.instanceId,
  company: r.company,
  size: r.size,
  role: r.role,
  use_case: r.useCase,
  email: r.email,
  email_verified: !!r.verifiedAt,
  marketing_opt_in: r.marketingOptIn,
  version: r.version,
  registered_at: r.createdAt.toISOString(),
  verified_at: isoOrNull(r.verifiedAt),
  last_seen_at: isoOrNull(r.lastSeenAt),
  active_users: r.activeUsers,
  boards: r.boards,
  license_id: r.licenseId,
  secret_set: !!r.pollSecretHash,
});

export const listInstallationsDto = async (deps: Deps, q: InstallationsQuery) => {
  await signerOr503(deps);
  return (await listInstallations(deps.db, q)).map(installationDto);
};

/**
 * POST /platform/installations/{id}/release: the owner lets an installation register again without its registration
 * secret — for one that lost it (registered on code older than audit 2026-10-10 #22, which did not keep it; a reset
 * before that was fixed; a restored database). Its key is untouched; a new key still goes only through the emailed
 * link. Audited. Never automatic: anyone knowing an instance id and its address could otherwise take it over.
 */
export const releaseInstallation = async (deps: Deps, owner: SessionUser, id: string) => {
  await signerOr503(deps);
  const row = await findInstallation(deps.db, id);
  if (!row) throw new AppError('not_found', 'Installation not found');
  if (!row.pollSecretHash) return installationDto(row);
  const updated = await updateInstallation(deps.db, row.id, { pollSecretHash: null });
  await insertPlatformAudit(deps.db, {
    action: 'installation.released',
    targetType: 'installation',
    targetId: row.id,
    actorId: owner.id,
    payload: { instance_id: row.instanceId, email: row.email },
  });
  deps.logger.info({ owner: owner.id, installation: row.id }, 'license server: installation registration released');
  return installationDto(updated!);
};

const CSV_HEADER = [
  'instance_id',
  'company',
  'size',
  'role',
  'use_case',
  'email',
  'email_verified',
  'marketing_opt_in',
  'version',
  'registered_at',
  'last_seen_at',
  'active_users',
  'boards',
];

/** GET /platform/installations.csv: the filtered list as CSV (UTF-8 with BOM, spreadsheet-safe cells). */
export const installationsCsv = async (deps: Deps, q: InstallationsQuery) =>
  toCsv(
    CSV_HEADER,
    (await listInstallationsDto(deps, q)).map((i) => [
      i.instance_id,
      i.company,
      i.size,
      i.role,
      i.use_case,
      i.email,
      i.email_verified,
      i.marketing_opt_in,
      i.version,
      i.registered_at,
      i.last_seen_at,
      i.active_users,
      i.boards,
    ]),
  );

// ---------------------------------------------------------------- public: registration

/** GET /public/installations/config: may an installation register here, and does it need Turnstile? */
export const publicRegistrationConfig = async (deps: Deps) => {
  await signerOr404(deps);
  const keys = await platformCaptchaKeys(deps.db, 'registration');
  return {
    available: true,
    captcha_site_key: keys?.site_key ?? null,
    purchase_available: paymentsReady(await loadLicenseOps(deps)),
  };
};

/**
 * POST /public/installations/register: rate-limited (per address, per installation, per email), Turnstile when on,
 * then the installation is kept (one row per `instance_id`) and a verification link is emailed. No key until the
 * email is verified.
 */
export const registerInstallation = async (
  deps: Deps,
  input: PublicRegister,
  meta: { ip: string | null; captchaToken: string | null | undefined },
): Promise<PublicRegisterResult> => {
  await signerOr404(deps);
  limited(registerPerIp, ipBucket(meta.ip));
  limited(registerPerTarget, `instance:${input.instance_id}`);
  limited(registerPerTarget, `email:${input.email.toLowerCase()}`);
  await assertCaptcha(deps.secrets, await platformCaptchaKeys(deps.db, 'registration'), meta.captchaToken, meta.ip);
  // A verified installation is re-registered (new company / address) only by whoever holds its registration
  // secret — anyone knowing an instance id could overwrite its details and receive the mail (audit 2026-10-10 #22).
  const existing = await findInstallationByInstance(deps.db, input.instance_id);
  if (existing?.verifiedAt && existing.pollSecretHash && !secretMatches(existing, input.poll_secret))
    throw new AppError('conflict', 'instance_registered');
  const verify = token();
  const poll = token();
  const row = await upsertInstallation(deps.db, {
    instanceId: input.instance_id,
    company: input.company,
    size: input.size,
    role: input.role,
    useCase: input.use_case,
    email: input.email.toLowerCase(),
    marketingOptIn: input.marketing_opt_in,
    version: input.version ?? null,
    locale: input.locale ?? null,
    verifyTokenHash: sha256(verify),
    verifyExpiresAt: new Date(Date.now() + VERIFY_HOURS * 3_600_000),
    verifiedAt: null,
    pollSecretHash: sha256(poll),
  });
  const brand = await platformMailBrand(deps, input.locale);
  const l = brand.locale;
  // The token travels in the fragment: never in a server log or a referrer (audit 2026-10-10 #22).
  const url = await appLink(deps, `/register/verify#token=${encodeURIComponent(verify)}`);
  await deps.mailer.send(
    noticeEmail({
      to: row.email,
      brand,
      subject: t('licensing.mail.verify.subject', { product: brand.product }, l),
      title: t('licensing.mail.verify.title', undefined, l),
      hero: { kind: 'seal', letter: t('mail.obj.seal.license', undefined, l) },
      lines: [
        t('licensing.mail.verify.intro', { product: brand.product }, l),
        t('licensing.mail.verify.expires', { hours: VERIFY_HOURS }, l),
      ],
      cta: { label: t('licensing.mail.verify.cta', undefined, l), url },
      reason: t('licensing.mail.reason', { email: row.email, product: brand.product }, l),
    }),
  );
  return { status: 'pending_verification', registration_id: row.id, poll_secret: poll };
};

/** The installation's Registered key: the one already issued for it, or a new one (no expiry, its instance only). */
const registeredKeyFor = async (deps: Deps, row: InstallationRow) => {
  if (row.licenseId) {
    const existing = await findIssuedLicense(deps.db, row.licenseId);
    // Only a key this server's signing key still vouches for: after the signing key changed (a rotation, a
    // throwaway test key per run) the stored one would be refused by the installation — sign a new one instead.
    const signedHere =
      existing && verifyLicenseKey(existing.key, (await signerOr404(deps)).publicKey, new Date(), row.instanceId).ok;
    if (existing && signedHere && !existing.revokedAt && existing.instanceId === row.instanceId) return existing;
  }
  const license = await insertSigned(
    deps,
    {
      ref: newRef(),
      licensee: row.company.trim() || row.email,
      plan: 'registered',
      features: [...EDITION_FEATURES.registered],
      seats: null,
      instanceId: row.instanceId,
      expires: null,
      graceDays: DEFAULT_GRACE_DAYS,
      support: EDITION_SUPPORT.registered,
    },
    { email: row.email, issuedBy: null },
  );
  await updateInstallation(deps.db, row.id, { licenseId: license.id });
  return license;
};

/** POST /public/installations/verify: the emailed link — verifies the address and returns the Registered key. */
export const verifyRegistration = async (
  deps: Deps,
  tokenText: string,
  ip: string | null,
): Promise<PublicVerifyResult> => {
  await signerOr404(deps);
  limited(lightPerIp, ipBucket(ip));
  const row = await findInstallationByVerifyHash(deps.db, sha256(tokenText));
  if (!row || (!row.verifiedAt && (!row.verifyExpiresAt || row.verifyExpiresAt <= new Date())))
    throw new AppError('verification_invalid', 'The verification link is unknown or expired');
  // One use: the link's token is forgotten once the address is verified (audit 2026-10-10 #22); the installation
  // picks its key up with the registration secret from then on.
  const verified = row.verifiedAt
    ? row
    : ((await updateInstallation(deps.db, row.id, { verifiedAt: new Date(), verifyTokenHash: null })) ?? row);
  const license = await registeredKeyFor(deps, verified);
  return { key: license.key, licensee: license.licensee, instance_id: verified.instanceId };
};

/** POST /public/installations/status: the installation asks whether its email is verified yet — and for its key. */
export const pollRegistration = async (
  deps: Deps,
  input: { registration_id: string; poll_secret: string },
  ip: string | null,
): Promise<PublicPollResult> => {
  await signerOr404(deps);
  limited(lightPerIp, ipBucket(ip));
  const row = await findInstallation(deps.db, input.registration_id);
  if (!row || !row.pollSecretHash || row.pollSecretHash !== sha256(input.poll_secret))
    throw new AppError('not_found', 'Registration not found');
  if (!row.verifiedAt) return { status: 'pending', key: null };
  return { status: 'verified', key: (await registeredKeyFor(deps, row)).key };
};

/** POST /public/installations/heartbeat: an opted-in installation's daily numbers (registered ones only). */
export const recordHeartbeat = async (deps: Deps, input: Heartbeat, ip: string | null) => {
  await signerOr404(deps);
  limited(lightPerIp, ipBucket(ip));
  const row = await findInstallationByInstance(deps.db, input.instance_id);
  // A registered installation's numbers are taken only with its secret (spoofed telemetry, audit 2026-10-10 #22);
  // one known only through an issued key (no registration) has no secret to show.
  if (row && (!row.pollSecretHash || secretMatches(row, input.poll_secret)))
    await updateInstallation(deps.db, row.id, {
      lastSeenAt: new Date(),
      version: input.version,
      activeUsers: input.active_users,
      boards: input.boards,
    });
  return { ok: true as const };
};

/** The registration secret the request carries is the installation's. */
const secretMatches = (row: { pollSecretHash: string | null }, secret: string | undefined) =>
  !!secret && !!row.pollSecretHash && row.pollSecretHash === sha256(secret);

/**
 * POST /public/licenses/check: the optional online check — is the key revoked, and is there a newer one (a renewal
 * or plan change) for this installation? Unknown licenses answer `unknown` (keys signed offline with the tool).
 */
export const checkLicense = async (
  deps: Deps,
  input: { instance_id: string; license_id?: string | null; poll_secret?: string },
  ip: string | null,
): Promise<PublicLicenseCheckResult> => {
  await signerOr404(deps);
  limited(lightPerIp, ipBucket(ip));
  // A registered installation's key goes only to the installation itself (its registration secret, audit
  // 2026-10-10 #22). Without it — an installation running older code, or anyone with its instance id — the status
  // is still answered (a revocation must reach every installation), never a key.
  const installation = await findInstallationByInstance(deps.db, input.instance_id);
  const proven = !installation?.pollSecretHash || secretMatches(installation, input.poll_secret);
  const row = input.license_id
    ? await findIssuedLicenseByRef(deps.db, input.license_id)
    : await findLatestLicenseForInstance(deps.db, input.instance_id);
  // A license bound to another installation is not this one's business.
  if (!row || (row.instanceId && row.instanceId !== input.instance_id)) return { status: 'unknown', key: null };
  if (row.revokedAt) return { status: 'revoked', key: null };
  return { status: 'active', key: proven ? row.key : null };
};
