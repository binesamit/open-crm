// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetExtensionOrigins } from '../src/modules/extensions/ext-origins';
import { findInstallation } from '../src/modules/extensions/extensions.repo';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Where an installation works: the whole account, chosen workspaces (their boards now and later)
 * and / or chosen boards — their union. Views, item tabs, actions, automation blocks, widgets and tokens follow it.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let wsA: string;
let wsB: string;
let a1: string; // in workspace A
let b1: string; // in workspace B, chosen by itself
let b2: string; // in workspace B, not chosen
let instId: string;
const EXT_ORIGIN = 'http://127.0.0.1:3997';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const manifest = {
  manifest_version: 1,
  id: 'scoped',
  name: 'תוסף מוגבל',
  version: '1.0.0',
  publisher: { name: 'Bines Labs' },
  permissions: ['boards:read'],
  origins: [EXT_ORIGIN],
  features: [
    { type: 'board_view', key: 'view', name: 'תצוגה', url: `${EXT_ORIGIN}/index.html` },
    { type: 'item_view', key: 'tab', name: 'לשונית', url: `${EXT_ORIGIN}/item.html` },
    { type: 'dashboard_widget', key: 'widget', name: 'ווידג׳ט', url: `${EXT_ORIGIN}/widget.html` },
    { type: 'automation_trigger', key: 'incoming', name: 'נכנס', payload_fields: [{ key: 'text', label: 'טקסט' }] },
  ],
};

const features = async (q: string) =>
  ((await body(await t.api(admin, acmeId).get(`/extensions/features${q}`))).data as Json[]).map(
    (f) => `${f.type}:${f.feature}`,
  );
const views = async (board: string) =>
  ((await body(await t.api(admin, acmeId).get(`/extensions/board-views?board_id=${board}`))).data as Json[]).length;
const blocks = async (board: string) =>
  ((await body(await t.api(admin, acmeId).get(`/extensions/automation-blocks?board_id=${board}`))).triggers as Json[])
    .length;
const mint = async (board: string) =>
  (await t.api(admin, acmeId).post(`/extensions/installations/${instId}/token`, { feature: 'view', board_id: board }))
    .status;
const patch = (input: Json) => t.api(admin, acmeId).patch(`/extensions/installations/${instId}`, input);

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  wsA = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  wsB = (await body(await t.api(admin, acmeId).post('/workspaces', { name: 'B' }))).id;
  const mk = async (name: string, ws: string) =>
    (await body(await t.api(admin, acmeId).post('/boards', { name, workspace_id: ws }))).id as string;
  a1 = await mk('A1', wsA);
  b1 = await mk('B1', wsB);
  b2 = await mk('B2', wsB);
  const res = await t.api(admin, acmeId).post('/extensions/install', {
    source: { manifest },
    consent: { accept: true, scopes: ['boards:read'], workspace_ids: [wsA], board_ids: [b1] },
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  instId = (await body(res)).id;
  forgetExtensionOrigins();
});
afterAll(async () => {
  await t.close();
});

describe('installation scope: workspaces and / or boards', () => {
  it('keeps the chosen workspaces with the installation', async () => {
    const inst = ((await body(await t.api(admin, acmeId).get('/extensions'))).installed as Json[])[0];
    expect(inst).toMatchObject({ workspace_ids: [wsA], board_ids: [b1] });
  });

  it('shows board features on boards of a chosen workspace and on chosen boards only', async () => {
    expect(await features(`?board_id=${a1}`)).toEqual(['board_view:view', 'item_view:tab', 'dashboard_widget:widget']);
    expect(await features(`?board_id=${b1}`)).toEqual(['board_view:view', 'item_view:tab', 'dashboard_widget:widget']);
    expect(await features(`?board_id=${b2}`)).toEqual(['dashboard_widget:widget']);
    expect([await views(a1), await views(b1), await views(b2)]).toEqual([1, 1, 0]);
    expect([await blocks(a1), await blocks(b1), await blocks(b2)]).toEqual([1, 1, 0]);
    expect([await mint(a1), await mint(b1), await mint(b2)]).toEqual([200, 200, 403]);
  });

  it('a board added to a chosen workspace later is in scope at once', async () => {
    const a2 = (await body(await t.api(admin, acmeId).post('/boards', { name: 'A2', workspace_id: wsA }))).id as string;
    expect(await views(a2)).toBe(1);
    expect(await mint(a2)).toBe(200);
  });

  it("offers a widget on a workspace's dashboards only where it works there", async () => {
    // Workspace B: not chosen, but one of its boards is.
    expect(await features(`?type=dashboard_widget&workspace_id=${wsB}`)).toEqual(['dashboard_widget:widget']);
    expect((await patch({ board_ids: null })).status).toBe(200);
    expect(await features(`?type=dashboard_widget&workspace_id=${wsB}`)).toEqual([]);
    expect(await features(`?type=dashboard_widget&workspace_id=${wsA}`)).toEqual(['dashboard_widget:widget']);
    // Only a workspace chosen: the boards elsewhere are out (never "every board").
    expect([await views(a1), await views(b1)]).toEqual([1, 0]);
  });

  it('changes the scope after install; an unknown workspace is refused; both empty = the whole account', async () => {
    expect((await patch({ workspace_ids: ['01ZZZZZZZZZZZZZZZZZZZZZZZZ'] })).status).toBe(422);
    const res = await patch({ workspace_ids: null, board_ids: [b2] });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ workspace_ids: null, board_ids: [b2] });
    expect([await views(a1), await views(b1), await views(b2)]).toEqual([0, 0, 1]);
    const row = await findInstallation(t.db, acmeId, instId);
    expect((row!.state as Json).workspace_ids).toBeUndefined();
    expect((await patch({ board_ids: null })).status).toBe(200);
    expect([await views(a1), await views(b1), await views(b2)]).toEqual([1, 1, 1]);
    expect(await features(`?type=dashboard_widget&workspace_id=${wsB}`)).toEqual(['dashboard_widget:widget']);
  });
});
