// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, auditLog, docs, platformAuditLog, users } from '../src/db/schema';
import { accountClosed, forgetEntitlements } from '../src/modules/billing/entitlements';
import { resetFreshCodeFailures } from '../src/modules/admin/fresh-code';
import { accountTables, countRows } from '../src/modules/account-deletion/account-deletion.repo';
import { deletionSweep, purgeAccount, sendReminders } from '../src/modules/account-deletion/account-deletion.service';
import { createZipFile } from '../src/lib/zip-file';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * the full account export (what the ZIP holds), scheduling the deletion (the name, the fresh 2FA
 * code), the grace-period lock, cancel, the reminders, the owner console (list, cancel, delete now) and the final
 * purge — every row and stored file gone, one platform audit row, idempotent and resumable.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery';
const DAY = 86_400_000;

let t: TestContext;
let owner: string;
let acmeId: string;
let otherId: string;
let admin: string;
let adminUri: string;
let admin2: string;
let bob: string;
let carol: string;
let boardId: string;
let privateBoardName: string;
let itemId: string;
let fileKey: string;

// ---- TOTP (RFC 6238), as in secrets.test.ts ----
const base32 = (s: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
const totp = (uri: string) => {
  const secret = base32(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
};
const authCall = (path: string, payload: unknown, cookie?: string) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
const sessionCookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('bos.session_token=') && !c.endsWith('='));
const enroll = async (cookie: string) => {
  const res = await authCall('/two-factor/enable', { password: PASSWORD }, cookie);
  expect(res.status).toBe(200);
  const { totpURI } = await body(res);
  const verify = await authCall('/two-factor/verify-totp', { code: totp(totpURI) }, cookie);
  expect(verify.status).toBe(200);
  return { uri: totpURI as string, cookie: sessionCookieOf(verify) ?? cookie };
};

// ---- a small ZIP reader (the export and the workbooks inside it) ----
const unzip = (buf: Buffer) => {
  const out = new Map<string, Buffer>();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const packed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lh = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(lh, lh + packed);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie = admin, account = acmeId) => t.api(cookie, account);
const upload = async (cookie: string, accountId: string, name: string, bytes: Buffer, mime = 'application/pdf') => {
  const pre = await body(await t.api(cookie, accountId).post('/files/presign', { name, size: bytes.length, mime }));
  const key = (
    await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
  ).rows[0]!.storage_key;
  t.storage.markUploaded(key, bytes.length, mime, bytes);
  expect((await t.api(cookie, accountId).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
  return { id: pre.file_id as string, key };
};
const mk = async (name: string, slug: string, email: string) =>
  (
    await body(
      await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
    )
  ).account.id as string;
const mailsTo = (email: string, part: string) =>
  t.mailer.sent.filter((m) => m.to === email && m.subject.includes(part));
const schedule = (cookie: string, uri: string | null, name = 'Acme Ltd', account = acmeId) =>
  t.api(cookie, account).post('/account-deletion', { confirm_name: name, code: uri ? totp(uri) : '000000' });
const rowsLeft = async (accountId: string) => {
  const left: Record<string, number> = {};
  for (const table of await accountTables(t.db)) {
    const n = await countRows(t.db, table, accountId);
    if (n) left[table] = n;
  }
  return left;
};

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await mk('Acme Ltd', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  await as().post('/users/invite', { emails: ['admin2@acme.test'], role: 'admin' });
  admin2 = await join('admin2@acme.test');
  await as().post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  // Carol is in another account too: after the purge she gets no "only account" email.
  const otherAdmin = await join('admin@other.test');
  await t.api(otherAdmin, otherId).post('/users/invite', { emails: ['carol@acme.test'], role: 'member' });
  const token = t.inviteTokenFor('carol@acme.test');
  await t.api(carol).post('/invitations/accept', { token });

  const enrolled = await enroll(admin);
  admin = enrolled.cookie;
  adminUri = enrolled.uri;

  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Leads', workspace_id: ws }))).id;
  await as().post(`/boards/${boardId}/columns`, { id: 'docs', title: 'Files', type: 'file' });
  itemId = (await body(await as().post(`/boards/${boardId}/items`, { name: 'Dana' }))).id;
  await as().post(`/items/${itemId}/subitems`, { name: 'Call Dana' });
  await as().post(`/items/${itemId}/updates`, { body: 'Met Dana today' });
  const f = await upload(admin, acmeId, 'contract.pdf', Buffer.from('%PDF-contract'));
  fileKey = f.key;
  expect((await as().post(`/items/${itemId}/cells/docs/files`, { file_ids: [f.id] })).status).toBe(200);
  // Bob's private board: the admin is not in it — the export leaves it out and names it.
  privateBoardName = 'Bob private';
  await as(bob).post('/boards', { name: privateBoardName, workspace_id: ws, kind: 'private' });
  // A doc with some text.
  const doc = await body(await as().post(`/workspaces/${ws}/docs`, { name: 'Handbook' }));
  await t.db
    .update(docs)
    .set({
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Welcome to Acme' }] }],
      },
    })
    .where(eq(docs.id, doc.id));
});
afterAll(() => t.close());

describe('zip writer', () => {
  it('writes entries that read back (deflated and stored, streamed)', async () => {
    const { tmpdir } = await import('node:os');
    const { readFile, rm } = await import('node:fs/promises');
    const { Readable } = await import('node:stream');
    const path = `${tmpdir()}/zip-test-${Date.now()}.zip`;
    const zip = await createZipFile(path);
    await zip.add('a.txt', 'שלום עולם '.repeat(100));
    await zip.add('dir/b.bin', Readable.from([Buffer.from([1, 2]), Buffer.from([3])]), { store: true });
    await zip.close();
    const files = unzip(await readFile(path));
    expect(files.get('a.txt')!.toString('utf8')).toBe('שלום עולם '.repeat(100));
    expect([...files.get('dir/b.bin')!]).toEqual([1, 2, 3]);
    await rm(path, { force: true });
  });
});

describe('full export', () => {
  let exportId: string;
  it('members cannot export', async () => {
    expect((await as(bob).post('/account-export')).status).toBe(403);
    expect((await as(bob).get('/account-export')).status).toBe(403);
  });

  it('an admin exports everything they can read into one ZIP, emailed when ready', async () => {
    const res = await as().post('/account-export');
    expect(res.status).toBe(202);
    const e = await body(res);
    exportId = e.id;
    // No worker in tests: built right away.
    expect(e).toMatchObject({ status: 'ready', error: null });
    expect(e.summary).toMatchObject({ boards: 1, docs: 1, files: 1, users: 4 });
    expect(e.summary.skipped).toContain(privateBoardName);
    expect(Date.parse(e.expires_at) - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect(mailsTo('admin@acme.test', 'הייצוא של Acme Ltd').length).toBe(1);

    const link = await body(await as().get(`/account-export/${exportId}/download`));
    const key = new URL(link.url).pathname.slice(1);
    expect(key.startsWith(`exports/${acmeId}/`)).toBe(true);
    const files = unzip(t.storage.objects.get(key)!.body!);
    const names = [...files.keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        'boards/Leads.xlsx',
        'files/Leads/Dana/contract.pdf',
        'docs/Handbook.md',
        'docs/Handbook.html',
        'users.csv',
        'README.txt',
      ]),
    );
    expect(names.some((n) => n.includes(privateBoardName))).toBe(false);
    expect(files.get('files/Leads/Dana/contract.pdf')!.toString()).toBe('%PDF-contract');
    expect(files.get('docs/Handbook.md')!.toString()).toContain('Welcome to Acme');
    expect(files.get('users.csv')!.toString()).toContain('bob@acme.test');
    expect(files.get('README.txt')!.toString()).toContain(privateBoardName);
    // The workbook: items with the subitem, and the updates on a second sheet.
    const book = unzip(files.get('boards/Leads.xlsx')!);
    expect(book.get('xl/workbook.xml')!.toString()).toMatch(/<sheet name="[^"]+" sheetId="2"/);
    const items = book.get('xl/worksheets/sheet1.xml')!.toString();
    expect(items).toContain('Dana');
    expect(items).toContain('Call Dana');
    expect(book.get('xl/worksheets/sheet2.xml')!.toString()).toContain('Met Dana today');

    const audit = await t.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.accountId, acmeId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['account.export_requested', 'account.exported', 'account.export_downloaded']),
    );
  });

  it('lists the exports; another account never reaches one', async () => {
    const list = await body(await as().get('/account-export'));
    expect(list.data[0]).toMatchObject({ id: exportId, status: 'ready' });
    const otherAdmin = (await t.signInWithMagicLink('admin@other.test')).cookie!;
    expect((await t.api(otherAdmin, otherId).get(`/account-export/${exportId}/download`)).status).toBe(404);
  });
});

