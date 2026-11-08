// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSettingsSchema, newId, type RecipeInput } from '@bines/shared';
import { activityLog, automationRuns, automations, cells, updates } from '../src/db/schema';
import type { Db } from '../src/db/client';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { backfillPhoneCells } from '../src/modules/phone/phone.service';
import { smsDenied } from '../src/modules/phone/sms.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Plan: phone E.164 on write / settings change / backfill; SMS from items; send_sms; my click preference. */
let t: TestContext;
let admin: string;
let bob: string;
let vera: string;
let acmeId: string;
let adminId: string;
let boardId: string;
let phoneKey: string;
let textKey: string;
let secretKey: string;
let itemId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie = admin) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const setCell = (id: string, key: string, value: unknown) => as().put(`/items/${id}/cells/${key}`, { value });
const getItem = async (id: string) => body(await as().get(`/items/${id}`));
const patchSms = (sms: Json) => as().patch('/accounts/me', { settings: { sms } });

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  // S-46: custom senders apply at once here (sec2-senders.test.ts covers the owner's approval).
  await t.api(owner).patch('/platform/settings', { senders: { require_approval: false } });
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
  admin = await join('admin@acme.test');
  adminId = (await body(await t.api(admin).get('/auth/me'))).user.id;
  await as().post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as().post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  phoneKey = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'טלפון', type: 'phone' }))).id;
  textKey = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'עיר', type: 'text' }))).id;
  secretKey = (await body(await as().post(`/boards/${boardId}/columns`, { title: 'סוד', type: 'text' }))).id;
  itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Dana' }))).id;
  await setCell(itemId, textKey, 'חיפה');
  await setCell(itemId, secretKey, 'top-secret');
  await as().put(`/boards/${boardId}/columns/${secretKey}/restriction`, { kind: 'view' });
});
afterAll(() => t.close());

describe('phone normalisation (E.164)', () => {
  it('a new phone column has the click settings with their defaults', async () => {
    const board = await body(await as().get(`/boards/${boardId}`));
    const col = board.columns.find((c: Json) => c.id === phoneKey);
    expect(col.settings).toMatchObject({
      default_country: 'IL',
      click_actions_enabled: true,
      actions: ['whatsapp', 'telegram', 'call', 'sms', 'copy'],
      default_action: 'whatsapp',
    });
  });

  it('stores e164 + valid next to the number as typed; the text stays as typed', async () => {
    expect((await setCell(itemId, phoneKey, { phone: '050-123 4567' })).status).toBe(200);
    const cell = (await getItem(itemId)).cells[phoneKey];
    expect(cell.value).toMatchObject({ phone: '050-123 4567', e164: '+972501234567', valid: true });
    expect(cell.text).toBe('050-123 4567');
  });

  it('a client cannot plant its own e164; an extension number is kept but not valid', async () => {
    await setCell(itemId, phoneKey, { phone: '*2700', e164: '+15551234567', valid: true });
    const cell = (await getItem(itemId)).cells[phoneKey];
    expect(cell.value).toEqual({ phone: '*2700', valid: false });
  });

  it('a pasted number (direction marks, any dashes / spaces) is cleaned and read; nothing is refused', async () => {
    const pasted = `${String.fromCharCode(0x2066)}+972 54-123-4567${String.fromCharCode(0x2069)}`;
    expect((await setCell(itemId, phoneKey, { phone: pasted })).status).toBe(200);
    expect((await getItem(itemId)).cells[phoneKey].value).toMatchObject({
      phone: '+972 54-123-4567',
      e164: '+972541234567',
      valid: true,
    });
    for (const raw of ['541234567', `054${String.fromCharCode(0x2013)}1234567`, '(054) 123 4567'])
      expect((await setCell(itemId, phoneKey, { phone: raw })).status, raw).toBe(200);
    expect((await getItem(itemId)).cells[phoneKey].value.e164).toBe('+972541234567');
    // Not a number: kept as written and marked.
    expect((await setCell(itemId, phoneKey, { phone: 'שלוחה 12' })).status).toBe(200);
    expect((await getItem(itemId)).cells[phoneKey].value).toEqual({ phone: 'שלוחה 12', valid: false });
  });

  it('rejects invalid settings (default action outside the allowed actions)', async () => {
    const res = await as().patch(`/boards/${boardId}/columns/${phoneKey}`, {
      settings: { default_country: 'IL', actions: ['call', 'copy'], default_action: 'whatsapp' },
    });
    expect(res.status).toBe(400);
  });

  it('re-normalises stored cells when the default country changes', async () => {
    const other = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Joe' }))).id;
    await setCell(other, phoneKey, { phone: '(212) 555-0100' });
    expect((await getItem(other)).cells[phoneKey].value.valid).toBe(false); // read as Israeli
    const res = await as().patch(`/boards/${boardId}/columns/${phoneKey}`, {
      settings: { default_country: 'US', click_actions_enabled: true },
    });
    expect(res.status).toBe(200);
    expect((await getItem(other)).cells[phoneKey].value).toMatchObject({ e164: '+12125550100', valid: true });
    await as().patch(`/boards/${boardId}/columns/${phoneKey}`, { settings: { default_country: 'IL' } });
    await as().del(`/items/${other}`);
  });

  it('backfill: dry run counts, --apply writes, a second run changes nothing', async () => {
    await setCell(itemId, phoneKey, { phone: '+972 52-765-4321' });
    // A cell written before normalisation: no derived keys.
    await t.db
      .update(cells)
      .set({ value: { phone: '0521112222' } })
      .where(and(eq(cells.itemId, itemId), sql`${cells.value} ? 'phone'`));
    const db = t.db as unknown as Db;
    const dry = await backfillPhoneCells(db, { apply: false, accountId: acmeId });
    expect(dry.changed).toBeGreaterThanOrEqual(1);
    const [stillOld] = await t.db.select({ value: cells.value }).from(cells).where(eq(cells.itemId, itemId));
    expect(stillOld!.value).toEqual({ phone: '0521112222' });
    const applied = await backfillPhoneCells(db, { apply: true, accountId: acmeId });
    expect(applied.changed).toBe(dry.changed);
    expect((await getItem(itemId)).cells[phoneKey].value).toMatchObject({ e164: '+972521112222', valid: true });
    expect((await backfillPhoneCells(db, { apply: true, accountId: acmeId })).changed).toBe(0);
  });
});

