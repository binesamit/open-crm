// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type ErrorCode,
  ERROR_STATUS,
  type Heartbeat,
  type LicensingSettings,
  publicLicenseCheckResultSchema,
  publicPollResultSchema,
  publicRegisterResultSchema,
  type RegistrationForm,
  registrationFormSchema,
  type RegistrationStatus,
  REGISTRATION_STATUSES,
  type SubmitRegistration,
  type UpdateLicensingSettings,
  publicLicenseKeySchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { AppDeps, SessionUser } from '../../types';
import { getInstanceId } from './instance';
import { verifyLicenseKey } from './license-key';
import { keyFingerprint } from './license-signing';
import { countActiveUsers, countBoards, readSettingsRow, writeSettingsRow } from './license.repo';
import { forgetLicense, installLicenseKey, licenseStatus, recordLicenseCheck, storedLicense } from './license.service';

/**
 * The installation's side of licensing (docs/LICENSING.md, part C): which license server it talks to, the optional
 * registration questionnaire, the optional online check of its key, and the telemetry heartbeat — OFF by default.
 *
 * Nothing leaves this server unless the platform owner acts: "Submit" on the questionnaire (the answers, the random
 * `instance_id`, the version), "Check online" (the instance id and the key's id), or turning telemetry on (a daily
 * heartbeat: version, active users, boards count). `BINES_TELEMETRY=false` / `BINES_UPDATE_CHECK=false` force those
 * off whatever the console says. No license server is built in: the console setting, else `LICENSE_SERVER_URL`.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'secrets'>;

const SETTINGS_ROW = 'licensing';
const REGISTRATION_ROW = 'registration';
const TIMEOUT_MS = 10_000;
const HEARTBEAT_EVERY_MS = 23 * 3_600_000;

type Stored = {
  server_url?: string | null;
  /** The license server's public key (PEM): fetched from `/public/licenses/key` when the address is set, or pasted. */
  server_public_key?: string | null;
  telemetry?: boolean;
  last_heartbeat_at?: string | null;
};
type StoredRegistration = {
  status?: RegistrationStatus;
  email?: string | null;
  at?: string | null;
  registration_id?: string | null;
  poll_secret_sealed?: string | null;
  /** The license server the registration was made with: its secret is only ever sent back there. */
  server?: string | null;
};

/** Outbound calls to the license server (tests route them to an in-process app). */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
export const setLicensingFetchForTests = (f: Fetch | null) => {
  fetcher = f ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }));
};

const off = (v: string | undefined) => !!v && /^(false|0|off|no)$/i.test(v.trim());
export const telemetryForcedOff = (env: Deps['env']) => off(env.BINES_TELEMETRY);
export const updateCheckForcedOff = (env: Deps['env']) => off(env.BINES_UPDATE_CHECK);

const loadSettings = async (deps: Deps): Promise<Stored> =>
  ((await readSettingsRow(deps.db, SETTINGS_ROW)) ?? {}) as Stored;
const loadRegistration = async (deps: Deps): Promise<StoredRegistration> =>
  ((await readSettingsRow(deps.db, REGISTRATION_ROW)) ?? {}) as StoredRegistration;

/**
 * `{ poll_secret }` of this installation's registration, when it has one (the server takes its word only with it) —
 * and only for the server it came from (after moving to another license server, the old secret stays home).
 */
const pollSecretOf = async (deps: Deps): Promise<{ poll_secret?: string }> => {
  const r = await loadRegistration(deps);
  if (!r.poll_secret_sealed) return {};
  if (r.server && r.server !== resolveServer(deps, await loadSettings(deps)).url) return {};
  return { poll_secret: deps.secrets.open(r.poll_secret_sealed) };
};

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');

/** The license server in use: the console setting, else `LICENSE_SERVER_URL`, else none (''). */
const resolveServer = (deps: Deps, s: Stored) => {
  if (s.server_url) return { url: trimUrl(s.server_url), source: 'setting' as const };
  if (deps.env.LICENSE_SERVER_URL) return { url: trimUrl(deps.env.LICENSE_SERVER_URL), source: 'env' as const };
  return { url: '', source: 'none' as const };
};

