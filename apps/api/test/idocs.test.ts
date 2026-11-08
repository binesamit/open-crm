// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDOC_STARTERS, newId, type IdocSection } from '@bines/shared';
import { activityLog, automationRuns, automations, idocDocs, updates } from '../src/db/schema';
import { dispatchEvent, executeRun } from '../src/modules/automations/engine/runner';
import { canonical } from '../src/modules/idocs/idocs.public';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Interactive documents: a quote built from the sample Word file — base package, add-ons with a
 * requirement, landing pages by quantity, users per month — shared as a public page, ticked, asked about, verified
 * by a one-time code and signed; plus isolation, expiry, revocation and reopening.
 */
let t: TestContext;
let admin: string;
let vera: string;
let betaAdmin: string;
let acmeId: string;
let betaId: string;
let boardId: string;
let subBoardId: string;
let itemId: string;
const sub: Record<string, string> = {};
let templateId: string;
let docId: string;
let token: string;
let statusLabel: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const inviteToken = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, inviteToken))!;
  await t.api(cookie).post('/invitations/accept', { token: inviteToken });
  return cookie;
};

let ipSeq = 0;
let visitorKey: string | null = null;
const pub = (method: string, path: string, data?: unknown, opts: { ip?: string; key?: string | null } = {}) =>
  t.app.request(`/api/v1/public/idocs/${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      'x-forwarded-for': opts.ip ?? `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile',
      ...((opts.key ?? visitorKey) ? { 'x-idoc-key': (opts.key ?? visitorKey)! } : {}),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const page = async () => body(await pub('GET', token));
/** A PDF answer's text (pdf.js reads a right-to-left line back reversed: `has` accepts either order). */
const pdfOf = async (res: Response) => {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  expect(res.headers.get('content-disposition')).toMatch(/attachment;.*\.pdf/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  const { extractText, getDocumentProxy } = await import('unpdf');
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
  const flat = text.replace(/\s+/g, ' ');
  return { text: flat, has: (s: string) => flat.includes(s) || flat.includes([...s].reverse().join('')) };
};
const as = (cookie = admin, account = acmeId) => t.api(cookie, account);
const subItems = async () => (await body(await as().get(`/boards/${subBoardId}/items`))).data as Json[];
const theItem = async () => body(await as().get(`/items/${itemId}`));
const sectionOf = (p: Json, id: string) => (p.sections as Json[]).find((s) => s.id === id)!;
const rowOf = (p: Json, sectionId: string, name: string) =>
  (sectionOf(p, sectionId).data.rows as Json[]).find((r) => r.name === name)!;

/** The quote template from the starter, mapped to this board's columns. */
const mapped = (sections: IdocSection[]): IdocSection[] =>
  sections.map((s) => {
    if (s.kind === 'header') return { ...s, fields: [{ label: 'לכבוד', value: '{col:client}' }, ...s.fields] };
    if (s.kind === 'lines') {
      const filter = { kind: 'subitems' as const, relation_column_key: null, filter_column_key: 'kind' };
      if (s.preset === 'fixed_lines')
        return { ...s, source: { ...filter, filter_values: ['בסיס'] }, mapping: { ...s.mapping, price: 'price' } };
      if (s.preset === 'addons')
        return {
          ...s,
          client_can_change_qty: true,
          source: { ...filter, filter_values: ['תוספת'] },
          mapping: {
            ...s.mapping,
            price: 'price',
            unit_price: 'unit',
            quantity: 'qty',
            selected: 'sel',
            requires: 'req',
          },
        };
      if (s.preset === 'subscription')
        return {
          ...s,
          source: { ...filter, filter_values: ['מנוי'] },
          mapping: { ...s.mapping, recurring_unit_price: 'unit', quantity: 'qty', selected: 'sel' },
        };
      return { ...s, source: { ...filter, filter_values: ['צד שלישי'] } };
    }
    if (s.kind === 'signature')
      return {
        ...s,
        signature_column_key: 'sig',
        status_column_key: 'status',
        status_label: statusLabel,
        file_column_key: 'files',
      };
    return s;
  });

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (await body(await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email }))).account
      .id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await as().post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  vera = await join('vera@acme.test');
  betaId = await mk('Beta', 'beta', 'admin@beta.test');
  betaAdmin = await join('admin@beta.test');

  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'הצעות', workspace_id: ws }))).id;
  for (const col of [
    { id: 'client', title: 'לקוח', type: 'text' },
    { id: 'mail', title: 'מייל', type: 'email' },
    { id: 'status', title: 'סטטוס', type: 'status' },
    { id: 'sig', title: 'חתימה', type: 'signature' },
    { id: 'files', title: 'קבצים', type: 'file' },
    { id: 'total', title: 'סה"כ', type: 'numbers' },
    { id: 'monthly', title: 'חודשי', type: 'numbers' },
    { id: 'phone', title: 'טלפון', type: 'phone' },
  ])
    expect((await as().post(`/boards/${boardId}/columns`, col)).status).toBe(201);
  const board = await body(await as().get(`/boards/${boardId}`));
  const statusCol = (board.columns as Json[]).find((c) => c.id === 'status')!;
  statusLabel = (statusCol.settings.labels as { label: string }[])[0]!.label;
  itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'הצעה 1027' }))).id;
  await as().patch(`/items/${itemId}`, { cells: { client: 'סטודיו הגל הלבן', mail: { email: 'noa@studio.test' } } });

  sub.base = (await body(await as().post(`/items/${itemId}/subitems`, { name: 'חבילת בסיס' }))).id;
  subBoardId = (await body(await as().get(`/boards/${boardId}`))).subitems_board_id;
  for (const col of [
    { id: 'kind', title: 'סוג', type: 'text' },
    { id: 'price', title: 'מחיר', type: 'numbers' },
    { id: 'unit', title: 'ליחידה', type: 'numbers' },
    { id: 'qty', title: 'כמות', type: 'numbers' },
    { id: 'sel', title: 'נבחר', type: 'checkbox' },
    { id: 'req', title: 'מחייב', type: 'dependency' },
  ])
    expect((await as().post(`/boards/${subBoardId}/columns`, col)).status).toBe(201);
  const add = async (key: string, name: string, cells: Json) => {
    sub[key] = sub[key] ?? (await body(await as().post(`/items/${itemId}/subitems`, { name }))).id;
    const res = await as().patch(`/items/${sub[key]}`, { cells });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };
  await add('base', 'חבילת בסיס', { kind: 'בסיס', price: 5000 });
  await add('wa', 'WhatsApp', { kind: 'תוספת', price: 1200 });
  await add('hist', 'היסטוריית שיחה', { kind: 'תוספת', price: 350 });
  await add('hist', 'היסטוריית שיחה', { req: { item_ids: [sub.wa] } });
  await add('lp', 'דפי נחיתה', { kind: 'תוספת', price: 3500, unit: 450, qty: 0 });
  await add('users', 'מנוי', { kind: 'מנוי', unit: 150, qty: 5, sel: { checked: true } });

  // A normal (internal) update that the page must never show.
  await as().post(`/items/${itemId}/updates`, { body: 'internal: margin is thin' });
});
afterAll(() => t.close());

