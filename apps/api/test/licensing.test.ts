// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDITION_FEATURES, REGISTERED_FEATURE_KEYS } from '@bines/shared';
import { issuedLicenses, platformAuditLog } from '../src/db/schema';
import { verifyLicenseKey } from '../src/modules/license/license-key';
import { forgetLicense, licensedFeatures } from '../src/modules/license/license.service';
import { readSettingsRow, writeSettingsRow } from '../src/modules/license/license.repo';
import { resetLicenseServerLimits } from '../src/modules/license/license-server.service';
import { sendHeartbeatIfDue, setLicensingFetchForTests } from '../src/modules/license/licensing.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Licensing, part C (docs/LICENSING.md): one installation that is also its own license server (a test signing key —
 * outside production its public key is trusted, as in the E2E run). The registration flow end to end (questionnaire
 * → verification email → poll installs the Registered key bound to this instance), the public endpoint's rate limit
 * and bad links, the owner's Installations (filter, CSV) and Licenses (issue, renew, change plan, revoke, email),
 * the online check learning a revocation, telemetry OFF by default (and forced off), Better Auth telemetry off, and
 * a plain installation that is not a license server.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SERVER = 'http://license.test';
const signingPem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const tokenFrom = (text: string) => /\/register\/verify#token=([\w-]+)/.exec(text)![1]!;

