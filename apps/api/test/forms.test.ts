// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formUnsupportedReason } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import { turnstile } from '../src/modules/forms/forms.turnstile';
import { summarizeUserAgent } from '../src/modules/forms/forms.public';
import { FORM_LIMITS } from '../src/modules/forms/forms.routes';

/** M11 public forms: the editor's endpoints, the public page's endpoints, anti-spam, files and isolation. */
let t: TestContext;
let admin: string;
let vera: string;
let betaAdmin: string;
let acmeId: string;
let betaId: string;
let boardId: string;
let groupB: string;
let viewId: string;
let token: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const inviteToken = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, inviteToken))!;
  await t.api(cookie).post('/invitations/accept', { token: inviteToken });
  return cookie;
};

let ipSeq = 0;
/** Each call comes from a new client address unless one is given (the per-address limit is tested on its own). */
const pub = (method: string, path: string, data?: unknown, opts: { ip?: string; cookie?: string } = {}) =>
  t.app.request(`/api/v1/public/forms/${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      'x-forwarded-for': opts.ip ?? `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
const submit = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}, opts = {}) =>
  pub('POST', `${token}/submit`, { answers, ...extra }, opts);

const save = async (patch: Json, cookie = admin) => t.api(cookie, acmeId).patch(`/views/${viewId}/form`, patch);
const items = async () => (await body(await t.api(admin, acmeId).get(`/boards/${boardId}/items`))).data as Json[];

const Q = {
  name: 'qname001',
  company: 'qcomp001',
  status: 'qstat001',
  reason: 'qreas001',
  mail: 'qmail001',
  source: 'qsrc0001',
  docs: 'qdocs001',
  agree: 'qagre001',
};
const baseQuestions = [
  { id: Q.name, column_key: 'name', label: 'שם מלא', required: true },
  { id: Q.company, column_key: 'company', help: 'שם החברה' },
  { id: Q.status, column_key: 'status', required: true },
  // Shown only when the status answer is "חסום" (label id 2) — and then required.
  { id: Q.reason, column_key: 'reason', required: true, condition: { question_id: Q.status, equals: 2 } },
  { id: Q.mail, column_key: 'mail' },
  { id: Q.source, column_key: 'source', hidden: true, default_value: 'אתר' },
];

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Acme', slug: 'acme', first_admin_email: 'admin@acme.test' }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  vera = await join('vera@acme.test');
  betaId = (
    await body(
      await t
        .api(owner)
        .post('/platform/accounts', { name: 'Beta', slug: 'beta', first_admin_email: 'admin@beta.test' }),
    )
  ).account.id;
  betaAdmin = await join('admin@beta.test');

  const api = t.api(admin, acmeId);
  const ws = (await body(await api.get('/workspaces'))).data[0].id;
  const board = await body(await api.post('/boards', { name: 'פניות', workspace_id: ws }));
  boardId = board.id;
  groupB = (await body(await api.post(`/boards/${boardId}/groups`, { title: 'מהטופס' }))).id;
  for (const col of [
    { id: 'company', title: 'חברה', type: 'text' },
    { id: 'status', title: 'סטטוס', type: 'status' },
    { id: 'reason', title: 'סיבה', type: 'long_text' },
    { id: 'mail', title: 'מייל', type: 'email' },
    { id: 'source', title: 'מקור', type: 'text' },
    { id: 'docs', title: 'מסמכים', type: 'file' },
    { id: 'agree', title: 'מאשר', type: 'checkbox' },
    { id: 'owner', title: 'אחראי', type: 'people' },
    { id: 'span', title: 'תקופה', type: 'timeline' },
  ])
    expect((await api.post(`/boards/${boardId}/columns`, col)).status).toBe(201);
  const view = await body(await api.post(`/boards/${boardId}/views`, { type: 'form', name: 'טופס פנייה' }));
  viewId = view.id;
  expect(view.type).toBe('form');
});
afterAll(() => t.close());