describe('templates', () => {
  it('starts a template from the quote starter and maps it to the board', async () => {
    const starter = IDOC_STARTERS.find((s) => s.key === 'quote_agreement')!;
    const created = await body(
      await as().post('/idoc-templates', { name: 'הצעת מחיר', starter: 'quote_agreement', board_id: boardId }),
    );
    expect(created.sections).toHaveLength(starter.sections.length);
    templateId = created.id;
    const res = await as().patch(`/idoc-templates/${templateId}`, {
      sections: mapped(created.sections),
      settings: {
        ...created.settings,
        contact_email_column_key: 'mail',
        contact_name_column_key: 'client',
        total_one_time_column_key: 'total',
        total_recurring_column_key: 'monthly',
      },
    });
    expect(res.status).toBe(200);
    expect((await body(await as().get(`/idoc-templates?board_id=${boardId}`))).data.map((x: Json) => x.id)).toContain(
      templateId,
    );
  });

  it('lets a viewer use templates but not create them; another account sees none', async () => {
    expect((await as(vera).post('/idoc-templates', { name: 'x' })).status).toBe(403);
    expect((await body(await as(betaAdmin, betaId).get('/idoc-templates'))).data).toHaveLength(0);
    expect((await as(betaAdmin, betaId).get(`/idoc-templates/${templateId}`)).status).toBe(404);
  });
});