describe('scheduling the deletion', () => {
  it('members cannot; an admin without two-factor sign-in cannot (clear message)', async () => {
    expect((await schedule(bob, null)).status).toBe(403);
    const res = await schedule(admin2, null);
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe('step_up_two_factor_required');
    const status = await body(await as(admin2).get('/account-deletion'));
    expect(status).toMatchObject({ due_at: null, two_factor_enabled: false, grace_days: 30 });
  });

  it('the name must match and the code must be right', async () => {
    const wrongName = await schedule(admin, adminUri, 'Acme');
    expect(wrongName.status).toBe(422);
    expect((await body(wrongName)).error.code).toBe('confirm_mismatch');
    const wrongCode = await t
      .api(admin, acmeId)
      .post('/account-deletion', { confirm_name: 'Acme Ltd', code: '000000' });
    expect(wrongCode.status).toBe(422);
    expect((await body(wrongCode)).error.code).toBe('step_up_code_invalid');
    resetFreshCodeFailures();
  });

  it('schedules it: locked at once, due in 30 days, the admins emailed', async () => {
    const res = await schedule(admin, adminUri, '  acme ltd ');
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(Date.parse(s.due_at) - Date.now()).toBeGreaterThan(29.9 * DAY);
    expect(s.requested_by.name).toBeTruthy();
    expect(mailsTo('admin@acme.test', 'Acme Ltd יימחק ב-').length).toBe(1);
    expect(mailsTo('admin2@acme.test', 'Acme Ltd יימחק ב-').length).toBe(1);
    expect(mailsTo('bob@acme.test', 'Acme Ltd יימחק ב-').length).toBe(0);
    // Scheduling again is refused by the lock itself.
    expect((await body(await schedule(admin, adminUri))).error.code).toBe('account_deletion_scheduled');
  });
});