describe('a license server registering itself', () => {
  let t: TestContext;
  let owner: string;
  let member: string;
  let instance: string;
  const calls: string[] = [];

  beforeAll(async () => {
    forgetLicense();
    resetLicenseServerLimits();
    // The signing key as one escaped line (how it is pasted into a hosting panel).
    t = await createTestContext({
      env: { LICENSE_SIGNING_KEY: signingPem().replace(/\n/g, '\\n'), LICENSE_SERVER_URL: SERVER },
    });
    setLicensingFetchForTests(async (url, init) => {
      calls.push(url);
      return t.app.request(url.replace(SERVER, ''), init);
    });
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'empty',
    });
    const token = t.inviteTokenFor('admin@acme.test');
    member = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
    await t.api(member).post('/invitations/accept', { token });
    // A second active person (another account's admin): two active users on the installation.
    await t.api(owner).post('/platform/accounts', {
      name: 'Beta',
      slug: 'beta',
      first_admin_email: 'admin@beta.test',
      template_set: 'empty',
    });
    const token2 = t.inviteTokenFor('admin@beta.test');
    const second = t.cookieFrom(await t.signUpWithPassword('admin@beta.test', token2))!;
    await t.api(second).post('/invitations/accept', { token: token2 });
  }, 180_000);
  afterAll(async () => {
    setLicensingFetchForTests(null);
    forgetLicense();
    await t.close();
  });

  it('is 404 to anyone but the platform owner', async () => {
    for (const path of [
      '/platform/licensing',
      '/platform/installations',
      '/platform/licenses',
      '/platform/license-server',
    ])
      expect((await t.api(member).get(path)).status).toBe(404);
    expect((await t.api(member).post('/platform/registration', { email: 'x@y.test' })).status).toBe(404);
  });

  it('has a stable instance id, asks the questionnaire once, and keeps telemetry off', async () => {
    const s = await body(await t.api(owner).get('/platform/licensing'));
    expect(s.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s).toMatchObject({
      server_url: SERVER,
      server_url_source: 'env',
      registration: { status: 'unasked', ask: true },
      telemetry: { enabled: false, forced_off: false, last_sent_at: null },
      offline_register_url: `${SERVER}/register?instance=${s.instance_id}`,
    });
    // Exactly what a heartbeat would send — nothing more.
    expect(Object.keys(s.telemetry.preview).sort()).toEqual(['active_users', 'boards', 'instance_id', 'version']);
    instance = s.instance_id;
    expect((await body(await t.api(owner).get('/platform/licensing'))).instance_id).toBe(instance);
    expect(await body(await t.api(owner).get('/platform/license-server'))).toMatchObject({
      enabled: true,
      source: 'env',
      public_key: expect.stringContaining('-----BEGIN PUBLIC KEY-----'),
    });
  });

  it('sends no heartbeat by default', async () => {
    calls.length = 0;
    expect(await sendHeartbeatIfDue(t.deps)).toBe('disabled');
    expect(calls).toEqual([]);
  });

  it('turns Better Auth telemetry off explicitly (S-82)', () => {
    expect((t.deps.auth.options as Json).telemetry).toEqual({ enabled: false });
  });

  it('registers: questionnaire → verification email → the Registered key installs itself', async () => {
    const form = await body(await t.api(owner).get('/platform/registration/form'));
    // Not selling online (no payment provider set up): no "Buy a license".
    expect(form).toEqual({ available: true, captcha_site_key: null, purchase_available: false });

    const res = await t.api(owner).post('/platform/registration', {
      company: 'Acme Ltd',
      size: '6-20',
      role: 'CTO',
      use_case: 'crm',
      email: 'it@acme.test',
      marketing_opt_in: false,
    });
    expect(res.status).toBe(200);
    expect((await body(res)).registration).toMatchObject({ status: 'pending', email: 'it@acme.test', ask: false });

    // Not verified yet: no key.
    const early = await body(await t.api(owner).post('/platform/registration/poll'));
    expect(early.settings.registration.status).toBe('pending');
    expect(early.license.state).toBe('none');

    const mail = t.lastMailTo('it@acme.test');
    const verify = await t.app.request('/api/v1/public/installations/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenFrom(mail.text) }),
    });
    expect(verify.status).toBe(200);
    const v = await body(verify);
    expect(v).toMatchObject({ licensee: 'Acme Ltd', instance_id: instance });
    const check = verifyLicenseKey(v.key, undefined, new Date(), instance);
    expect(check.ok && check.payload).toMatchObject({
      plan: 'registered',
      features: [...REGISTERED_FEATURE_KEYS],
      instance_id: instance,
      expires: null,
      support: 'community',
    });
    // The link is single-use (audit 2026-10-10 #22): the installation picks its key up with its own secret.
    const again = await t.app.request('/api/v1/public/installations/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenFrom(mail.text) }),
    });
    expect(again.status).not.toBe(200);
    expect((await body(again)).error.code).toBe('verification_invalid');

    const done = await body(await t.api(owner).post('/platform/registration/poll'));
    expect(done.settings.registration.status).toBe('registered');
    expect(done.license).toMatchObject({ state: 'valid', plan: 'registered', key_instance_id: instance });
    expect(await licensedFeatures(t.db as never)).toEqual([...REGISTERED_FEATURE_KEYS]);
    expect((await body(await t.api(owner).get('/platform/licensing'))).registration.ask).toBe(false);

    // Anyone knowing the instance id, without the registration secret: no re-registration, no key, no telemetry.
    const pub = (path: string, payload: unknown) =>
      t.app.request(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    expect((await pub('/public/installations/register', { instance_id: instance, email: 'thief@x.test' })).status).toBe(
      409,
    );
    // Without the secret the status is still told (a revocation must reach an installation on older code) — the
    // key is not.
    expect(await body(await pub('/public/licenses/check', { instance_id: instance }))).toEqual({
      status: 'active',
      key: null,
    });
    await pub('/public/installations/heartbeat', {
      instance_id: instance,
      version: '9.9.9',
      active_users: 999,
      boards: 9,
    });
    const rows = (await body(await t.api(owner).get(`/platform/installations?q=${instance}`))).data as Json[];
    expect(rows[0]!.active_users).not.toBe(999);
    expect(rows[0]!.last_seen_at).toBeNull();
    // The installation itself (its client sends the secret): the check answers with the key.
    const mine = await body(await t.api(owner).post('/platform/license/check'));
    expect(mine).toMatchObject({ state: 'valid', plan: 'registered' });
  });

  it('reset asks again and keeps the registration secret: registering again with the same server works', async () => {
    resetLicenseServerLimits();
    // As the E2E leaves it: the key removed, the questionnaire reset — and the key the server issued earlier no longer
    // signed by its signing key (rotated; the E2E makes a throwaway one per run): a new key is signed, not the stale one.
    expect((await t.api(owner).del('/platform/license')).status).toBe(200);
    await t.db
      .update(issuedLicenses)
      .set({ key: 'lic1.signed-by-an-older-key' })
      .where(eq(issuedLicenses.instanceId, instance));
    const reset = await body(await t.api(owner).post('/platform/registration/reset'));
    expect(reset.registration).toMatchObject({ status: 'unasked', ask: true });
    const again = await t.api(owner).post('/platform/registration', {
      company: 'Acme Ltd',
      size: '6-20',
      role: 'CTO',
      use_case: 'crm',
      email: 'it@acme.test',
      marketing_opt_in: false,
    });
    expect(again.status).toBe(200);
    expect((await body(again)).registration.status).toBe('pending');
    const verified = await t.app.request('/api/v1/public/installations/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenFrom(t.lastMailTo('it@acme.test').text) }),
    });
    expect(verified.status).toBe(200);
    const polled = await t.api(owner).post('/platform/registration/poll');
    const p = await body(polled);
    expect(polled.status, JSON.stringify(p)).toBe(200);
    expect(p.settings.registration.status).toBe('registered');
    expect(p.license).toMatchObject({ state: 'valid', plan: 'registered' });

    // A database that lost the secret (e.g. restored from an older backup): told plainly, not "something failed".
    const kept = (await readSettingsRow(t.db as never, 'registration'))!;
    await writeSettingsRow(t.db as never, 'registration', { status: 'unasked' }, null);
    const lost = await t.api(owner).post('/platform/registration', {
      company: 'Acme Ltd',
      size: '6-20',
      role: 'CTO',
      use_case: 'crm',
      email: 'it@acme.test',
      marketing_opt_in: false,
    });
    expect(lost.status).toBe(409);
    expect((await body(lost)).error).toMatchObject({ code: 'conflict', message: 'instance_registered' });
    expect(kept.poll_secret_sealed).toBeTruthy();

    // The way back: the license server's owner releases it (only the owner; audited) → it registers again.
    const [row] = (await body(await t.api(owner).get(`/platform/installations?q=${instance}`))).data as Json[];
    expect(row).toMatchObject({ instance_id: instance, secret_set: true });
    expect((await t.api(member).post(`/platform/installations/${row!.id}/release`)).status).toBe(404);
    const released = await t.api(owner).post(`/platform/installations/${row!.id}/release`);
    expect(released.status).toBe(200);
    expect(await body(released)).toMatchObject({ id: row!.id, secret_set: false, license_id: row!.license_id });
    const audit = await t.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetId, row!.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'installation.released', targetType: 'installation' });
    expect((await t.api(owner).post('/platform/installations/nope/release')).status).toBe(404);
    const back = await t.api(owner).post('/platform/registration', {
      company: 'Acme Ltd',
      size: '6-20',
      role: 'CTO',
      use_case: 'crm',
      email: 'it@acme.test',
      marketing_opt_in: false,
    });
    expect(back.status).toBe(200);
    await t.app.request('/api/v1/public/installations/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenFrom(t.lastMailTo('it@acme.test').text) }),
    });
    expect((await body(await t.api(owner).post('/platform/registration/poll'))).settings.registration.status).toBe(
      'registered',
    );
    resetLicenseServerLimits();
  });

  it('refuses unknown verification links', async () => {
    const res = await t.app.request('/api/v1/public/installations/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token-at-all' }),
    });
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe('verification_invalid');
  });

  it('lists installations (filters, CSV)', async () => {
    const all = (await body(await t.api(owner).get('/platform/installations'))).data as Json[];
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      instance_id: instance,
      company: 'Acme Ltd',
      size: '6-20',
      use_case: 'crm',
      email_verified: true,
      marketing_opt_in: false,
    });
    expect((await body(await t.api(owner).get('/platform/installations?size=1-5'))).data).toHaveLength(0);
    expect((await body(await t.api(owner).get('/platform/installations?q=acme&verified=yes'))).data).toHaveLength(1);
    const csv = await t.api(owner).get('/platform/installations.csv');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain('instance_id,company');
    expect(text).toContain('Acme Ltd');
  });

  it('rate-limits the public registration endpoint', async () => {
    resetLicenseServerLimits();
    const register = (i: number) =>
      t.app.request('/api/v1/public/installations/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instance_id: 'flood-instance-0001', email: `bot${i}@spam.test` }),
      });
    for (let i = 0; i < 5; i++) expect((await register(i)).status).toBe(202);
    const sixth = await register(5);
    expect(sixth.status).toBe(429);
    expect((await body(sixth)).error.code).toBe('rate_limited');
    resetLicenseServerLimits();
  });

  it('issues, renews, changes plan, emails and revokes licenses; the online check learns the revocation', async () => {
    const res = await t.api(owner).post('/platform/licenses', {
      plan: 'business',
      features: [...EDITION_FEATURES.business],
      licensee: 'Big Co',
      seats: 1,
      expires: '2027-06-30T23:59:59Z',
      instance_id: instance,
      email: 'buyer@big.test',
    });
    expect(res.status).toBe(200);
    const issued = await body(res);
    expect(issued).toMatchObject({ plan: 'business', seats: 1, support: 'standard', grace_days: 14, state: 'valid' });
    expect(issued.ref).toMatch(/^LIC-/);

    // Installed here: two active users (two accounts' admins) on one seat = a warning, features still on.
    const installed = await body(await t.api(owner).put('/platform/license', { key: issued.key }));
    expect(installed).toMatchObject({ state: 'valid', plan: 'business', seats: 1, seats_exceeded: true });
    expect(installed.seats_used).toBeGreaterThanOrEqual(2);
    expect(await licensedFeatures(t.db as never)).toEqual([...EDITION_FEATURES.business]);

    const renewed = await body(await t.api(owner).post(`/platform/licenses/${issued.id}/renew`));
    expect(renewed.ref).toBe(issued.ref);
    expect(renewed.expires.slice(0, 10)).toBe('2028-06-29');
    expect(renewed.key).not.toBe(issued.key);

    const changed = await body(await t.api(owner).post(`/platform/licenses/${issued.id}/plan`, { plan: 'enterprise' }));
    expect(changed).toMatchObject({ plan: 'enterprise', support: 'sla', features: [...EDITION_FEATURES.enterprise] });

    expect((await t.api(owner).post(`/platform/licenses/${issued.id}/email`, {})).status).toBe(200);
    expect(t.lastMailTo('buyer@big.test').text).toContain(changed.key);

    // The online check picks up the newer key (the plan change) for this license.
    const checked = await body(await t.api(owner).post('/platform/license/check'));
    expect(checked).toMatchObject({ state: 'valid', plan: 'enterprise' });
    expect(checked.checked_at).toBeTruthy();

    const revoked = await body(await t.api(owner).post(`/platform/licenses/${issued.id}/revoke`));
    expect(revoked.state).toBe('revoked');
    expect((await t.api(owner).post(`/platform/licenses/${issued.id}/renew`)).status).toBe(409);
    const after = await body(await t.api(owner).post('/platform/license/check'));
    expect(after).toMatchObject({ state: 'revoked', problem: 'revoked' });
    expect(await licensedFeatures(t.db as never)).toEqual([]);

    const list = (await body(await t.api(owner).get('/platform/licenses'))).data as Json[];
    // Two Registered: the reset test above had a new one signed in place of the stale key.
    expect(list.map((l) => l.plan).sort()).toEqual(['enterprise', 'registered', 'registered']);
  });

  it('records an opted-in heartbeat (and only then)', async () => {
    await t.api(owner).patch('/platform/licensing', { telemetry: true });
    calls.length = 0;
    expect(await sendHeartbeatIfDue(t.deps)).toBe('sent');
    expect(calls).toEqual([`${SERVER}/api/v1/public/installations/heartbeat`]);
    expect(await sendHeartbeatIfDue(t.deps)).toBe('not_due');
    const rows = (await body(await t.api(owner).get(`/platform/installations?q=${instance}`))).data as Json[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.last_seen_at).toBeTruthy();
    expect(row.active_users).toBeGreaterThanOrEqual(2);
    const s = await body(await t.api(owner).patch('/platform/licensing', { telemetry: false, server_url: null }));
    expect(s.telemetry.enabled).toBe(false);
  });
});