describe('a document on an item', () => {
  it('is made from the template with an unguessable link, for editors only', async () => {
    const doc = await body(await as().post(`/items/${itemId}/idocs`, { template_id: templateId }));
    expect(doc.status).toBe('draft');
    expect(doc.url).toMatch(/\/p\/[a-z0-9]{32}$/);
    docId = doc.id;
    token = doc.url.split('/p/')[1];
    const forViewer = (await body(await as(vera).get(`/items/${itemId}/idocs`))).data[0];
    expect(forViewer.url).toBeNull();
    expect((await as(vera).post(`/idocs/${docId}/send`, { no_email: true })).status).toBe(403);
    expect((await as(betaAdmin, betaId).get(`/idocs/${docId}`)).status).toBe(404);
  });

  it('emails the link to the contact and opens it for the set days', async () => {
    const sent = await body(await as().post(`/idocs/${docId}/send`, {}));
    expect(sent.status).toBe('sent');
    expect(sent.sent_to).toBe('noa@studio.test');
    expect(Date.parse(sent.expires_at)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(t.lastMailTo('noa@studio.test').text).toContain(`/p/${token}`);
  });
});

describe('the public page', () => {
  it('shows the sections with merged fields, opaque row keys and no column keys or item ids', async () => {
    const res = await pub('GET', token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const p = await body(res);
    expect(p.state).toBe('open');
    const raw = JSON.stringify(p);
    for (const id of Object.values(sub)) expect(raw).not.toContain(id);
    expect(raw).not.toContain(itemId);
    expect(raw).not.toContain('"mapping":{');
    expect(raw).not.toContain('margin is thin');
    expect(sectionOf(p, 's1')).toMatchObject({ title: 'הצעה 1027', subtitle: 'הצעת מחיר והסכם שירות' });
    expect(sectionOf(p, 's1').data.fields[0]).toEqual({ label: 'לכבוד', value: 'סטודיו הגל הלבן' });
    // Fields with no value are left out ("לידי" of the starter has none here).
    expect((sectionOf(p, 's1').data.fields as Json[]).every((f) => f.value)).toBe(true);
    const base = rowOf(p, 's3', 'חבילת בסיס');
    expect(base).toMatchObject({ price: 5000, selected: true });
    expect(base.key).toMatch(/^[\w-]{14}$/);
    expect(rowOf(p, 's5', 'היסטוריית שיחה').requires_names).toEqual(['WhatsApp']);
    expect(rowOf(p, 's6', 'מנוי')).toMatchObject({ recurring_unit_price: 150, qty: 5, selected: true });
    expect((await body(await as().get(`/idocs/${docId}`))).status).toBe('viewed');
  });

  it('ticks a row with what it needs, unticks dependants, writes the columns and the totals', async () => {
    let p = await page();
    const hist = rowOf(p, 's5', 'היסטוריית שיחה');
    const res = await pub('POST', `${token}/select`, { section_id: 's5', row: hist.key, selected: true });
    expect(res.status).toBe(200);
    const rows = (await body(res)).rows as Json[];
    expect(
      rows
        .filter((r) => r.selected)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['WhatsApp', 'היסטוריית שיחה']);
    const subs = await subItems();
    expect(subs.find((s) => s.id === sub.wa)!.cells.sel.value).toEqual({ checked: true });

    p = await page();
    await pub('POST', `${token}/select`, { section_id: 's5', row: rowOf(p, 's5', 'WhatsApp').key, selected: false });
    p = await page();
    expect(rowOf(p, 's5', 'היסטוריית שיחה').selected).toBe(false);

    await pub('POST', `${token}/select`, { section_id: 's5', row: rowOf(p, 's5', 'WhatsApp').key, selected: true });
    await pub('POST', `${token}/select`, { section_id: 's5', row: rowOf(p, 's5', 'דפי נחיתה').key, selected: true });
    const q = await pub('POST', `${token}/select`, { section_id: 's5', row: rowOf(p, 's5', 'דפי נחיתה').key, qty: 5 });
    expect(q.status).toBe(200);
    const item = await theItem();
    // 5,000 + 1,200 + 3,500 + 5 × 450 = 11,950 before VAT; 18% VAT; 5 users × 150 per month.
    expect(item.cells.total.value).toBe(14101);
    expect(item.cells.monthly.value).toBe(885);
    expect((await subItems()).find((s) => s.id === sub.lp)!.cells.qty.value).toBe(5);
  });

  it('refuses what the section does not allow, and rows of other documents', async () => {
    const p = await page();
    const base = rowOf(p, 's3', 'חבילת בסיס');
    expect((await pub('POST', `${token}/select`, { section_id: 's3', row: base.key, selected: false })).status).toBe(
      403,
    );
    expect((await pub('POST', `${token}/select`, { section_id: 's3', row: base.key, qty: 9 })).status).toBe(403);
    expect((await pub('POST', `${token}/select`, { section_id: 's5', row: sub.wa, selected: true })).status).toBe(404);
  });

  it('selects all / clears all of a free-choice section in one step', async () => {
    const before = await page();
    const keep = (before.sections as Json[])
      .find((x) => x.id === 's5')!
      .data.rows.filter((r: Json) => r.selected)
      .map((r: Json) => r.name as string);
    const all = await pub('POST', `${token}/select`, { section_id: 's5', all: true });
    expect(all.status).toBe(200);
    expect(((await body(all)).rows as Json[]).every((r) => r.selected)).toBe(true);
    expect((await subItems()).find((x) => x.id === sub.wa)!.cells.sel.value).toEqual({ checked: true });
    const events = await body(await as().get(`/idocs/${docId}/events`));
    // One log entry for the whole step, naming every row it ticked.
    expect((events.data as Json[]).some((e) => e.kind === 'selected' && (e.detail.match(/✓/g) ?? []).length >= 2)).toBe(
      true,
    );

    const none = await pub('POST', `${token}/select`, { section_id: 's5', all: false });
    expect(((await body(none)).rows as Json[]).some((r) => r.selected)).toBe(false);
    // A fixed section has no "select all"; `row` and `all` are one or the other.
    expect((await pub('POST', `${token}/select`, { section_id: 's3', all: true })).status).toBe(403);
    expect((await pub('POST', `${token}/select`, { section_id: 's5', all: true, row: 'x' })).status).toBe(400);

    // Back to the client's earlier choice (quantities were kept).
    for (const name of keep)
      await pub('POST', `${token}/select`, {
        section_id: 's5',
        row: rowOf(await page(), 's5', name).key,
        selected: true,
      });
    expect((await theItem()).cells.total.value).toBe(14101);
  });

  it('turns a question into an update on the item and shows the team’s reply', async () => {
    const res = await pub('POST', `${token}/questions`, { section_id: 's5', text: 'ה-SMS יוצא גם על קבלה?' });
    expect(res.status).toBe(200);
    const [row] = await t.db.select().from(updates).where(eq(updates.source, 'document'));
    expect(row!.createdBy).toBeNull();
    expect((row!.meta as Json).document).toMatchObject({
      doc_id: docId,
      name: 'סטודיו הגל הלבן',
      section_title: 'תוספות לבחירה',
    });
    expect((await as().post(`/updates/${row!.id}/replies`, { body: 'על כל מסמך שמופק' })).status).toBe(200);
    const p = await page();
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]).toMatchObject({
      from: 'client',
      section_title: 'תוספות לבחירה',
      text: 'ה-SMS יוצא גם על קבלה?',
    });
    expect(p.questions[0].replies).toEqual([expect.objectContaining({ from: 'team', text: 'על כל מסמך שמופק' })]);
    const inApp = (await body(await as().get(`/items/${itemId}/updates`))).data as Json[];
    expect(inApp.find((u) => u.id === row!.id)).toMatchObject({
      source: 'document',
      author: null,
      document: { name: 'סטודיו הגל הלבן' },
    });
  });
});

