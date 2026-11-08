// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EDITION_FEATURES,
  EE_FEATURE_KEYS,
  featureAllowed,
  licenseBanner,
  LICENSED_FEATURE_KEYS,
  PLAN_FEATURE_KEYS,
} from '@bines/shared';
import { trustLicensePublicKeyForTests, verifyLicenseKey } from '../src/modules/license/license-key';
import { forgetLicense, licensedFeatures, licenseStatus } from '../src/modules/license/license.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Enterprise license keys (LICENSING-OPTIONS B — the structure only): offline Ed25519 verification (valid, expired,
 * tampered, wrong key, malformed), the owner console's GET / PUT / DELETE /platform/license (owner only), the
 * license as a second source of the feature gates (`featureAllowed`), and `license_features` on /me/accounts.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const pair = () => generateKeyPairSync('ed25519');
const pem = (k: KeyObject) => k.export({ type: 'spki', format: 'pem' }).toString();
const makeKey = (privateKey: KeyObject, payload: Record<string, unknown>) => {
  const signed = `lic1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
};
const licensor = pair();
const stranger = pair();
const NOW = new Date('2026-10-08T12:00:00Z');
const payload = { licensee: 'Acme Ltd', features: ['sso'], expires: '2027-01-01T00:00:00Z', id: 'ACME-1' };

describe('verifyLicenseKey', () => {
  const pub = pem(licensor.publicKey);

  it('accepts a key signed by the licensor, before it expires (an old key: no plan / seats / instance / grace)', () => {
    const res = verifyLicenseKey(makeKey(licensor.privateKey, payload), pub, NOW);
    expect(res).toEqual({ ok: true, payload, phase: 'valid' });
    // Old keys bind to no installation: any instance id is fine.
    expect(verifyLicenseKey(makeKey(licensor.privateKey, payload), pub, NOW, 'any-instance-1').ok).toBe(true);
  });

  it('accepts a key that never expires (expires: null)', () => {
    const res = verifyLicenseKey(makeKey(licensor.privateKey, { ...payload, expires: null }), pub, NOW);
    expect(res).toMatchObject({ ok: true, phase: 'valid' });
  });

  it('states over time: valid → expiring (30 days) → grace (14 days by default) → expired', () => {
    const key = makeKey(licensor.privateKey, payload);
    const at = (iso: string) => verifyLicenseKey(key, pub, new Date(iso));
    expect(at('2026-12-01T00:00:00Z')).toMatchObject({ ok: true, phase: 'valid' });
    expect(at('2026-12-15T00:00:00Z')).toMatchObject({ ok: true, phase: 'expiring' });
    expect(at('2027-01-01T00:00:00Z')).toMatchObject({ ok: true, phase: 'grace' });
    expect(at('2027-01-14T23:00:00Z')).toMatchObject({ ok: true, phase: 'grace' });
    expect(at('2027-01-15T00:00:00Z')).toEqual({ ok: false, problem: 'expired', payload });
  });

  it('honours the key’s own grace_days (0 = none)', () => {
    const key = makeKey(licensor.privateKey, { ...payload, grace_days: 0 });
    expect(verifyLicenseKey(key, pub, new Date('2027-01-01T00:00:01Z'))).toMatchObject({
      ok: false,
      problem: 'expired',
    });
    const long = makeKey(licensor.privateKey, { ...payload, grace_days: 60 });
    expect(verifyLicenseKey(long, pub, new Date('2027-02-15T00:00:00Z'))).toMatchObject({ ok: true, phase: 'grace' });
  });

  it('refuses a key made for another installation (instance_id), accepts it on its own', () => {
    const key = makeKey(licensor.privateKey, { ...payload, plan: 'business', seats: 5, instance_id: 'inst-aaaa-1111' });
    expect(verifyLicenseKey(key, pub, NOW, 'inst-bbbb-2222')).toMatchObject({
      ok: false,
      problem: 'instance_mismatch',
    });
    expect(verifyLicenseKey(key, pub, NOW, 'inst-aaaa-1111')).toMatchObject({ ok: true, phase: 'valid' });
  });

  it('refuses a tampered payload (features or expiry changed after signing)', () => {
    const key = makeKey(licensor.privateKey, payload);
    const [prefix, , sig] = key.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, features: ['sso', 'audit'], expires: null })).toString(
      'base64url',
    );
    expect(verifyLicenseKey(`${prefix}.${forged}.${sig}`, pub, NOW)).toEqual({ ok: false, problem: 'bad_signature' });
  });

  it('refuses a tampered signature', () => {
    const key = makeKey(licensor.privateKey, payload);
    const flipped = key.slice(0, -2) + (key.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyLicenseKey(flipped, pub, NOW).ok).toBe(false);
  });

  it('refuses a key signed with another private key', () => {
    expect(verifyLicenseKey(makeKey(stranger.privateKey, payload), pub, NOW)).toEqual({
      ok: false,
      problem: 'bad_signature',
    });
  });

  it('refuses the embedded key for a key signed by someone else (no override)', () => {
    expect(verifyLicenseKey(makeKey(stranger.privateKey, payload), undefined, NOW).ok).toBe(false);
  });

  it('refuses malformed keys and signed-but-invalid payloads', () => {
    for (const k of ['', 'lic1', 'lic1.a', 'lic2.abc.def', 'lic1.a b.c', 'lic1.abc.def.ghi'])
      expect(verifyLicenseKey(k, pub, NOW)).toEqual({ ok: false, problem: 'malformed' });
    const noLicensee = makeKey(licensor.privateKey, { features: [], expires: null });
    expect(verifyLicenseKey(noLicensee, pub, NOW)).toEqual({ ok: false, problem: 'bad_payload' });
    const signedJunk = (() => {
      const signed = `lic1.${Buffer.from('not json').toString('base64url')}`;
      return `${signed}.${sign(null, Buffer.from(signed), licensor.privateKey).toString('base64url')}`;
    })();
    expect(verifyLicenseKey(signedJunk, pub, NOW)).toEqual({ ok: false, problem: 'bad_payload' });
  });
});

describe('featureAllowed — the license as a second source of the gates', () => {
  const EE = ['sso'];
  it('only new features are licensed — nothing that exists today (the editions)', () => {
    expect([...EE_FEATURE_KEYS]).toEqual([...LICENSED_FEATURE_KEYS]);
    for (const k of PLAN_FEATURE_KEYS) expect(EE_FEATURE_KEYS).not.toContain(k);
    expect(EDITION_FEATURES.unregistered).toEqual([]);
    expect(EDITION_FEATURES.registered).toEqual(['template_library', 'update_check', 'scheduled_backup']);
    for (const k of ['saml', 'oidc', 'scim', 'environments', 'custom_roles'])
      expect(EDITION_FEATURES.business).toContain(k);
    for (const k of ['log_streaming', 'external_secrets', 'multi_api', 'embed']) {
      expect(EDITION_FEATURES.business).not.toContain(k);
      expect(EDITION_FEATURES.enterprise).toContain(k);
    }
    // Every edition includes the one below it.
    for (const k of EDITION_FEATURES.registered) expect(EDITION_FEATURES.business).toContain(k);
    for (const k of EDITION_FEATURES.business) expect(EDITION_FEATURES.enterprise).toContain(k);
  });
  it('a core feature follows the plan only', () => {
    expect(featureAllowed(null, [], 'ai', EE)).toBe(true);
    expect(featureAllowed(['guests'], ['ai'], 'ai', EE)).toBe(false);
  });
  it('an enterprise feature opens with the license OR an explicit plan listing — never by "everything"', () => {
    expect(featureAllowed(null, [], 'sso', EE)).toBe(false);
    expect(featureAllowed([], [], 'sso', EE)).toBe(false);
    expect(featureAllowed(null, ['sso'], 'sso', EE)).toBe(true);
    expect(featureAllowed(['sso'], [], 'sso', EE)).toBe(true);
    expect(featureAllowed(['ai'], ['ai'], 'sso', EE)).toBe(false);
  });
});

describe('owner console: /platform/license', () => {
  let t: TestContext;
  let owner: string;
  let stranger2: string;
  const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

  beforeAll(async () => {
    trustLicensePublicKeyForTests(pem(licensor.publicKey));
    forgetLicense();
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    // A non-owner: the first admin of an account the owner makes.
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'empty',
    });
    const token = t.inviteTokenFor('admin@acme.test');
    stranger2 = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
    await t.api(stranger2).post('/invitations/accept', { token });
    // A second active person: the seats test needs two.
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
    trustLicensePublicKeyForTests(null);
    forgetLicense();
    await t.close();
  });

  it('is 404 to anyone but the platform owner', async () => {
    expect((await t.api(stranger2).get('/platform/license')).status).toBe(404);
    expect(
      (await t.api(stranger2).put('/platform/license', { key: makeKey(licensor.privateKey, payload) })).status,
    ).toBe(404);
  });

  it('starts with no license', async () => {
    const res = await t.api(owner).get('/platform/license');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      state: 'none',
      licensee: null,
      features: [],
      ee_features: [...LICENSED_FEATURE_KEYS],
      plan: null,
      seats_exceeded: false,
    });
    const me = (await body(await t.api(stranger2).get('/me/accounts'))).data as Json[];
    expect(me.length).toBeGreaterThan(0);
    for (const a of me) expect(a.license_features).toEqual([]);
  });

  it('refuses a key that does not verify (400 license_invalid {problem})', async () => {
    const res = await t.api(owner).put('/platform/license', { key: makeKey(stranger.privateKey, payload) });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatchObject({ code: 'license_invalid', details: { problem: 'bad_signature' } });
    const expired = makeKey(licensor.privateKey, { ...payload, expires: '2020-01-01T00:00:00Z' });
    const res2 = await t.api(owner).put('/platform/license', { key: expired });
    expect((await body(res2)).error.details).toEqual({ problem: 'expired' });
  });

  it('installs a valid key, shows its status, and reports its features on /me/accounts', async () => {
    const key = makeKey(licensor.privateKey, { ...payload, expires: '2099-01-01T00:00:00Z' });
    const res = await t.api(owner).put('/platform/license', { key });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      state: 'valid',
      problem: null,
      licensee: 'Acme Ltd',
      features: ['sso'],
      id: 'ACME-1',
    });
    expect((await body(await t.api(owner).get('/platform/license'))).state).toBe('valid');
    const me = (await body(await t.api(stranger2).get('/me/accounts'))).data as Json[];
    expect(me.length).toBeGreaterThan(0);
    for (const a of me) expect(a.license_features).toEqual(['sso']);
  });

  it('refuses a key made for another installation', async () => {
    const key = makeKey(licensor.privateKey, { ...payload, expires: null, instance_id: 'another-instance-1' });
    const res = await t.api(owner).put('/platform/license', { key });
    expect(res.status).toBe(400);
    expect((await body(res)).error.details).toEqual({ problem: 'instance_mismatch' });
  });

  it('the card over time: valid → expiring → grace (still on) → expired (only the licensed features off)', async () => {
    const mine = (await body(await t.api(owner).get('/platform/license'))).instance_id as string;
    const key = makeKey(licensor.privateKey, {
      ...payload,
      features: ['saml'],
      expires: '2099-03-01T00:00:00Z',
      plan: 'business',
      seats: 50,
      instance_id: mine,
      support: 'standard',
    });
    const installed = await body(await t.api(owner).put('/platform/license', { key }));
    expect(installed).toMatchObject({
      state: 'valid',
      plan: 'business',
      seats: 50,
      seats_exceeded: false,
      support: 'standard',
      key_instance_id: mine,
      grace_days: null,
      grace_ends: '2099-03-15T00:00:00.000Z',
      checked_at: null,
    });
    const at = (iso: string) => licenseStatus(t.db as never, new Date(iso));
    const expiring = await at('2099-02-10T00:00:00Z');
    expect(expiring).toMatchObject({ state: 'expiring', days_left: 19 });
    expect(licenseBanner(expiring)).toBe('expiring');
    const grace = await at('2099-03-05T00:00:00Z');
    expect(grace).toMatchObject({ state: 'grace', days_left: 10, problem: null });
    expect(licenseBanner(grace)).toBe('grace');
    expect(await licensedFeatures(t.db as never, new Date('2099-03-05T00:00:00Z'))).toEqual(['saml']);
    const expired = await at('2099-03-16T00:00:00Z');
    expect(expired).toMatchObject({ state: 'expired', problem: 'expired', features: ['saml'] });
    expect(licenseBanner(expired)).toBe('expired');
    expect(await licensedFeatures(t.db as never, new Date('2099-03-16T00:00:00Z'))).toEqual([]);
    // Nothing else changed: the accounts still answer as before.
    expect((await t.api(stranger2).get('/me/accounts')).status).toBe(200);
  });

  it('above the seats: a warning only', async () => {
    const key = makeKey(licensor.privateKey, { ...payload, features: ['saml'], expires: null, seats: 1 });
    const s = await body(await t.api(owner).put('/platform/license', { key }));
    expect(s.seats_used).toBeGreaterThanOrEqual(2);
    expect(s).toMatchObject({ state: 'valid', seats: 1, seats_exceeded: true });
    expect(licenseBanner(s as never)).toBe('seats');
    const me = (await body(await t.api(stranger2).get('/me/accounts'))).data as Json[];
    for (const a of me) expect(a.license_features).toEqual(['saml']);
  });

  it('removes the key', async () => {
    const res = await t.api(owner).del('/platform/license');
    expect(res.status).toBe(200);
    expect((await body(res)).state).toBe('none');
  });
});