describe('the grace period', () => {
  it('locks the account like a closed one: only the deletion screen answers', async () => {
    const boards = await as(bob).get('/boards');
    expect(boards.status).toBe(403);
    const err = (await body(boards)).error;
    expect(err.code).toBe('account_deletion_scheduled');
    expect(err.details.due_at).toBeTruthy();
    expect((await as().post(`/boards/${boardId}/items`, { name: 'x' })).status).toBe(403);
    // What the screen needs still answers.
    expect((await as(bob).get('/account-deletion')).status).toBe(200);
    expect((await as().get('/account-export')).status).toBe(200);
    expect((await as(bob).post('/account-deletion/cancel')).status).toBe(403);
    // /me/accounts says so; background work stops.
    const mine = (await body(await t.api(bob).get('/me/accounts'))).data.find((a: Json) => a.id === acmeId);
    expect(mine.deletion_due_at).toBeTruthy();
    expect(await accountClosed(t.db, acmeId)).toBe(true);
    // Another account is untouched.
    expect((await t.api(carol, otherId).get('/boards')).status).toBe(200);
  });

  it('a token never passes', async () => {
    await t.db.update(accounts).set({ deletionDueAt: null }).where(eq(accounts.id, acmeId));
    forgetEntitlements(acmeId);
    const token = (await body(await as().post('/auth/tokens', { name: 'Make', scopes: ['boards:read'] }))).token;
    await t.db
      .update(accounts)
      .set({ deletionDueAt: new Date(Date.now() + 30 * DAY) })
      .where(eq(accounts.id, acmeId));
    forgetEntitlements(acmeId);
    const res = await t.app.request('/api/v1/account-deletion', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it('reminders go 7 days and 1 day before, once each', async () => {
    const due = (await t.db.select().from(accounts).where(eq(accounts.id, acmeId)))[0]!.deletionDueAt!;
    const before = mailsTo('admin2@acme.test', 'תזכורת').length;
    expect(await sendReminders(t.deps, new Date(due.getTime() - 10 * DAY))).toBe(0);
    // The mail transport is down: nothing is marked, the next sweep sends it (audit 2026-10-10 worker #18).
    const transport = t.mailer as { send: (m: never) => Promise<void> };
    const real = transport.send;
    transport.send = async () => {
      throw new Error('smtp down');
    };
    try {
      expect(await sendReminders(t.deps, new Date(due.getTime() - 6.5 * DAY))).toBe(0);
    } finally {
      transport.send = real;
    }
    expect(mailsTo('admin2@acme.test', 'תזכורת').length).toBe(before);
    expect(await sendReminders(t.deps, new Date(due.getTime() - 6.5 * DAY))).toBe(1);
    expect(await sendReminders(t.deps, new Date(due.getTime() - 6 * DAY))).toBe(0);
    expect(await sendReminders(t.deps, new Date(due.getTime() - 0.5 * DAY))).toBe(1);
    expect(await sendReminders(t.deps, new Date(due.getTime() - 0.2 * DAY))).toBe(0);
    expect(mailsTo('admin2@acme.test', 'תזכורת').length).toBe(before + 2);
  });

  it('an admin cancels: the account opens again at once', async () => {
    const res = await as(admin2).post('/account-deletion/cancel');
    expect(res.status).toBe(200);
    expect((await body(res)).due_at).toBeNull();
    expect((await as(bob).get('/boards')).status).toBe(200);
    expect(await accountClosed(t.db, acmeId)).toBe(false);
    const actions = (
      await t.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.accountId, acmeId))
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['account.deletion_scheduled', 'account.deletion_cancelled']));
    expect((await as().post('/account-deletion/cancel')).status).toBe(409);
  });
});