describe('the form editor', () => {
  it('opens a new form with defaults: the item name as a required question and an unguessable link', async () => {
    const form = await body(await t.api(admin, acmeId).get(`/views/${viewId}/form`));
    expect(form.title).toBe('טופס פנייה');
    expect(form.enabled).toBe(true);
    expect(form.access).toBe('public');
    expect(form.token).toMatch(/^[a-z0-9]{24}$/);
    expect(form.questions).toHaveLength(1);
    expect(form.questions[0]).toMatchObject({ column_key: 'name', required: true });
    expect(form.submissions_count).toBe(0);
    expect(form.can_manage).toBe(true);
    token = form.token;
  });

  it('saves questions, texts and the target group; refuses unsupported columns and bad conditions', async () => {
    expect(formUnsupportedReason('timeline')).toBe('not_supported');
    expect(formUnsupportedReason('formula')).toBe('computed');
    expect(formUnsupportedReason('board_relation')).toBeNull();
    expect(formUnsupportedReason('status')).toBeNull();

    const bad = await save({ questions: [...baseQuestions, { id: 'qspan001', column_key: 'span' }] });
    expect(bad.status).toBe(422);
    expect((await body(bad)).error.details.reason).toBe('unsupported_column');
    const badCond = await save({
      questions: [{ ...baseQuestions[3], condition: { question_id: Q.status, equals: 2 } }, baseQuestions[0]],
    });
    expect((await body(badCond)).error.details.reason).toBe('invalid_condition');
    const badDefault = await save({
      questions: [baseQuestions[0], { id: 'qstat009', column_key: 'status', hidden: true, default_value: 'אין כזה' }],
    });
    expect((await body(badDefault)).error.details.reason).toBe('invalid_default');

    const res = await save({
      title: 'פנייה חדשה',
      description: 'נחזור אליכם',
      questions: baseQuestions,
      target_group_id: groupB,
      settings: { success_message: 'תודה!', submit_label: 'שליחה', privacy_notice: 'הפרטים משמשים רק לחזרה אליך.' },
    });
    expect(res.status).toBe(200);
    const form = await body(res);
    expect(form.questions).toHaveLength(6);
    expect(form.target_group_id).toBe(groupB);
    expect(form.settings.success_message).toBe('תודה!');
  });

  it('account viewers read the form but cannot change it; another account cannot see it at all', async () => {
    const asVera = await body(await t.api(vera, acmeId).get(`/views/${viewId}/form`));
    expect(asVera.can_manage).toBe(false);
    expect((await save({ title: 'x' }, vera)).status).toBe(403);
    expect((await t.api(betaAdmin, betaId).get(`/views/${viewId}/form`)).status).toBe(404);
    expect((await t.api(betaAdmin, betaId).patch(`/views/${viewId}/form`, { title: 'x' })).status).toBe(404);
    expect((await t.api(betaAdmin, acmeId).get(`/views/${viewId}/form`)).status).toBe(404);
  });
});

describe('the public page', () => {
  it('shows only the configured questions — no column keys, board, account or item ids', async () => {
    const res = await pub('GET', token);
    expect(res.status).toBe(200);
    // Privacy: the form's privacy notice reaches the page.
    expect(((await res.clone().json()) as Json).privacy_notice).toBe('הפרטים משמשים רק לחזרה אליך.');
    const raw = await res.text();
    const form = JSON.parse(raw) as Json;
    expect(form.title).toBe('פנייה חדשה');
    expect(form.language).toBe('he');
    expect(form.account).toMatchObject({ name: 'Acme' });
    // The hidden question is not on the page.
    expect(form.questions.map((q: Json) => q.id)).toEqual([Q.name, Q.company, Q.status, Q.reason, Q.mail]);
    expect(form.questions[0]).toMatchObject({ label: 'שם מלא', input: 'text', required: true });
    expect(form.questions[1]).toMatchObject({ label: 'חברה', help: 'שם החברה' });
    expect(form.questions[2].choices.map((c: Json) => c.label)).toEqual(['בתהליך', 'הושלם', 'חסום']);
    for (const secret of [boardId, acmeId, viewId, groupB, '"company"', '"column_key"', 'source', 'אתר'])
      expect(raw).not.toContain(secret);
    expect(form.turnstile_site_key).toBeNull();
  });

  it('a malformed or unknown token is a 404', async () => {
    expect((await pub('GET', 'NOT-A-TOKEN')).status).toBe(404);
    expect((await pub('GET', 'abcdefabcdefabcdefabcdef')).status).toBe(404);
  });
});