const serverUrlOr503 = async (deps: Deps) => {
  const { url } = resolveServer(deps, await loadSettings(deps));
  if (!url) throw new AppError('license_server_unavailable', 'No license server is configured');
  return url;
};

const version = () => process.env.npm_package_version ?? '0.0.0';

/** Exactly what a heartbeat sends (also shown to the owner before they turn telemetry on). */
export const heartbeatPayload = async (deps: Pick<Deps, 'db'>): Promise<Heartbeat> => ({
  instance_id: await getInstanceId(deps.db),
  version: version(),
  active_users: await countActiveUsers(deps.db),
  boards: await countBoards(deps.db),
});

const statusOf = (r: StoredRegistration): RegistrationStatus =>
  r.status && (REGISTRATION_STATUSES as readonly string[]).includes(r.status) ? r.status : 'unasked';

/** GET /platform/licensing. */
export const getLicensingSettings = async (deps: Deps): Promise<LicensingSettings> => {
  const [s, r, instance_id, preview] = await Promise.all([
    loadSettings(deps),
    loadRegistration(deps),
    getInstanceId(deps.db),
    heartbeatPayload(deps),
  ]);
  const server = resolveServer(deps, s);
  const status = statusOf(r);
  return {
    instance_id,
    server_url: server.url,
    server_url_source: server.source,
    server_url_setting: s.server_url ?? null,
    server_public_key: s.server_public_key ?? null,
    server_key_fingerprint: s.server_public_key ? fingerprintOf(s.server_public_key) : null,
    registration: { status, email: r.email ?? null, at: r.at ?? null, ask: status === 'unasked' && !!server.url },
    offline_register_url: server.url ? `${server.url}/register?instance=${encodeURIComponent(instance_id)}` : null,
    telemetry: {
      enabled: !!s.telemetry,
      forced_off: telemetryForcedOff(deps.env),
      last_sent_at: s.last_heartbeat_at ?? null,
      preview,
    },
    update_check_forced_off: updateCheckForcedOff(deps.env),
  };
};

const fingerprintOf = (pem: string) => {
  try {
    return keyFingerprint(pem);
  } catch {
    return null;
  }
};

/** The license server's public key (PEM), or null when it cannot be reached or is not a license server. */
const fetchServerKey = async (url: string): Promise<string | null> => {
  try {
    const res = await fetcher(`${url}/api/v1/public/licenses/key`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const parsed = publicLicenseKeySchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success || fingerprintOf(parsed.data.public_key) === null) return null;
    return parsed.data.public_key;
  } catch {
    return null;
  }
};

/**
 * PATCH /platform/licensing: the license server's address (its public key is fetched with it, so the keys it
 * issues are trusted here; a pasted `server_public_key` replaces that), and the telemetry opt-in.
 */
export const updateLicensingSettings = async (deps: Deps, owner: SessionUser, patch: UpdateLicensingSettings) => {
  const s = await loadSettings(deps);
  const next: Stored = {
    ...s,
    ...(patch.server_url !== undefined ? { server_url: patch.server_url ? trimUrl(patch.server_url) : null } : {}),
    ...(patch.telemetry !== undefined ? { telemetry: patch.telemetry } : {}),
  };
  if (patch.server_public_key !== undefined) {
    if (patch.server_public_key && fingerprintOf(patch.server_public_key) === null)
      throw new AppError('validation_failed', 'server_public_key is not a readable public key');
    next.server_public_key = patch.server_public_key || null;
  } else if (patch.server_url !== undefined && next.server_url !== s.server_url) {
    next.server_public_key = next.server_url ? await fetchServerKey(next.server_url) : null;
  }
  await writeSettingsRow(deps.db, SETTINGS_ROW, next, owner.id);
  forgetLicense();
  return getLicensingSettings(deps);
};

// ---------------------------------------------------------------- calls to the license server

