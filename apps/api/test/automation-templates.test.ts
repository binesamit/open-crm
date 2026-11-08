// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Product decision: custom automations saved as account templates — board references as slots picked again
 * on install (by type and title), a library admins manage and members use, and data packs that carry them.
 */
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
let sourceBoard: string;
let targetBoard: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie = admin, account = acmeId) => t.api(cookie, account);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const column = async (board: string, title: string, type: string) =>
  (await body(await as().post(`/boards/${board}/columns`, { title, type }))).id as string;

let automationId: string;
let templateId: string;
let stage: string;
let notes: string;

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  await as().post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await as().post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  vera = await join('vera@acme.test');
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  sourceBoard = (await body(await as().post('/boards', { name: 'Deals', workspace_id: wsId }))).id;
  targetBoard = (await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  stage = await column(sourceBoard, 'Stage', 'status');
  notes = await column(sourceBoard, 'Notes', 'text');
  await column(targetBoard, 'stage', 'status'); // same type, same title (case aside)
  await column(targetBoard, 'Other text', 'text');
  await column(targetBoard, 'Notes', 'text');
  const board = await body(await as().get(`/boards/${sourceBoard}`));
  const label = board.columns.find((c: Json) => c.id === stage).settings.labels[0].label as string;
  const res = await as().post(`/boards/${sourceBoard}/automations`, {
    title: 'Stage → notes',
    is_active: false,
    recipe: {
      trigger: { type: 'status_changed', column: stage, labels: [label] },
      actions: [
        { type: 'set_column', column: notes, value: 'moved {item.name}' },
        { type: 'webhook', url: 'https://hooks.example.com/abc/very-secret', secret: 'shhhhhhhh' },
      ],
    },
  });
  expect(res.status).toBe(201);
  automationId = (await body(res)).id;
});
afterAll(() => t.close());

describe('account automation templates', () => {
  it('admins save any automation as a template; its board references become slots, secrets stay', async () => {
    expect((await as(bob).post(`/automations/${automationId}/save-as-template`, {})).status).toBe(403);
    const res = await as().post(`/automations/${automationId}/save-as-template`, { description: 'd' });
    expect(res.status).toBe(201);
    const tpl = await body(res);
    templateId = tpl.id;
    expect(tpl.name).toBe('Stage → notes');
    expect(tpl.slots.map((s: Json) => s.kind).sort()).toEqual(['column', 'column', 'label', 'text']);
    expect(JSON.stringify(tpl.recipe)).not.toContain('very-secret');
    expect(JSON.stringify(tpl.recipe)).not.toContain('shhhhhhhh');
  });

  it('members list and install; viewers do not; another account sees nothing', async () => {
    const list = await body(await as(bob).get('/automation-templates'));
    expect(list.can_manage).toBe(false);
    expect(list.data.map((x: Json) => x.id)).toEqual([templateId]);
    expect((await as(vera).get('/automation-templates')).status).toBe(403);
    expect((await body(await as(otherAdmin, otherId).get('/automation-templates'))).data).toEqual([]);
    expect((await as(otherAdmin, otherId).get(`/automation-templates/${templateId}`)).status).toBe(404);
  });

  it('install proposes by type and title, asks for what nothing fills, and saves a normal automation', async () => {
    const p = await body(await as(bob).post(`/automation-templates/${templateId}/proposal`, { board_id: targetBoard }));
    const target = await body(await as().get(`/boards/${targetBoard}`));
    const byTitle = (title: string) => target.columns.find((c: Json) => c.title === title).id;
    const v = Object.fromEntries(p.slots.map((s: Json) => [s.id, s.value]));
    expect(v[`column:main:${stage}`]).toBe(byTitle('stage'));
    expect(v[`column:main:${notes}`]).toBe(byTitle('Notes'));
    const url = p.slots.find((s: Json) => s.kind === 'text');
    expect(url.value).toBeNull();
    // The hook URL is a blank nothing fills: 422 until it is given.
    const missing = await as(bob).post(`/automation-templates/${templateId}/install`, { board_id: targetBoard });
    expect(missing.status).toBe(422);
    expect((await body(missing)).error.details.issues[0].code).toBe('slot_unfilled');
    const res = await as(bob).post(`/automation-templates/${templateId}/install`, {
      board_id: targetBoard,
      mapping: { [url.id]: 'https://example.com/hook' },
    });
    expect(res.status).toBe(201);
    const made = await body(res);
    expect(made).toMatchObject({ board_id: targetBoard, is_active: false, title: 'Stage → notes' });
    expect(made.recipe.trigger.column).toBe(byTitle('stage'));
    expect(made.recipe.actions[0]).toMatchObject({ column: byTitle('Notes') });
    expect(made.recipe.actions[1]).toMatchObject({ url: 'https://example.com/hook' });
    // A pick that does not fit the board is refused.
    const bad = await as(bob).post(`/automation-templates/${templateId}/install`, {
      board_id: targetBoard,
      mapping: { [url.id]: 'https://example.com/hook', [`column:main:${notes}`]: byTitle('stage') },
    });
    expect(bad.status).toBe(422);
  });

  it('admins edit and delete; members may too once the account allows it', async () => {
    expect((await as(bob).patch(`/automation-templates/${templateId}`, { name: 'x' })).status).toBe(403);
    await as().patch('/accounts/me', { settings: { permissions: { members_manage_automation_templates: true } } });
    const renamed = await as(bob).patch(`/automation-templates/${templateId}`, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect((await body(renamed)).name).toBe('Renamed');
    expect((await body(await as(bob).get('/automation-templates'))).can_manage).toBe(true);
    await as().patch('/accounts/me', { settings: { permissions: { members_manage_automation_templates: false } } });
    expect((await as(bob).del(`/automation-templates/${templateId}`)).status).toBe(403);
  });

  it('travel in a data pack to another account', async () => {
    const res = await as().post('/extensions/packs/export', {
      key: 'tpl-pack',
      name: 'Templates',
      board_ids: [sourceBoard],
      include_automations: false,
      automation_template_ids: [templateId],
    });
    expect(res.status).toBe(200);
    const manifest = await body(res);
    expect(manifest.data.automation_templates).toHaveLength(1);
    const installed = await t.api(otherAdmin, otherId).post('/extensions/install', {
      source: { manifest },
      consent: { accept: true, scopes: [] },
    });
    expect(installed.status).toBe(201);
    const list = await body(await as(otherAdmin, otherId).get('/automation-templates'));
    expect(list.data.map((x: Json) => x.name)).toEqual(['Renamed']);
    expect(list.data[0].pack_key).toBe('t1');
  });

  it('delete removes it from the library', async () => {
    expect((await as().del(`/automation-templates/${templateId}`)).status).toBe(200);
    expect((await body(await as().get('/automation-templates'))).data).toEqual([]);
  });
});