describe('a plain installation (not a license server, telemetry forced off)', () => {
  let t: TestContext;
  let owner: string;

  beforeAll(async () => {
    forgetLicense();
    t = await createTestContext({ env: { BINES_TELEMETRY: 'false', BINES_UPDATE_CHECK: 'false' } });
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  }, 180_000);
  afterAll(async () => {
    forgetLicense();
    await t.close();
  });

  it('has no license server: registration unavailable, nothing asked', async () => {
    const s = await body(await t.api(owner).get('/platform/licensing'));
    expect(s).toMatchObject({
      server_url: '',
      server_url_source: 'none',
      offline_register_url: null,
      registration: { status: 'unasked', ask: false },
      telemetry: { enabled: false, forced_off: true },
      update_check_forced_off: true,
    });
    expect(await body(await t.api(owner).get('/platform/registration/form'))).toEqual({
      available: false,
      captcha_site_key: null,
    });
    const res = await t.api(owner).post('/platform/registration', { email: 'a@b.test' });
    expect(res.status).toBe(503);
    expect((await body(res)).error.code).toBe('license_server_unavailable');
  });

  it('skip is remembered; reset asks again', async () => {
    const skipped = await body(await t.api(owner).post('/platform/registration/skip'));
    expect(skipped.registration).toMatchObject({ status: 'skipped', ask: false });
    expect((await body(await t.api(owner).get('/platform/licensing'))).registration.status).toBe('skipped');
    const reset = await body(await t.api(owner).post('/platform/registration/reset'));
    expect(reset.registration.status).toBe('unasked');
  });

  it('is not a license server: owner screens 503, public endpoints 404', async () => {
    expect(await body(await t.api(owner).get('/platform/license-server'))).toEqual({
      enabled: false,
      source: 'none',
      public_key: null,
      fingerprint: null,
    });
    expect((await t.api(owner).get('/platform/licenses')).status).toBe(503);
    expect((await t.api(owner).get('/platform/installations')).status).toBe(503);
    const pub = await t.app.request('/api/v1/public/installations/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance_id: 'some-instance-1234', email: 'a@b.test' }),
    });
    expect(pub.status).toBe(404);
    expect((await t.app.request('/api/v1/public/installations/config')).status).toBe(404);
  });

  it('never sends telemetry with BINES_TELEMETRY=false, even when the owner turns it on', async () => {
    await t.api(owner).patch('/platform/licensing', { telemetry: true, server_url: SERVER });
    expect(await sendHeartbeatIfDue(t.deps)).toBe('forced_off');
  });

  it('refuses the online check with BINES_UPDATE_CHECK=false', async () => {
    const res = await t.api(owner).post('/platform/license/check');
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe('update_check_disabled');
  });
});