describe('SMS from an item', () => {
  beforeAll(async () => {
    await setCell(itemId, phoneKey, { phone: '050-123 4567' });
    const res = await patchSms({
      sender_id: 'Acme',
      templates: [
        { id: 'hello', name: 'שלום', text: 'שלום {item.name} מ{item.' + textKey + '} {item.' + secretKey + '}' },
      ],
    });
    expect(res.status).toBe(200);
  });

  it('GET /sms/status: members may send by default; templates and budgets', async () => {
    const s = await body(await as(bob).get('/sms/status'));
    expect(s).toMatchObject({
      can_send: true,
      reason: null,
      provider_ready: true,
      send_policy: 'members',
      limits: { per_user_per_hour: 30, per_account_per_day: 500 },
      account_country: 'IL',
    });
    expect(s.templates.map((x: Json) => x.id)).toEqual(['hello']);
    expect((await body(await as(vera).get('/sms/status'))).reason).toBe('members_only');
  });

  it('dry run fills the template from columns the sender can see only', async () => {
    const res = await as(bob).post(`/items/${itemId}/sms`, {
      column_id: phoneKey,
      template_id: 'hello',
      dry_run: true,
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ sent: false, to: '+972501234567', update: null });
    expect(out.text).toBe('שלום Dana מחיפה'); // the restricted column renders empty for bob
    expect(t.sms.sent).toHaveLength(0);
  });

  it('sends through the provider and logs an SMS update authored by the sender', async () => {
    const res = await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'נתראה מחר' });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out).toMatchObject({ sent: true, to: '+972501234567', text: 'נתראה מחר', segments: 1 });
    expect(out.provider_message_id).toMatch(/^mem-/);
    expect(t.sms.sent.at(-1)).toMatchObject({ to: '+972501234567', text: 'נתראה מחר', senderId: 'Acme' });
    expect(out.update).toMatchObject({ body_text: 'נתראה מחר', source: 'sms', author: { name: 'bob' } });
    expect(out.update.sms).toEqual({ to: '+972501234567', column_id: phoneKey });
    const thread = await body(await as().get(`/items/${itemId}/updates`));
    expect(thread.data[0]).toMatchObject({ source: 'sms', body_text: 'נתראה מחר' });
    const [ev] = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.itemId, itemId), eq(activityLog.type, 'update.created')))
      .orderBy(asc(activityLog.createdAt));
    expect(ev).toBeDefined();
  });

  it('a number outside the provider (non-Israeli mobile, landline) is a clear 422', async () => {
    await setCell(itemId, phoneKey, { phone: '+1 212 555 0100' });
    const res = await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'hi' });
    expect(res.status).toBe(422);
    const e = (await body(res)).error;
    expect(e.code).toBe('sms_unsupported_number');
    expect(e.details).toMatchObject({ reason: 'unsupported_destination', e164: '+12125550100' });
    await setCell(itemId, phoneKey, { phone: '*2700' });
    const bad = await body(await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'hi' }));
    expect(bad.error.details.reason).toBe('invalid');
    await setCell(itemId, phoneKey, { phone: '050-123 4567' });
  });

  it('provider failures are external errors; no update is logged', async () => {
    const before = (await t.db.select().from(updates).where(eq(updates.source, 'sms'))).length;
    t.sms.state.failNext = 'sms: textme no_balance';
    const res = await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'x' });
    expect(res.status).toBe(502);
    expect((await body(res)).error.details.provider_error).toBe('textme no_balance');
    expect((await t.db.select().from(updates).where(eq(updates.source, 'sms'))).length).toBe(before);
  });

  it('the account policy: viewers never under "members", admins only, nobody', async () => {
    expect((await as(vera).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'x' })).status).toBe(403);
    await patchSms({ send_policy: 'admins' });
    expect((await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'x' })).status).toBe(403);
    expect((await as().post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'x', dry_run: true })).status).toBe(
      200,
    );
    await patchSms({ send_policy: 'nobody' });
    const off = await as().post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'x', dry_run: true });
    expect(off.status).toBe(403);
    expect((await body(off)).error.details.reason).toBe('disabled');
    await patchSms({ send_policy: 'members' });
    // Guests never, whatever the policy says.
    const settings = accountSettingsSchema.parse({ sms: { send_policy: 'members' } });
    expect(smsDenied(settings, 'guest')).toBe('guest');
    expect(smsDenied(settings, 'member')).toBeNull();
  });

  it('the column switch / allowed actions turn SMS off for the column', async () => {
    await as().patch(`/boards/${boardId}/columns/${phoneKey}`, {
      settings: { default_country: 'IL', actions: ['whatsapp', 'call'], default_action: 'call' },
    });
    expect((await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'x' })).status).toBe(403);
    await as().patch(`/boards/${boardId}/columns/${phoneKey}`, {
      settings: { default_country: 'IL', click_actions_enabled: false },
    });
    expect((await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: 'x' })).status).toBe(403);
    await as().patch(`/boards/${boardId}/columns/${phoneKey}`, { settings: { default_country: 'IL' } });
    expect((await as(bob).post(`/items/${itemId}/sms`, { column_id: textKey, text: 'x' })).status).toBe(400);
  });

  it('rate limits per person per hour and per account per day (429)', async () => {
    await patchSms({ limits: { per_user_per_hour: 2 } });
    const s = await body(await as().get('/accounts/me'));
    expect(s.settings.sms.limits).toEqual({ per_user_per_hour: 2, per_account_per_day: 500 });
    // bob already sent one.
    expect((await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: '2' })).status).toBe(200);
    const limited = await as(bob).post(`/items/${itemId}/sms`, { column_id: phoneKey, text: '3' });
    expect(limited.status).toBe(429);
    expect((await body(limited)).error.details.reason).toBe('sms_user_limit');
    await patchSms({ limits: { per_user_per_hour: 30, per_account_per_day: 2 } });
    const acc = await as().post(`/items/${itemId}/sms`, { column_id: phoneKey, text: '4' });
    expect(acc.status).toBe(429);
    expect((await body(acc)).error.details.reason).toBe('sms_account_limit');
    await patchSms({ limits: { per_account_per_day: 500 } });
  });

  it('templates: duplicate ids are refused', async () => {
    const res = await patchSms({
      templates: [
        { id: 'a', name: 'A', text: 'x' },
        { id: 'a', name: 'B', text: 'y' },
      ],
    });
    expect(res.status).toBe(400);
  });
});

