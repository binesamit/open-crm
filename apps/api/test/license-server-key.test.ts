// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetLicenseSigner } from '../src/modules/license/license-signing';
import { forgetLicense } from '../src/modules/license/license.service';
import { resetLicenseServerLimits } from '../src/modules/license/license-server.service';
import { setLicensingFetchForTests } from '../src/modules/license/licensing.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Any installation becomes a license server from the owner console (docs/LICENSING.md): the signing key is made and
 * sealed here, published at /public/licenses/key, trusted by this server for the keys it issues; another installation
 * stores the provider's key beside the server address (fetched when the address is saved) and then trusts the keys
 * that provider issues — and stops trusting them when the key is forgotten.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SERVER = 'http://provider.test';
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const issue = (t: TestContext, owner: string, instance: string | null) =>
  t.api(owner).post('/platform/licenses', {
    plan: 'business',
    features: [],
    licensee: 'Big Co',
    seats: 5,
    expires: '2099-06-30T23:59:59Z',
    instance_id: instance,
  });

describe('a license server made in the owner console', () => {
  let t: TestContext;
  let owner: string;
  let member: string;

  beforeAll(async () => {
    forgetLicense();
    forgetLicenseSigner();
    resetLicenseServerLimits();
    t = await createTestContext();
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
  }, 180_000);
  afterAll(async () => {
    forgetLicense();
    forgetLicenseSigner();
    await t.close();
  });

  it('starts as a plain installation: no signing key, the public key endpoint is 404', async () => {
    expect(await body(await t.api(owner).get('/platform/license-server'))).toEqual({
      enabled: false,
      source: 'none',
      public_key: null,
      fingerprint: null,
    });
    expect((await t.app.request('/api/v1/public/licenses/key')).status).toBe(404);
    expect((await t.api(member).post('/platform/license-server/key', {})).status).toBe(404);
  });

  it('creates a signing key once, publishes the public half, and issues keys it trusts itself', async () => {
    const made = await body(await t.api(owner).post('/platform/license-server/key', {}));
    expect(made.enabled).toBe(true);
    expect(made.source).toBe('setting');
    expect(made.public_key).toContain('-----BEGIN PUBLIC KEY-----');
    expect(typeof made.fingerprint).toBe('string');
    expect((await t.api(owner).post('/platform/license-server/key', {})).status).toBe(409);

    const pub = await body(await t.app.request('/api/v1/public/licenses/key'));
    expect(pub).toEqual({ public_key: made.public_key, fingerprint: made.fingerprint });

    const issued = await body(await issue(t, owner, null));
    expect(issued.key).toMatch(/^lic1\./);
    const installed = await body(await t.api(owner).put('/platform/license', { key: issued.key }));
    expect(installed.state).toBe('valid');
    expect(installed.plan).toBe('business');
  });

  it('removing the key leaves the installed license invalid and the server plain again', async () => {
    const gone = await body(await t.api(owner).del('/platform/license-server/key'));
    expect(gone).toMatchObject({ enabled: false, source: 'none', public_key: null });
    forgetLicense();
    expect((await body(await t.api(owner).get('/platform/license'))).state).toBe('invalid');
    expect((await t.app.request('/api/v1/public/licenses/key')).status).toBe(404);
  });
});

describe("an installation trusting its provider's key", () => {
  let provider: TestContext;
  let client: TestContext;
  let providerOwner: string;
  let clientOwner: string;
  let providerKey: Json;

  beforeAll(async () => {
    forgetLicense();
    forgetLicenseSigner();
    resetLicenseServerLimits();
    provider = await createTestContext();
    providerOwner = (await provider.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    providerKey = await body(await provider.api(providerOwner).post('/platform/license-server/key', {}));
    client = await createTestContext();
    clientOwner = (await client.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    // The client's calls to its provider land on the provider's app.
    setLicensingFetchForTests(async (url, init) => provider.app.request(url.replace(SERVER, ''), init));
  }, 180_000);
  afterAll(async () => {
    setLicensingFetchForTests(null);
    forgetLicense();
    forgetLicenseSigner();
    await client.close();
    await provider.close();
  });

  it("fetches the provider's public key when the address is saved, then accepts the keys it issues", async () => {
    // Before: a key from that provider is not trusted here.
    const issued = await body(await issue(provider, providerOwner, null));
    const refused = await client.api(clientOwner).put('/platform/license', { key: issued.key });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error.details.problem).toBe('bad_signature');

    const settings = await body(await client.api(clientOwner).patch('/platform/licensing', { server_url: SERVER }));
    expect(settings.server_url).toBe(SERVER);
    expect(settings.server_public_key).toBe(providerKey.public_key);
    expect(settings.server_key_fingerprint).toBe(providerKey.fingerprint);

    const installed = await body(await client.api(clientOwner).put('/platform/license', { key: issued.key }));
    expect(installed.state).toBe('valid');
  });

  it('a pasted key must be readable; forgetting the key withdraws the trust', async () => {
    expect(
      (await client.api(clientOwner).patch('/platform/licensing', { server_public_key: 'not a key' })).status,
    ).toBe(400);
    const cleared = await body(await client.api(clientOwner).patch('/platform/licensing', { server_public_key: null }));
    expect(cleared.server_public_key).toBeNull();
    forgetLicense();
    expect((await body(await client.api(clientOwner).get('/platform/license'))).state).toBe('invalid');
    // Pasting it back (what an offline installation does) restores the trust.
    await client.api(clientOwner).patch('/platform/licensing', { server_public_key: providerKey.public_key });
    forgetLicense();
    expect((await body(await client.api(clientOwner).get('/platform/license'))).state).toBe('valid');
  });
});