describe('submitting', () => {
  it('creates the item through the items service: values, the target group, the hidden default, "via form"', async () => {
    const res = await submit({
      [Q.name]: 'דנה כהן',
      [Q.company]: 'דנה בע"מ',
      [Q.status]: 1,
      [Q.mail]: 'dana@example.com',
      // A hidden question's answer from the page is ignored; its default is used.
      [Q.source]: 'זיוף',
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, message: 'תודה!', redirect_url: null });
    const item = (await items()).find((i) => i.name === 'דנה כהן')!;
    expect(item.group_id).toBe(groupB);
    expect(item.cells.company.value).toBe('דנה בע"מ');
    expect(item.cells.status.value).toEqual({ index: 1 });
    expect(item.cells.mail.value).toMatchObject({ email: 'dana@example.com' });
    expect(item.cells.source.value).toBe('אתר');
    expect(item.cells.reason).toBeUndefined();

    // "item created" is in the activity log (automations fire from it), marked as coming from the form.
    const events = (
      await t.db.execute<{ type: string; payload: Json }>(
        sql`select type, payload from activity_log where item_id = ${item.id} order by id`,
      )
    ).rows;
    expect(events[0]!.type).toBe('item.created');
    expect(events.every((e) => e.payload.meta?.via === 'form')).toBe(true);
    expect(events[0]!.payload.meta.form.title).toBe('פנייה חדשה');
    const activity = await body(await t.api(admin, acmeId).get(`/items/${item.id}/activity`));
    expect((activity.data as Json[]).some((e) => e.via?.kind === 'form' && e.via.client === 'פנייה חדשה')).toBe(true);

    // The submission record: counted, an address hash (never the address), a user-agent summary.
    const sub = (await t.db.execute<Json>(sql`select * from form_submissions where item_id = ${item.id}`)).rows[0]!;
    expect(sub.ip).toBeNull();
    expect(sub.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sub.user_agent).toBe('Chrome 131 · Android');
    expect((await body(await t.api(admin, acmeId).get(`/views/${viewId}/form`))).submissions_count).toBe(1);
  });

  it('validates every answer on the server: required, types, labels', async () => {
    const res = await submit({ [Q.company]: 'x', [Q.status]: 99, [Q.mail]: 'not-an-email' });
    expect(res.status).toBe(400);
    const err = (await body(res)).error;
    expect(err.code).toBe('validation_failed');
    expect(err.details.questions).toEqual({ [Q.name]: 'required', [Q.status]: 'invalid', [Q.mail]: 'invalid' });
  });

  it('a conditional question applies only when its condition is met', async () => {
    // Condition not met: the required "reason" is not asked, and an answer to it is dropped.
    expect((await submit({ [Q.name]: 'בלי סיבה', [Q.status]: 0, [Q.reason]: 'לא אמור להישמר' })).status).toBe(200);
    expect((await items()).find((i) => i.name === 'בלי סיבה')!.cells.reason).toBeUndefined();
    // Condition met: now it is required …
    const missing = await submit({ [Q.name]: 'עם סיבה', [Q.status]: 2 });
    expect((await body(missing)).error.details.questions).toEqual({ [Q.reason]: 'required' });
    // … and saved.
    expect((await submit({ [Q.name]: 'עם סיבה', [Q.status]: 2, [Q.reason]: 'חסר מידע' })).status).toBe(200);
    expect((await items()).find((i) => i.name === 'עם סיבה')!.cells.reason.value).toEqual({ text: 'חסר מידע' });
  });

  it('the honeypot answers like a success and creates nothing', async () => {
    const before = (await items()).length;
    const res = await submit({ [Q.name]: 'בוט', [Q.status]: 1 }, { website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect((await items()).length).toBe(before);
  });

  it('limits submissions per client address (and the next address is not affected)', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < FORM_LIMITS.submitPerIp.limit; i++)
      expect((await submit({ [Q.status]: 1 }, {}, { ip })).status).toBe(400);
    const limited = await submit({ [Q.name]: 'עוד אחד', [Q.status]: 1 }, {}, { ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await submit({ [Q.name]: 'מכתובת אחרת', [Q.status]: 1 }, {}, { ip: '203.0.113.8' })).status).toBe(200);
  });
});

