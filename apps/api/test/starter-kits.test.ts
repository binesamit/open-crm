// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { boards, folders, workspaces } from '../src/db/schema';
import { seedCatalogPacks } from '../src/modules/extensions/packs';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * M11 stage 3 (product decision) — starter kits as data: the platform owner saves boards of an account they
 * administer as a kit, edits it (workspace name, folders, boards, default), previews it, picks it when creating an
 * account, restores an earlier version and removes it — no code, no file. Seeding never overwrites or brings back
 * what the owner changed. The kit file names no workspace: a new account's first workspace takes its own name.
 */
let t: TestContext;
let owner: string;
let sourceId: string;
let strangerId: string;
let leads: string;
let notes: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const newAccount = async (name: string, slug: string, templateSet: string, email = `admin@${slug}.test`) =>
  t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: templateSet });
const layoutOf = async (accountId: string) => {
  const ws = await t.db.select().from(workspaces).where(eq(workspaces.accountId, accountId));
  const fs = await t.db.select().from(folders).where(eq(folders.accountId, accountId)).orderBy(asc(folders.position));
  const bs = await t.db.select().from(boards).where(eq(boards.accountId, accountId));
  const top = bs.filter((b) => !b.parentBoardId);
  return {
    workspaces: ws.map((w) => w.name),
    folders: fs.map((f) => f.name),
    boards: Object.fromEntries(top.map((b) => [b.name, fs.find((f) => f.id === b.folderId)?.name ?? null])),
  };
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  // The owner administers "Source" (they are its first admin) — not "Stranger".
  sourceId = (await body(await newAccount('Source', 'source', 'empty', OWNER_EMAIL))).account.id;
  expect((await t.api(owner).post('/invitations/accept', { token: t.inviteTokenFor(OWNER_EMAIL) })).status).toBe(200);
  strangerId = (await body(await newAccount('Stranger', 'stranger', 'empty'))).account.id;

  const as = t.api(owner, sourceId);
  const wsId = (await body(await as.get('/workspaces'))).data[0].id;
  const sales = await body(await as.post('/folders', { workspace_id: wsId, name: 'Sales' }));
  leads = (await body(await as.post('/boards', { name: 'Leads', workspace_id: wsId, folder_id: sales.id }))).id;
  notes = (await body(await as.post('/boards', { name: 'Notes', workspace_id: wsId }))).id;
  expect((await as.post(`/boards/${leads}/columns`, { id: 'stage', title: 'Stage', type: 'status' })).status).toBe(201);
});
afterAll(() => t.close());