describe('the one-time code', () => {
  it('hides everything until the code mailed to the contact is entered', async () => {
    const doc = await body(await as().get(`/idocs/${docId}`));
    await as().patch(`/idocs/${docId}`, { settings: { ...doc.settings, verify: 'email_code' } });
    const locked = await page();
    expect(locked).toMatchObject({ state: 'verify', sections: [], email_hint: 'no***@st***.test' });
    expect((await pub('POST', `${token}/select`, { section_id: 's5', row: 'x', selected: true })).status).toBe(401);
    expect((await pub('GET', `${token}/pdf`)).status).toBe(401);
    expect((await pub('POST', `${token}/verify`)).status).toBe(200);
    const code = /\b(\d{6})\b/.exec(t.lastMailTo('noa@studio.test').text)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await pub('POST', `${token}/verify/check`, { code: wrong })).status).toBe(422);
    const ok = await body(await pub('POST', `${token}/verify/check`, { code }));
    visitorKey = ok.visitor_key;
    expect((await page()).state).toBe('open');
    expect((await page()).sections.length).toBeGreaterThan(5);
    // The download link form (?k=) works like the header.
    const viaQuery = await t.app.request(`/api/v1/public/idocs/${token}/pdf?k=${encodeURIComponent(visitorKey!)}`, {
      headers: { origin: WEB_ORIGIN, 'x-forwarded-for': '10.8.0.1' },
    });
    expect(viaQuery.status).toBe(200);
  });
});