describe('automation action send_sms', () => {
  const drain = async () => {
    const rows = await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
    for (const r of rows.slice(-3))
      for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
  };

  it('sends the template to the phone column and logs it as the automation', async () => {
    const id = newId();
    const recipe: RecipeInput = {
      trigger: { type: 'item_created' },
      actions: [{ type: 'send_sms', column: phoneKey, template: 'hello' }],
    };
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 'Welcome SMS',
      recipe: recipe as never,
      isActive: true,
      ownerId: adminId,
      createdBy: adminId,
    });
    const created = await body(
      await as().post(`/boards/${boardId}/items`, { name: 'Noa', cells: { [phoneKey]: { phone: '0547654321' } } }),
    );
    const sentBefore = t.sms.sent.length;
    await drain();
    const [run] = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, id));
    expect(run?.status).toBe('succeeded');
    expect(t.sms.sent.length).toBe(sentBefore + 1);
    expect(t.sms.sent.at(-1)).toMatchObject({ to: '+972547654321' });
    expect(t.sms.sent.at(-1)!.text).toContain('שלום Noa');
    const [u] = await t.db.select().from(updates).where(eq(updates.itemId, created.id));
    expect(u).toMatchObject({ source: 'sms', createdBy: adminId });
    expect((u!.meta as Json).sms.automation_id).toBe(id);
    await t.db.update(automations).set({ isActive: false }).where(eq(automations.id, id));
  });

  it('a recipe needs a template or a message', async () => {
    const res = await as().post(`/boards/${boardId}/automations`, {
      title: 'x',
      recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'send_sms', column: phoneKey }] },
    });
    expect(res.status).toBe(422);
  });
});

describe('my phone click preference', () => {
  it('defaults, partial set and reset', async () => {
    expect(await body(await as(bob).get('/me/phone-actions'))).toEqual({
      click: 'menu',
      whatsapp_desktop: 'auto',
      sms_mobile: 'ask',
      user: {},
    });
    const set = await body(await as(bob).put('/me/phone-actions', { click: 'whatsapp', whatsapp_desktop: 'web' }));
    expect(set).toMatchObject({ click: 'whatsapp', whatsapp_desktop: 'web', user: { click: 'whatsapp' } });
    const reset = await body(await as(bob).put('/me/phone-actions', { click: null }));
    expect(reset).toMatchObject({ click: 'menu', whatsapp_desktop: 'web', user: { whatsapp_desktop: 'web' } });
    expect((await as(bob).put('/me/phone-actions', { click: 'fax' })).status).toBe(400);
  });
});
