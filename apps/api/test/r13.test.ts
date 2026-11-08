// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boards, extensions, workspaces } from '../src/db/schema';
import { upsertAccountSettings } from '../src/modules/accounts/accounts.repo';
import { loadPacksFromDisk, seedCatalogPacks } from '../src/modules/extensions/packs';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Round 13: text size + table density per user (GET / PUT /me/appearance, the account default as a hook), the view's
 * hidden subitem columns, and the extension store — the first-party sample extensions seeded on their own origin,
 * the CRM starter pack, and "copy a pack to another account" through that account's own install path.
 */
let t: TestContext;
let owner: string;
let admin: string; // admin of Acme, later also admin of Other
let bob: string; // member of Acme
let acmeId: string;
let otherId: string;
let otherAdmin: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const SAMPLE_ORIGIN = 'http://127.0.0.1:3997';

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  // The samples, as `pnpm db:seed` with SAMPLE_EXTENSIONS_ORIGIN set would publish them.
  await seedCatalogPacks(t.db as never, '../../seed/packs', {
    sampleOrigin: SAMPLE_ORIGIN,
    env: { NODE_ENV: 'development', WEB_ORIGIN: 'http://localhost:5173' },
  });
});
afterAll(async () => {
  await t.close();
});

describe('appearance per user', () => {
  it('starts at normal / normal, saves for the user, and null goes back to the default', async () => {
    const a = await body(await t.api(bob).get('/me/appearance'));
    expect(a).toMatchObject({ text_size: 'normal', density: 'normal', user: {}, account_default: null });
    const put = await t.api(bob).put('/me/appearance', { text_size: 'xlarge', density: 'compact' });
    expect(put.status).toBe(200);
    expect(await body(put)).toMatchObject({ text_size: 'xlarge', density: 'compact' });
    // Every device (another request, no account): the same.
    expect(await body(await t.api(bob).get('/me/appearance'))).toMatchObject({
      text_size: 'xlarge',
      density: 'compact',
      user: { text_size: 'xlarge', density: 'compact' },
    });
    // Only one field changes; the other stays.
    expect(await body(await t.api(bob).put('/me/appearance', { density: 'comfortable' }))).toMatchObject({
      text_size: 'xlarge',
      density: 'comfortable',
    });
    expect(await body(await t.api(bob).put('/me/appearance', { text_size: null }))).toMatchObject({
      text_size: 'normal',
      density: 'comfortable',
      user: { density: 'comfortable' },
    });
    // It does not touch the other profile settings (the last account).
    await t.api(bob).put('/me/last-account', { account_id: acmeId });
    await t.api(bob).put('/me/appearance', { text_size: 'large' });
    expect((await body(await t.api(bob).get('/auth/me'))).last_account_id).toBe(acmeId);
  });

  it('refuses unknown values and anonymous calls', async () => {
    expect((await t.api(bob).put('/me/appearance', { text_size: 'huge' })).status).toBeGreaterThanOrEqual(400);
    expect((await t.api(undefined).get('/me/appearance')).status).toBe(401);
  });

  it("the account's default fills what the user did not choose — only for its members", async () => {
    await upsertAccountSettings(t.db as never, acmeId, { appearance: { text_size: 'large', density: 'compact' } });
    // admin chose nothing: the account's default.
    expect(await body(await t.api(admin, acmeId).get('/me/appearance'))).toMatchObject({
      text_size: 'large',
      density: 'compact',
      account_default: { text_size: 'large', density: 'compact' },
    });
    // Another account's admin naming Acme gets no default from it.
    expect(await body(await t.api(otherAdmin, acmeId).get('/me/appearance'))).toMatchObject({
      text_size: 'normal',
      account_default: null,
    });
    // bob's own choice wins (text size), the default fills the rest? He chose density earlier: his.
    const b = await body(await t.api(bob, acmeId).get('/me/appearance'));
    expect(b.text_size).toBe('large');
    expect(b.density).toBe('comfortable');
    await upsertAccountSettings(t.db as never, acmeId, {});
  });
});