describe('the PDF', () => {
  it('is the same file for the client and the team: the choices and totals, marked unsigned', async () => {
    const team = await pdfOf(await as().get(`/idocs/${docId}/pdf`));
    const client = await pdfOf(await pub('GET', `${token}/pdf`));
    expect(client.text).toBe(team.text);
    expect(team.has('דפי נחיתה')).toBe(true);
    expect(team.has('לא נחתם')).toBe(true);
    // A viewer of the board may download it; another account may not.
    expect((await as(vera).get(`/idocs/${docId}/pdf`)).status).toBe(200);
    expect((await as(betaAdmin, betaId).get(`/idocs/${docId}/pdf`)).status).toBe(404);
    // The client's download is in the document's log.
    const events = await body(await as().get(`/idocs/${docId}/events`));
    expect(events.data.map((e: Json) => e.kind)).toContain('downloaded');
  });

  it('has its own rate limit per client address', async () => {
    let last = 200;
    for (let i = 0; i < 21 && last === 200; i++)
      last = (await pub('GET', `${token}/pdf`, undefined, { ip: '10.7.7.7' })).status;
    expect(last).toBe(429);
    expect((await pub('GET', `${token}/pdf`)).status).toBe(200);
  });
});

describe('signing', () => {
  it('needs the required consents', async () => {
    const p = await page();
    const res = await pub('POST', `${token}/sign`, {
      section_id: 's14',
      name: 'נועה פרץ',
      consents: [],
      version: p.version,
    });
    expect(res.status).toBe(422);
  });

  it('signs: evidence with the content hash, the signature column, the status, the copy, the email', async () => {
    const p = await page();
    const res = await pub('POST', `${token}/sign`, {
      section_id: 's14',
      name: 'נועה פרץ',
      role: 'מנכ"ל',
      consents: ['read'],
      drawing: 'M10 60 C 40 20, 60 90, 90 50 L 120 40',
      version: p.version,
    });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    const doc = await body(await as().get(`/idocs/${docId}`));
    expect(doc.status).toBe('signed');
    const item = await theItem();
    expect(item.cells.sig.value).toMatchObject({ name: 'נועה פרץ', doc_id: docId, version: 1, has_drawing: true });
    expect(item.cells.status.text).toBe(statusLabel);
    // The signed copy is a PDF: what was signed, the signature and the certificate.
    expect(item.cells.files.value.files[0]).toMatchObject({ mime: 'application/pdf' });
    const signedPdf = await pdfOf(await as().get(`/idocs/${docId}/pdf`));
    expect(signedPdf.has('תעודת חתימה')).toBe(true);
    expect(signedPdf.text).toContain(out.sha256.slice(0, 32));
    expect(signedPdf.has('לא נחתם')).toBe(false);
    const cert = await body(await as().get(`/signatures/${doc.signature.id}`));
    expect(cert).toMatchObject({ sha256: out.sha256, version: 1, drawing: expect.stringMatching(/^M10/) });
    expect(cert.evidence).toMatchObject({
      verified_by: 'email_code',
      signer: { name: 'נועה פרץ', role: 'מנכ"ל', email: 'noa@studio.test' },
      document: { kind: 'idoc', id: docId, version: 1, sha256: out.sha256 },
    });
    expect(cert.evidence.consents[0]).toMatchObject({ key: 'read', checked: true });
    expect(cert.summary.some((l: string) => l.includes('דפי נחיתה × 5'))).toBe(true);
    expect(cert.events.map((e: Json) => e.kind)).toEqual(
      expect.arrayContaining(['created', 'sent', 'opened', 'selected', 'question', 'verified', 'signed']),
    );
    expect(t.lastMailTo('noa@studio.test').subject).toContain('אישרת');
  });

  it('locks after signing: no second signature, no changes', async () => {
    const p = await page();
    expect(p.state).toBe('signed');
    expect(p.signed).toMatchObject({ name: 'נועה פרץ' });
    const again = await pub('POST', `${token}/sign`, {
      section_id: 's14',
      name: 'X Y',
      consents: ['read'],
      version: 1,
    });
    expect(again.status).toBe(409);
    expect((await pub('POST', `${token}/select`, { section_id: 's5', row: 'x', selected: true })).status).toBe(409);
    expect((await as().patch(`/idocs/${docId}`, { sections: [] })).status).toBe(409);
    // Questions stay open after signing.
    expect((await pub('POST', `${token}/questions`, { section_id: null, text: 'מתי מתחילים?' })).status).toBe(200);
  });

  it('reopens as a new version; a page of the old version cannot sign', async () => {
    const doc = await body(await as().post(`/idocs/${docId}/reopen`, {}));
    expect(doc).toMatchObject({ version: 2, status: 'sent', signature: null });
    expect(
      (await pub('POST', `${token}/sign`, { section_id: 's14', name: 'נועה פרץ', consents: ['read'], version: 1 }))
        .status,
    ).toBe(409);
  });

  it('signing needs a name; "approve" (no name field) signs with the contact name', async () => {
    const p = await page();
    const noName = { section_id: 's14', name: '', consents: ['read'], version: p.version };
    expect((await pub('POST', `${token}/sign`, { ...noName, drawing: 'M10 60 L 120 40' })).status).toBe(422);
    const doc = await body(await as().get(`/idocs/${docId}`));
    const sections = doc.sections.map((s: Json) => (s.id === 's14' ? { ...s, mode: 'approve' } : s));
    expect((await as().patch(`/idocs/${docId}`, { sections })).status).toBe(200);
    // The page before the fix sent "—" for the missing name.
    const res = await pub('POST', `${token}/sign`, { ...noName, name: '—', version: (await page()).version });
    expect(res.status).toBe(200);
    expect((await body(res)).signed.name).toBe('סטודיו הגל הלבן');
    await as().post(`/idocs/${docId}/reopen`, {});
  });
});