/** A JSON call to the license server. Its own errors come back as ours (rate limit, Turnstile, bad input). */
const call = async <T extends z.ZodType>(
  deps: Deps,
  path: string,
  body: unknown,
  schema: T,
  headers: Record<string, string> = {},
): Promise<z.infer<T>> => {
  const url = await serverUrlOr503(deps);
  let res: Response;
  try {
    res = await fetcher(`${url}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AppError('external_error', 'The license server could not be reached', { reason: 'unreachable' });
  }
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  } | null;
  if (!res.ok) {
    const code = json?.error?.code;
    // Registered already, and this installation no longer holds that registration's secret: say so, not "failed".
    if (code === 'conflict' && json?.error?.message === 'instance_registered')
      throw new AppError('conflict', 'instance_registered');
    const passThrough: ErrorCode[] = ['captcha_required', 'captcha_failed', 'rate_limited', 'validation_failed'];
    if (code && (passThrough as string[]).includes(code) && code in ERROR_STATUS)
      throw new AppError(code as ErrorCode, 'License server: ' + code, json?.error?.details);
    if (res.status === 404) throw new AppError('license_server_unavailable', 'That address is not a license server');
    throw new AppError('external_error', 'The license server refused the request', { status: res.status });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AppError('external_error', 'The license server answered something unexpected');
  return parsed.data;
};

/** GET /platform/registration/form: is registration available, and does the server ask for Turnstile? */
export const registrationForm = async (deps: Deps): Promise<RegistrationForm> => {
  const { url } = resolveServer(deps, await loadSettings(deps));
  if (!url) return { available: false, captcha_site_key: null };
  try {
    return await call(deps, '/public/installations/config', undefined, registrationFormSchema);
  } catch {
    return { available: false, captcha_site_key: null };
  }
};

/** POST /platform/registration: send the questionnaire; the key follows once the email is verified (poll). */
export const submitRegistration = async (deps: Deps, owner: SessionUser, input: SubmitRegistration) => {
  const { captcha_token, ...answers } = input;
  const res = await call(
    deps,
    '/public/installations/register',
    {
      ...answers,
      instance_id: await getInstanceId(deps.db),
      version: version(),
      locale: input.locale ?? (owner.locale === 'en' ? 'en' : 'he'),
      // Registering again (new details): the secret of the earlier registration lets the server accept it.
      ...(await pollSecretOf(deps)),
    },
    publicRegisterResultSchema,
    captcha_token ? { 'x-captcha-token': captcha_token } : {},
  );
  await writeSettingsRow(
    deps.db,
    REGISTRATION_ROW,
    {
      status: 'pending',
      email: answers.email,
      at: new Date().toISOString(),
      registration_id: res.registration_id,
      poll_secret_sealed: deps.secrets.seal(res.poll_secret),
      server: await serverUrlOr503(deps),
    } satisfies StoredRegistration,
    owner.id,
  );
  return getLicensingSettings(deps);
};

/** POST /platform/registration/skip: never asked again (registering later stays possible from the license card). */
export const skipRegistration = async (deps: Deps, owner: SessionUser) => {
  const r = await loadRegistration(deps);
  if (statusOf(r) === 'unasked')
    await writeSettingsRow(
      deps.db,
      REGISTRATION_ROW,
      { ...r, status: 'skipped', at: new Date().toISOString() },
      owner.id,
    );
  return getLicensingSettings(deps);
};

/**
 * POST /platform/registration/reset: forget the registration state (a pending one too) — the questionnaire is asked
 * again (e.g. after moving to another license server). The installed key is not touched, and neither is the earlier
 * registration's secret: a verified installation registers again only with it (audit 2026-10-10 #22), so forgetting
 * it would lock this installation out of its own server for good.
 */
export const resetRegistration = async (deps: Deps, owner: SessionUser) => {
  const r = await loadRegistration(deps);
  await writeSettingsRow(
    deps.db,
    REGISTRATION_ROW,
    {
      status: 'unasked',
      registration_id: r.registration_id ?? null,
      poll_secret_sealed: r.poll_secret_sealed ?? null,
      server: r.server ?? null,
    } satisfies StoredRegistration,
    owner.id,
  );
  return getLicensingSettings(deps);
};

/**
 * POST /platform/registration/poll: while pending, ask the license server whether the email is verified; when it
 * is, its Registered key is installed here by itself (unless a key is already in force — never replaced silently).
 */
export const pollRegistrationHere = async (deps: Deps, owner: SessionUser) => {
  const r = await loadRegistration(deps);
  if (statusOf(r) === 'pending' && r.registration_id && r.poll_secret_sealed) {
    const res = await call(
      deps,
      '/public/installations/status',
      { registration_id: r.registration_id, poll_secret: deps.secrets.open(r.poll_secret_sealed) },
      publicPollResultSchema,
    );
    if (res.status === 'verified' && res.key) {
      const current = await licenseStatus(deps.db);
      const inForce = current.state === 'valid' || current.state === 'expiring' || current.state === 'grace';
      if (!inForce) await installLicenseKey(deps.db, owner.id, res.key);
      // The registration id and its sealed secret stay: the heartbeat, the online check and a re-registration
      // prove this installation with them from now on (audit 2026-10-10 #22).
      await writeSettingsRow(
        deps.db,
        REGISTRATION_ROW,
        {
          status: 'registered',
          email: r.email ?? null,
          at: new Date().toISOString(),
          registration_id: r.registration_id,
          poll_secret_sealed: r.poll_secret_sealed,
          server: r.server ?? null,
        } satisfies StoredRegistration,
        owner.id,
      );
    }
  }
  return { settings: await getLicensingSettings(deps), license: await licenseStatus(deps.db) };
};

/**
 * POST /platform/license/check: the optional online check (off with `BINES_UPDATE_CHECK=false`). A revoked key is
 * marked revoked here (its features turn off); a newer key for the same license (renewal / plan change) that is in
 * force here replaces it.
 */
export const checkLicenseOnline = async (deps: Deps, owner: SessionUser) => {
  if (updateCheckForcedOff(deps.env)) throw new AppError('update_check_disabled', 'BINES_UPDATE_CHECK=false');
  const stored = await storedLicense(deps.db);
  if (!stored) return licenseStatus(deps.db);
  const instanceId = await getInstanceId(deps.db);
  const current = verifyLicenseKey(stored.key, undefined, new Date(), instanceId);
  const res = await call(
    deps,
    '/public/licenses/check',
    { instance_id: instanceId, license_id: current.payload?.id ?? null, ...(await pollSecretOf(deps)) },
    publicLicenseCheckResultSchema,
  );
  if (res.status === 'revoked') {
    await recordLicenseCheck(deps.db, owner.id, true);
    return licenseStatus(deps.db);
  }
  if (res.key && res.key.trim() !== stored.key.trim()) {
    const next = verifyLicenseKey(res.key, undefined, new Date(), instanceId);
    if (next.ok) await installLicenseKey(deps.db, owner.id, res.key);
  }
  await recordLicenseCheck(deps.db, owner.id, false);
  forgetLicense();
  return licenseStatus(deps.db);
};

// ---------------------------------------------------------------- telemetry

export type HeartbeatResult = 'forced_off' | 'disabled' | 'no_server' | 'not_due' | 'sent' | 'failed';

/** Sends the daily heartbeat if — and only if — the owner opted in, nothing forces it off, and a day has passed. */
export const sendHeartbeatIfDue = async (deps: Deps, now = new Date()): Promise<HeartbeatResult> => {
  if (telemetryForcedOff(deps.env)) return 'forced_off';
  const s = await loadSettings(deps);
  if (!s.telemetry) return 'disabled';
  const { url } = resolveServer(deps, s);
  if (!url) return 'no_server';
  if (s.last_heartbeat_at && now.getTime() - Date.parse(s.last_heartbeat_at) < HEARTBEAT_EVERY_MS) return 'not_due';
  try {
    const res = await fetcher(`${url}/api/v1/public/installations/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The registration secret proves the numbers are this installation's (never in the owner's preview).
      body: JSON.stringify({ ...(await heartbeatPayload(deps)), ...(await pollSecretOf(deps)) }),
    });
    if (!res.ok) return 'failed';
  } catch {
    return 'failed';
  }
  await writeSettingsRow(deps.db, SETTINGS_ROW, { ...s, last_heartbeat_at: now.toISOString() }, null);
  return 'sent';
};

/** index.ts (one process): looks once an hour; sends at most once a day, only with the owner's opt-in. */
export const startTelemetry = (deps: Deps) => {
  const tick = () =>
    void sendHeartbeatIfDue(deps).catch((err: unknown) =>
      deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'telemetry heartbeat failed'),
    );
  const timer = setInterval(tick, 3_600_000);
  timer.unref();
  const first = setTimeout(tick, 60_000);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
};