describe('starter kits as data (M11 stage 3)', () => {
  it('the bines kit names no workspace: a new account opens in a workspace with its own name', async () => {
    const res = await newAccount('Client Zero', 'client-zero', 'bines');
    expect(res.status).toBe(201);
    const l = await layoutOf((await body(res)).account.id);
    expect(l.workspaces).toEqual(['Client Zero']);
    expect(l.folders[0]).toBe('01 · מכירות');
  });

  it('lists the boards of an account the owner administers — never of another account', async () => {
    const res = await t.api(owner).get(`/platform/accounts/${sourceId}/kit-boards`);
    expect(res.status).toBe(200);
    const rows = (await body(res)).data as Json[];
    expect(rows.find((b) => b.id === leads)).toMatchObject({ name: 'Leads', folder: 'Sales' });
    expect(rows.find((b) => b.id === notes)).toMatchObject({ name: 'Notes', folder: null });
    expect((await t.api(owner).get(`/platform/accounts/${strangerId}/kit-boards`)).status).toBe(403);
  });

  it('saves boards as a kit (with their folders), previews it, and a new account opens with it', async () => {
    const res = await t.api(owner).post('/platform/starter-kits', {
      key: 'agency',
      name: 'Agency kit',
      description: 'For agencies',
      account_id: sourceId,
      board_ids: [leads, notes],
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const kit = await body(res);
    expect(kit).toMatchObject({
      key: 'agency',
      name: 'Agency kit',
      description: 'For agencies',
      version: '1.0.0',
      default: false,
      workspace_name: null,
      folders: ['Sales'],
      all_builtin_templates: null,
    });
    expect(kit.boards).toEqual([
      { template: 'agency_1', name: 'Leads', folder: 'Sales', source: 'kit', listed: true },
      { template: 'agency_2', name: 'Notes', folder: null, source: 'kit', listed: true },
    ]);
    expect(kit.versions.map((v: Json) => [v.version, v.note])).toEqual([['1.0.0', 'from_boards']]);
    // From another account's boards: refused. The same key twice: refused.
    expect(
      (
        await t.api(owner).post('/platform/starter-kits', {
          key: 'stolen',
          name: 'x',
          account_id: strangerId,
          board_ids: [leads],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t
          .api(owner)
          .post('/platform/starter-kits', { key: 'agency', name: 'x', account_id: sourceId, board_ids: [leads] })
      ).status,
    ).toBe(409);

    const list = (await body(await t.api(owner).get('/platform/starter-kits'))).data as Json[];
    expect(list.find((k) => k.key === 'agency')).toMatchObject({ version: '1.0.0', folders: 1, boards: 2 });

    const created = await newAccount('Client One', 'client-one', 'agency');
    expect(created.status).toBe(201);
    expect(await layoutOf((await body(created)).account.id)).toEqual({
      workspaces: ['Client One'],
      folders: ['Sales'],
      boards: { Leads: 'Sales', Notes: null },
    });
  });

  it('edits it in the console: workspace name, folders, boards — each save a new version', async () => {
    const patch = (b: Json) => t.api(owner).patch('/platform/starter-kits/agency', b);
    expect((await patch({ boards: [{ template: 'nope' }] })).status).toBe(422);
    expect((await patch({ boards: [{ template: 'agency_1', folder: 'Nowhere' }] })).status).toBe(422);
    const res = await patch({
      workspace_name: 'Projects',
      folders: ['Sales', 'Ops'],
      boards: [
        { template: 'agency_1', folder: 'Sales' },
        { template: 'agency_2', folder: 'Ops' },
      ],
    });
    expect(res.status).toBe(200);
    const kit = await body(res);
    expect(kit).toMatchObject({ version: '1.1.0', workspace_name: 'Projects', folders: ['Sales', 'Ops'] });
    expect(kit.versions.map((v: Json) => v.version)).toEqual(['1.1.0', '1.0.0']);
    const created = await newAccount('Client Two', 'client-two', 'agency');
    expect(await layoutOf((await body(created)).account.id)).toEqual({
      workspaces: ['Projects'],
      folders: ['Sales', 'Ops'],
      boards: { Leads: 'Sales', Notes: 'Ops' },
    });
  });

  it('one default kit at a time; a seeded kit edited once keeps its seeded version; a deploy does not overwrite it', async () => {
    const bines = await body(await t.api(owner).get('/platform/starter-kits/bines'));
    expect(bines.default).toBe(true);
    expect(bines.workspace_name).toBeNull();
    expect(bines.boards.length).toBeGreaterThan(5);
    expect((await t.api(owner).patch('/platform/starter-kits/agency', { default: true })).status).toBe(200);
    const after = await body(await t.api(owner).get('/platform/starter-kits/bines'));
    expect(after.default).toBe(false);
    expect(after.versions.map((v: Json) => v.note)).toEqual(['default_moved', 'seeded']);
    // `default` opens with the agency kit now.
    const created = await newAccount('Client Three', 'client-three', 'default');
    expect((await layoutOf((await body(created)).account.id)).folders).toEqual(['Sales', 'Ops']);
    // The next deploy seeds the packs again: the owner's change stays.
    await seedCatalogPacks(t.db as unknown as Db, '../../seed/packs');
    expect((await body(await t.api(owner).get('/platform/starter-kits/bines'))).default).toBe(false);
  });

  it('restores an earlier version as a new one', async () => {
    const kit = await body(await t.api(owner).get('/platform/starter-kits/agency'));
    const first = kit.versions.find((v: Json) => v.version === '1.0.0');
    const res = await t.api(owner).post(`/platform/starter-kits/agency/versions/${first.id}/restore`, {});
    expect(res.status).toBe(200);
    const restored = await body(res);
    expect(restored).toMatchObject({ version: '1.3.0', workspace_name: null, folders: ['Sales'], default: false });
    expect(restored.versions[0]).toMatchObject({ version: '1.3.0', note: 'restored' });
  });

  it('removes a kit: no new account opens with it, and a deploy does not bring a seeded one back', async () => {
    expect((await t.api(owner).del('/platform/starter-kits/agency')).status).toBe(200);
    expect((await t.api(owner).get('/platform/starter-kits/agency')).status).toBe(404);
    expect((await newAccount('Client Four', 'client-four', 'agency')).status).toBe(422);
    expect((await t.api(owner).del('/platform/starter-kits/crm-starter')).status).toBe(200);
    await seedCatalogPacks(t.db as unknown as Db, '../../seed/packs');
    const keys = ((await body(await t.api(owner).get('/platform/starter-kits'))).data as Json[]).map((k) => k.key);
    expect(keys).not.toContain('crm-starter');
    expect(keys).not.toContain('agency');
  });

  it('is the platform owner’s only', async () => {
    const email = 'admin@client-one.test';
    const someone = t.cookieFrom(await t.signUpWithPassword(email, t.inviteTokenFor(email)))!;
    expect((await t.api(someone).get('/platform/starter-kits/bines')).status).toBe(404);
    expect((await t.api(someone).patch('/platform/starter-kits/bines', { name: 'x' })).status).toBe(404);
  });
});