describe('closing a link', () => {
  it('expires', async () => {
    await t.db
      .update(idocDocs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(idocDocs.id, docId));
    expect((await page()).state).toBe('expired');
    expect((await pub('POST', `${token}/select`, { section_id: 's5', row: 'x', selected: true })).status).toBe(409);
    await as().post(`/idocs/${docId}/reopen`, {});
    expect((await page()).state).toBe('open');
  });

  it('is replaced (the old token is gone) and revoked', async () => {
    const doc = await body(await as().post(`/idocs/${docId}/token`, {}));
    const fresh = doc.url.split('/p/')[1];
    expect((await pub('GET', token)).status).toBe(404);
    token = fresh;
    expect((await pub('GET', token)).status).toBe(200);
    await as().post(`/idocs/${docId}/revoke`, {});
    expect(await page()).toMatchObject({ state: 'revoked', sections: [], title: '' });
    expect((await pub('GET', `${token}/pdf`)).status).toBe(404);
    // The team still has it.
    expect((await as().get(`/idocs/${docId}/pdf`)).status).toBe(200);
  });

  it('answers 404 for unknown or malformed tokens', async () => {
    expect((await pub('GET', 'a'.repeat(32))).status).toBe(404);
    expect((await pub('GET', '../../etc')).status).toBe(404);
  });
});

describe('the content hash', () => {
  it('does not depend on key order', () => {
    expect(canonical({ b: 1, a: [{ y: 2, x: null }] })).toBe(canonical({ a: [{ x: null, y: 2 }], b: 1 }));
  });
});