describe('owner console', () => {
  it('lists the scheduled accounts and cancels one', async () => {
    expect((await schedule(admin, adminUri)).status).toBe(200);
    const list = await body(await t.api(owner).get('/platform/account-deletions'));
    expect(list.data).toEqual([expect.objectContaining({ id: acmeId, slug: 'acme' })]);
    const accountsList = await body(await t.api(owner).get('/platform/accounts'));
    expect(accountsList.data.find((a: Json) => a.id === acmeId).deletion_due_at).toBeTruthy();
    expect((await t.api(bob).get('/platform/account-deletions')).status).toBe(404);
    expect((await t.api(owner).post(`/platform/accounts/${acmeId}/deletion/cancel`)).status).toBe(200);
    expect((await body(await t.api(owner).get('/platform/account-deletions'))).data).toEqual([]);
  });

  it('"delete now" needs the slug and the owner’s own fresh code', async () => {
    expect((await schedule(admin, adminUri)).status).toBe(200);
    // The owner here signs in by magic link and has no two-factor sign-in.
    const no2fa = await t
      .api(owner)
      .post(`/platform/accounts/${acmeId}/deletion/now`, { confirm_slug: 'acme', code: '123456' });
    expect(no2fa.status).toBe(403);
    expect((await body(no2fa)).error.code).toBe('step_up_two_factor_required');
    // Make the admin (two-factor on) a platform owner too.
    await t.db.update(users).set({ isPlatformOwner: true }).where(eq(users.email, 'admin@acme.test'));
    const wrongSlug = await t
      .api(admin)
      .post(`/platform/accounts/${acmeId}/deletion/now`, { confirm_slug: 'acm', code: totp(adminUri) });
    expect(wrongSlug.status).toBe(422);
  });

  it('deletes everything: rows, stored files, the export — one platform audit row, emails to the people left', async () => {
    const res = await t
      .api(admin)
      .post(`/platform/accounts/${acmeId}/deletion/now`, { confirm_slug: 'acme', code: totp(adminUri) });
    expect(res.status).toBe(200);
    expect(await rowsLeft(acmeId)).toEqual({});
    expect((await t.db.select().from(accounts).where(eq(accounts.id, acmeId))).length).toBe(0);
    expect(t.storage.objects.has(fileKey)).toBe(false);
    expect([...t.storage.objects.keys()].some((k) => k.includes(acmeId))).toBe(false);
    const audit = await t.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetId, acmeId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'account.purged' });
    expect(audit[0]!.payload).toMatchObject({ name: 'Acme Ltd', slug: 'acme', by: { via: 'owner' } });
    // People whose only account it was keep an empty profile and get an email; Carol (also in Other) does not.
    const bobRow = (await t.db.select().from(users).where(eq(users.email, 'bob@acme.test')))[0];
    expect(bobRow).toBeTruthy();
    expect(mailsTo('bob@acme.test', 'Acme Ltd נמחק').length).toBe(1);
    expect(mailsTo('carol@acme.test', 'Acme Ltd נמחק').length).toBe(0);
    expect((await body(await t.api(bob).get('/me/accounts'))).data).toEqual([]);
    expect((await t.api(carol, otherId).get('/boards')).status).toBe(200);
    // Idempotent: a second run does nothing.
    expect(await purgeAccount(t.deps, acmeId)).toBe(false);
    expect(await t.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetId, acmeId))).toHaveLength(1);
  });
});