describe('files', () => {
  const upload = async (name: string, size: number, mime: string, question = Q.docs) =>
    pub('POST', `${token}/uploads`, { question_id: question, name, size, mime });
  const storageKey = async (id: string) =>
    (await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${id}`)).rows[0]!
      .storage_key;

  it('checks size and type limits; an accepted upload lands on the item through the files module', async () => {
    await save({
      questions: [
        ...baseQuestions,
        { id: Q.docs, column_key: 'docs', files: { max_mb: 1, kinds: ['pdf', 'image'], max_files: 2 } },
      ],
    });
    expect((await upload('big.pdf', 2 * 1024 * 1024, 'application/pdf')).status).toBe(413);
    expect((await upload('run.exe', 100, 'application/x-msdownload')).status).toBe(422);
    expect((await upload('a.pdf', 100, 'application/pdf', Q.company)).status).toBe(404);

    const pre = await body(await upload('הצעה.pdf', 1000, 'application/pdf'));
    expect(pre.upload_url).toContain('storage.test');
    // Submitting before the bytes are in storage fails.
    const early = await submit({ [Q.name]: 'עם קובץ', [Q.status]: 1, [Q.docs]: [pre.upload_id] });
    expect((await body(early)).error.details.questions).toEqual({ [Q.docs]: 'invalid' });
    t.storage.markUploaded(await storageKey(pre.upload_id), 1000, 'application/pdf');
    const ok = await submit({ [Q.name]: 'עם קובץ', [Q.status]: 1, [Q.docs]: [pre.upload_id] });
    expect(ok.status).toBe(200);
    const item = (await items()).find((i) => i.name === 'עם קובץ')!;
    expect(item.cells.docs.value.files).toHaveLength(1);
    expect(item.cells.docs.value.files[0].name).toBe('הצעה.pdf');
    // The same upload cannot be sent again.
    const again = await submit({ [Q.name]: 'שוב', [Q.status]: 1, [Q.docs]: [pre.upload_id] });
    expect((await body(again)).error.details.questions).toEqual({ [Q.docs]: 'invalid' });
  });

  it('a file the person uploaded elsewhere (not through this form) is refused; too many files too', async () => {
    const other = await body(
      await t.api(admin, acmeId).post('/files/presign', { name: 'x.pdf', size: 10, mime: 'application/pdf' }),
    );
    t.storage.markUploaded(await storageKey(other.file_id), 10, 'application/pdf');
    await t.api(admin, acmeId).post(`/files/${other.file_id}/complete`);
    const res = await submit({ [Q.name]: 'זר', [Q.status]: 1, [Q.docs]: [other.file_id] });
    expect((await body(res)).error.details.questions).toEqual({ [Q.docs]: 'invalid' });
    const ids = [];
    for (const n of ['1.pdf', '2.pdf', '3.pdf'])
      ids.push((await body(await upload(n, 10, 'application/pdf'))).upload_id);
    const many = await submit({ [Q.name]: 'הרבה', [Q.status]: 1, [Q.docs]: ids });
    expect((await body(many)).error.details.questions).toEqual({ [Q.docs]: 'too_many_files' });
  });
});

describe('access, closing and the link', () => {
  it('members-only forms: anonymous → sign in (401); another account → 404; a member fills it, with people', async () => {
    await save({
      access: 'members',
      questions: [...baseQuestions, { id: 'qownr001', column_key: 'owner' }],
    });
    expect((await pub('GET', token)).status).toBe(401);
    expect((await pub('GET', token, undefined, { cookie: betaAdmin })).status).toBe(404);
    const form = await body(await pub('GET', token, undefined, { cookie: admin }));
    const people = form.questions.find((q: Json) => q.id === 'qownr001');
    expect(people.input).toBe('people');
    const me = people.choices.find((c: Json) => c.label.startsWith('admin'));
    const res = await submit({ [Q.name]: 'מחבר', [Q.status]: 1, qownr001: [me.value] }, {}, { cookie: admin });
    expect(res.status).toBe(200);
    const item = (await items()).find((i) => i.name === 'מחבר')!;
    expect(item.cells.owner.value.persons_and_teams).toEqual([{ id: me.value, kind: 'person' }]);
    const sub = (await t.db.execute<Json>(sql`select submitted_by from form_submissions where item_id = ${item.id}`))
      .rows[0]!;
    expect(sub.submitted_by).toBeTruthy();
    // Back to public: a people question is not offered to the public.
    await save({ access: 'public' });
    const open = await body(await pub('GET', token));
    expect(open.questions.some((q: Json) => q.id === 'qownr001')).toBe(false);
  });

  it('a partial settings update keeps the fields it did not send', async () => {
    await save({ settings: { language: 'en', submit_label: 'Send it', allow_embed: true } });
    const res = await save({ settings: { success_message: 'Thanks' } });
    expect(res.status).toBe(200);
    const s = (await body(res)).settings;
    expect(s).toMatchObject({ language: 'en', submit_label: 'Send it', allow_embed: true, success_message: 'Thanks' });
    await save({ settings: { language: 'he', submit_label: '', allow_embed: false, success_message: '' } });
  });

  it('a closed form (date or limit) answers form_closed; a disabled one is gone', async () => {
    await save({ settings: { close_at: new Date(Date.now() - 60_000).toISOString() } });
    const closed = await pub('GET', token);
    expect(closed.status).toBe(409);
    expect((await body(closed)).error.code).toBe('form_closed');
    await save({ settings: { close_at: null, max_submissions: 1 } });
    expect((await submit({ [Q.name]: 'מלא', [Q.status]: 1 })).status).toBe(409);
    await save({ settings: { max_submissions: null }, enabled: false });
    expect((await pub('GET', token)).status).toBe(404);
    expect((await submit({ [Q.name]: 'כבוי', [Q.status]: 1 })).status).toBe(404);
    await save({ enabled: true });
    expect((await pub('GET', token)).status).toBe(200);
  });

  it('a new link replaces the old one at once', async () => {
    const old = token;
    const form = await body(await t.api(admin, acmeId).post(`/views/${viewId}/form/token`));
    expect(form.token).not.toBe(old);
    expect((await pub('GET', old)).status).toBe(404);
    token = form.token;
    expect((await pub('GET', token)).status).toBe(200);
  });

  it('a deleted form view takes its link with it', async () => {
    const view = await body(
      await t.api(admin, acmeId).post(`/boards/${boardId}/views`, { type: 'form', name: 'זמני' }),
    );
    const f = await body(await t.api(admin, acmeId).get(`/views/${view.id}/form`));
    expect((await pub('GET', f.token)).status).toBe(200);
    await t.api(admin, acmeId).del(`/views/${view.id}`);
    expect((await pub('GET', f.token)).status).toBe(404);
  });
});

describe('Turnstile (optional, per form)', () => {
  it('the secret is write-only; with a site key and secret the check is required', async () => {
    const res = await save({ settings: { turnstile_site_key: '0x4AAAAsite' }, turnstile_secret: 'super-secret-value' });
    const form = await body(res);
    expect(form.turnstile_secret_set).toBe(true);
    expect(JSON.stringify(form)).not.toContain('super-secret-value');
    const stored = (
      await t.db.execute<{ s: string }>(sql`select settings::text as s from forms where view_id = ${viewId}`)
    ).rows[0]!.s;
    expect(stored).not.toContain('super-secret-value');
    expect((await body(await pub('GET', token))).turnstile_site_key).toBe('0x4AAAAsite');

    const verify = vi.spyOn(turnstile, 'verify');
    verify.mockResolvedValue(false);
    const refused = await submit({ [Q.name]: 'בלי בדיקה', [Q.status]: 1 }, { turnstile_token: 'bad' });
    expect((await body(refused)).error.code).toBe('captcha_failed');
    const missing = await submit({ [Q.name]: 'בלי טוקן', [Q.status]: 1 });
    expect(missing.status).toBe(400);
    expect((await body(missing)).error.code).toBe('captcha_required');
    expect(refused.status).toBe(400);
    verify.mockResolvedValue(true);
    expect((await submit({ [Q.name]: 'עבר בדיקה', [Q.status]: 1 }, { turnstile_token: 'good' })).status).toBe(200);
    expect(verify).toHaveBeenLastCalledWith('super-secret-value', 'good', expect.any(String));
    verify.mockRestore();
    await save({ turnstile_secret: null });
    expect((await body(await pub('GET', token))).turnstile_site_key).toBeNull();
  });
});

describe('the /f/* page headers', () => {
  const csp = (res: Response) => res.headers.get('content-security-policy') ?? '';
  it('allows Turnstile on the form page only; embedding only when the form allows it', async () => {
    const page = await t.app.request(`/f/${token}`);
    expect(csp(page)).toContain('https://challenges.cloudflare.com');
    expect(csp(page)).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(csp(await t.app.request('/a/acme'))).not.toContain('challenges.cloudflare.com');

    await save({ settings: { allow_embed: true } });
    const embeddable = await t.app.request(`/f/${token}`);
    expect(csp(embeddable)).toContain('frame-ancestors *');
    expect(embeddable.headers.get('x-frame-options')).toBeNull();
    // Only that form: the rest of the app still refuses framing.
    expect((await t.app.request('/a/acme')).headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('helpers', () => {
  it('summarizes user agents', () => {
    expect(
      summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'),
    ).toBe('Edge 130 · Windows');
    expect(
      summarizeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1'),
    ).toBe('Safari 18 · iOS');
    expect(summarizeUserAgent(null)).toBeNull();
  });
});