describe('the send_document automation action', () => {
  const seen = new Set<string>();
  const drain = async () => {
    for (let round = 0; round < 10; round++) {
      const rows = await t.db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.accountId, acmeId))
        .orderBy(asc(activityLog.createdAt));
      const fresh = rows.filter((r) => !seen.has(r.id));
      if (!fresh.length) break;
      for (const r of fresh) {
        seen.add(r.id);
        for (const runId of await dispatchEvent(t.deps, r.id)) await executeRun(t.deps, runId);
      }
    }
  };

  it('makes the item’s document from the template and emails it; a second run reuses the open one', async () => {
    // Everything before this point is history for the engine.
    for (const r of await t.db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.accountId, acmeId)))
      seen.add(r.id);
    const me = await body(await as().get('/auth/me'));
    const id = newId();
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 'Send the quote',
      recipe: {
        trigger: { type: 'column_changed', column: 'mail' },
        actions: [{ type: 'send_document', template: templateId, send: true }],
      } as never,
      isActive: true,
      ownerId: me.user.id,
      createdBy: me.user.id,
    });
    const fresh = (await body(await as().post(`/boards/${boardId}/items`, { name: 'הצעה 2001' }))).id as string;
    await as().patch(`/items/${fresh}`, { cells: { client: 'לקוח חדש', mail: { email: 'new@client.test' } } });
    await drain();
    const docs = (await body(await as().get(`/items/${fresh}/idocs`))).data as Json[];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ template_id: templateId, status: 'sent', sent_to: 'new@client.test' });
    expect(t.lastMailTo('new@client.test').text).toContain(docs[0]!.url);
    await as().patch(`/items/${fresh}`, { cells: { mail: { email: 'other@client.test' } } });
    await drain();
    const again = (await body(await as().get(`/items/${fresh}/idocs`))).data as Json[];
    expect(again).toHaveLength(1);
    expect(again[0]!.sent_to).toBe('other@client.test');
    const runs = await t.db.select().from(automationRuns).where(eq(automationRuns.automationId, id));
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
  });
});

describe('document themes', () => {
  it('shows the account default for guests and for members, and a document’s own over both', async () => {
    const guest = {
      background: '#f4f6f8',
      paper: '#ffffff',
      text: '#1d2433',
      muted: '',
      accent: '#1d4ea8',
      header: '#1d2433',
      font: 'default',
    };
    const member = { ...guest, accent: '#7a2e8a', font: 'serif' };
    const saved = await as().patch('/accounts/me', { settings: { idoc_themes: { guests: guest, members: member } } });
    expect(saved.status).toBe(200);
    const doc = await body(await as().post(`/items/${itemId}/idocs`, { starter: 'blank' }));
    const tok = (doc.url as string).split('/p/')[1]!;
    const get = (cookie?: string) =>
      t.app.request(`/api/v1/public/idocs/${tok}`, { headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) } });
    expect((await body(await get())).theme).toMatchObject({ accent: '#1d4ea8', font: 'default' });
    // A signed-in member of the account sees the members' look.
    expect((await body(await get(admin))).theme).toMatchObject({ accent: '#7a2e8a', font: 'serif' });
    // The document's own look wins where it sets a value.
    await as().patch(`/idocs/${doc.id}`, {
      settings: { ...doc.settings, theme: { ...guest, accent: '#a8450c', header: '' } },
    });
    expect((await body(await get())).theme).toMatchObject({ accent: '#a8450c', header: '#1d2433', paper: '#ffffff' });
    // The builder's preview shows either audience.
    const preview = await body(await as().post(`/idocs/${doc.id}/preview`, { audience: 'members' }));
    expect(preview.theme.font).toBe('serif');
  });
});

describe('typed values instead of fields', () => {
  it('shows a typed field value as it is, and uses a typed contact when no column is set', async () => {
    const doc = await body(await as().get(`/idocs/${docId}`));
    const sections = (doc.sections as Json[]).map((x) =>
      x.id === 's1' ? { ...x, fields: [{ label: 'מספר הצעה', value: 'Q-0003 (ידני)' }] } : x,
    );
    const settings = {
      ...doc.settings,
      contact_email_column_key: null,
      contact_name_column_key: null,
      contact_email: 'fixed@client.test',
      contact_name: 'דנה קבועה',
    };
    const preview = await body(await as().post(`/idocs/${docId}/preview`, { sections, settings }));
    expect(sectionOf(preview, 's1').data.fields).toEqual([{ label: 'מספר הצעה', value: 'Q-0003 (ידני)' }]);
    const { contactEmailOf } = await import('../src/modules/idocs/idocs.service');
    const lookup = (v?: string) => () => v;
    expect(contactEmailOf({ lookup: lookup(), settings }, { sentTo: null })).toBe('fixed@client.test');
    expect(
      contactEmailOf(
        { lookup: lookup('col@client.test'), settings: { ...settings, contact_email_column_key: 'email' } },
        { sentTo: null },
      ),
    ).toBe('col@client.test');
    expect(
      contactEmailOf(
        { lookup: lookup(), settings: { ...settings, contact_email: 'not-an-email' } },
        { sentTo: 'x@y.test' },
      ),
    ).toBe('x@y.test');
  });
});