describe('the view hides subitem columns', () => {
  it('saves subitems_hidden_columns with the view and reads it back', async () => {
    const board = await body(await t.api(admin, acmeId).post('/boards', { name: 'Hide subs', workspace_id: wsId }));
    const view = await body(
      await t.api(admin, acmeId).post(`/boards/${board.id}/views`, {
        name: 'No sub status',
        type: 'table',
        settings: { subitems_hidden_columns: ['status', 'date4'] },
      }),
    );
    expect(view.settings.subitems_hidden_columns).toEqual(['status', 'date4']);
    const patched = await t
      .api(admin, acmeId)
      .patch(`/views/${view.id}`, { settings: { ...view.settings, subitems_hidden_columns: ['person'] } });
    expect(patched.status).toBe(200);
    const list = await body(await t.api(admin, acmeId).get(`/boards/${board.id}/views`));
    const again = (list.data as Json[]).find((v) => v.id === view.id)!;
    expect(again.settings.subitems_hidden_columns).toEqual(['person']);
  });
});

describe('the extension store', () => {
  it('seeds the sample extensions on their own origin only — never without one, never on the app origin', () => {
    const keys = (o: Parameters<typeof loadPacksFromDisk>[1]) =>
      loadPacksFromDisk('../../seed/packs', o).map((m) => m.id);
    expect(keys({ sampleOrigin: null })).not.toContain('board-summary');
    expect(keys({ sampleOrigin: null })).toContain('crm-starter');
    const dev = { NODE_ENV: 'development' as const, WEB_ORIGIN: 'http://localhost:5173' };
    expect(keys({ sampleOrigin: SAMPLE_ORIGIN, env: dev })).toEqual(
      expect.arrayContaining(['board-summary', 'kanban-stats', 'fitness', 'crm-starter']),
    );
    // The app's own origin → refused (an extension there would get our cookies and DOM).
    expect(keys({ sampleOrigin: 'http://localhost:5173', env: dev })).not.toContain('board-summary');
    // Production: https and public only.
    const prod = { NODE_ENV: 'production' as const, WEB_ORIGIN: 'https://app.bines.test' };
    expect(keys({ sampleOrigin: SAMPLE_ORIGIN, env: prod })).not.toContain('kanban-stats');
    expect(keys({ sampleOrigin: 'https://app.bines.test', env: prod })).not.toContain('kanban-stats');
    expect(keys({ sampleOrigin: 'https://ext.bines.test', env: prod })).toContain('kanban-stats');
  });

  it('lists catalogue cards with publisher, features, permissions and a review for the code samples', async () => {
    const list = await body(await t.api(admin, acmeId).get('/extensions'));
    const card = (list.catalog as Json[]).find((c) => c.key === 'board-summary')!;
    expect(card).toMatchObject({
      kind: 'code',
      publisher: { name: 'Bines' },
      feature_types: ['board_view'],
      permissions: ['boards:read'],
      installed: false,
      installed_version: null,
    });
    expect((list.catalog as Json[]).find((c) => c.key === 'kanban-stats')!.feature_types).toEqual(['dashboard_widget']);
    const row = (
      await t.db
        .select()
        .from(extensions)
        .where(and(eq(extensions.key, 'kanban-stats'), isNull(extensions.accountId)))
    )[0]!;
    expect((row.review as Json).checks.least_scopes).toBe(true);
    expect(row.manifest.origins).toEqual([SAMPLE_ORIGIN]);
  });

  it('installs a sample from the catalogue through consent; its board view is then offered', async () => {
    const preview = await body(
      await t.api(admin, acmeId).post('/extensions/preview', { catalog_key: 'board-summary' }),
    );
    expect(preview.frame_origins).toEqual([SAMPLE_ORIGIN]);
    const res = await t.api(admin, acmeId).post('/extensions/install', {
      source: { catalog_key: 'board-summary' },
      consent: { accept: true, scopes: ['boards:read'] },
      manifest_digest: preview.digest,
    });
    expect(res.status).toBe(201);
    const board = await body(await t.api(admin, acmeId).post('/boards', { name: 'Summed', workspace_id: wsId }));
    const views = await body(await t.api(bob, acmeId).get(`/extensions/board-views?board_id=${board.id}`));
    expect((views.data as Json[]).map((v) => v.extension_key)).toContain('board-summary');
    const list = await body(await t.api(admin, acmeId).get('/extensions'));
    expect((list.catalog as Json[]).find((c) => c.key === 'board-summary')).toMatchObject({
      installed: true,
      installed_version: '1.0.0',
    });
    // Members never see the store.
    expect((await t.api(bob, acmeId).get('/extensions')).status).toBe(403);
  });

  it('the CRM starter pack makes a CRM workspace with its four boards', async () => {
    const preview = await body(await t.api(admin, acmeId).post('/extensions/preview', { catalog_key: 'crm-starter' }));
    expect(preview.kind).toBe('data');
    const res = await t.api(admin, acmeId).post('/extensions/install', {
      source: { catalog_key: 'crm-starter' },
      consent: { accept: true, scopes: [] },
      manifest_digest: preview.digest,
    });
    expect(res.status).toBe(201);
    const ws = (
      await t.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.accountId, acmeId), eq(workspaces.name, 'CRM')))
    )[0]!;
    const made = await t.db
      .select({ name: boards.name })
      .from(boards)
      .where(and(eq(boards.workspaceId, ws.id), isNull(boards.parentBoardId)));
    expect(made.map((b) => b.name).sort()).toEqual(['אנשי קשר', 'הזדמנויות', 'לידים', 'לקוחות'].sort());
  });

  it('copies a saved pack to another account only through that account’s install, by its admin', async () => {
    const src = await body(await t.api(admin, acmeId).post('/boards', { name: 'Pipeline', workspace_id: wsId }));
    const pack = await body(
      await t.api(admin, acmeId).post('/extensions/packs/export', {
        key: 'acme-pipeline',
        name: 'Acme pipeline',
        board_ids: [src.id],
        include_automations: true,
      }),
    );
    expect(pack.id).toBe('acme-pipeline');
    // Not a member of Other yet: the other account does not exist for this person.
    expect((await t.api(admin, otherId).post('/extensions/preview', { manifest: pack })).status).toBe(404);
    // A member (not an admin) of Other cannot install there either.
    await t.api(otherAdmin, otherId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
    await t.api(bob).post('/invitations/accept', { token: t.inviteTokenFor('bob@acme.test') });
    expect((await t.api(bob, otherId).post('/extensions/preview', { manifest: pack })).status).toBe(403);
    // Made an admin of Other: preview (the consent screen) then install, in Other.
    await t.api(otherAdmin, otherId).post('/users/invite', { emails: ['admin@acme.test'], role: 'admin' });
    await t.api(admin).post('/invitations/accept', { token: t.inviteTokenFor('admin@acme.test') });
    const preview = await body(await t.api(admin, otherId).post('/extensions/preview', { manifest: pack }));
    expect(preview.kind).toBe('data');
    expect(preview.existing).toBeNull();
    // Nothing exists in Other before the confirmation.
    const before = await t.db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, otherId), eq(boards.name, 'Pipeline')));
    expect(before).toHaveLength(0);
    const res = await t.api(admin, otherId).post('/extensions/install', {
      source: { manifest: pack },
      consent: { accept: true, scopes: [] },
      manifest_digest: preview.digest,
    });
    expect(res.status).toBe(201);
    const after = await t.db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, otherId), eq(boards.name, 'Pipeline')));
    expect(after).toHaveLength(1);
    // A changed manifest between the consent screen and the install is refused (EXT-RT3).
    const changed = await t.api(admin, otherId).post('/extensions/install', {
      source: { manifest: { ...pack, id: 'acme-pipeline-2', name: 'Other name' } },
      consent: { accept: true, scopes: [] },
      manifest_digest: preview.digest,
    });
    expect(changed.status).toBe(409);
  });
});