describe('the sweep', () => {
  it('resumes a purge that crashed half way, and purges once', async () => {
    const thirdId = await mk('Third', 'third', 'admin@third.test');
    const third = await join('admin@third.test');
    const ws = (await body(await t.api(third, thirdId).get('/workspaces'))).data[0].id;
    const b = (await body(await t.api(third, thirdId).post('/boards', { name: 'B', workspace_id: ws }))).id;
    await t.api(third, thirdId).post(`/boards/${b}/columns`, { id: 'docs', title: 'Files', type: 'file' });
    const item = (await body(await t.api(third, thirdId).post(`/boards/${b}/items`, { name: 'I' }))).id;
    const f1 = await upload(third, thirdId, 'a.pdf', Buffer.from('a'));
    const f2 = await upload(third, thirdId, 'b.pdf', Buffer.from('b'));
    await t.api(third, thirdId).post(`/items/${item}/cells/docs/files`, { file_ids: [f1.id, f2.id] });
    await t.db
      .update(accounts)
      .set({ deletionScheduledAt: new Date(Date.now() - 31 * DAY), deletionDueAt: new Date(Date.now() - DAY) })
      .where(eq(accounts.id, thirdId));

    // The storage fails on the second file: the purge stops, and nothing is half-lost.
    const remove = t.storage.remove;
    let calls = 0;
    t.storage.remove = async (key: string) => {
      if (++calls === 2) throw new Error('storage down');
      return remove(key);
    };
    await expect(purgeAccount(t.deps, thirdId)).rejects.toThrow('storage down');
    t.storage.remove = remove;
    expect((await t.db.select().from(accounts).where(eq(accounts.id, thirdId))).length).toBe(1);

    const r = await deletionSweep(t.deps);
    expect(r.purged).toBe(1);
    expect(await rowsLeft(thirdId)).toEqual({});
    expect(t.storage.objects.has(f1.key) || t.storage.objects.has(f2.key)).toBe(false);
    expect(await t.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetId, thirdId))).toHaveLength(1);
    expect(mailsTo('admin@third.test', 'Third נמחק').length).toBe(1);
    expect((await deletionSweep(t.deps)).purged).toBe(0);
  });

  it('by default leaves accounts the owner console deleted alone, and still purges a scheduled one', async () => {
    const settings = await body(await t.api(owner).get('/platform/settings'));
    expect(settings.settings.account_deletion.purge_console_deleted).toBe(false);
    const keptId = await mk('Kept', 'kept', 'admin@kept.test');
    expect((await t.api(owner).del(`/platform/accounts/${keptId}`, { confirm_slug: 'kept' })).status).toBe(200);
    await t.db
      .update(accounts)
      .set({ deletedAt: new Date(Date.now() - 365 * DAY) })
      .where(eq(accounts.id, keptId));
    const dueId = await mk('Due', 'due', 'admin@due.test');
    await t.db
      .update(accounts)
      .set({ deletionScheduledAt: new Date(Date.now() - 31 * DAY), deletionDueAt: new Date(Date.now() - DAY) })
      .where(eq(accounts.id, dueId));

    expect((await deletionSweep(t.deps)).purged).toBe(1);
    expect(await t.db.select().from(accounts).where(eq(accounts.id, dueId))).toHaveLength(0);
    // The console-deleted account (a year ago) keeps every row: only the owner's switch or "delete now" purges it.
    expect(await t.db.select().from(accounts).where(eq(accounts.id, keptId))).toHaveLength(1);
    expect(await t.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetId, keptId))).toHaveLength(0);
    expect((await deletionSweep(t.deps)).purged).toBe(0);
  });

  it('with the owner’s switch on, also finishes accounts the console deleted once their grace period passed', async () => {
    const on = await t.api(owner).patch('/platform/settings', { account_deletion: { purge_console_deleted: true } });
    expect(on.status).toBe(200);
    expect((await body(on)).settings.account_deletion).toMatchObject({ purge_console_deleted: true, grace_days: 30 });
    try {
      // The previous test's console-deleted account ("kept", a year ago) goes on the first sweep.
      const keptId = (await t.db.select().from(accounts).where(eq(accounts.slug, 'kept')))[0]!.id;
      expect((await deletionSweep(t.deps)).purged).toBe(1);
      expect(await t.db.select().from(accounts).where(eq(accounts.id, keptId))).toHaveLength(0);

      const goneId = await mk('Gone', 'gone', 'admin@gone.test');
      expect((await t.api(owner).del(`/platform/accounts/${goneId}`, { confirm_slug: 'gone' })).status).toBe(200);
      // Within the grace period: nothing yet.
      expect((await deletionSweep(t.deps)).purged).toBe(0);
      await t.db
        .update(accounts)
        .set({ deletedAt: new Date(Date.now() - 31 * DAY) })
        .where(eq(accounts.id, goneId));
      expect((await deletionSweep(t.deps)).purged).toBe(1);
      expect(await t.db.select().from(accounts).where(eq(accounts.id, goneId))).toHaveLength(0);
      expect(await t.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetId, goneId))).toHaveLength(1);
    } finally {
      await t.api(owner).patch('/platform/settings', { account_deletion: { purge_console_deleted: false } });
    }
  });
});
