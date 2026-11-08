// SPDX-License-Identifier: AGPL-3.0-only
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32 } from '../src/lib/xlsx';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** M6 stage 8 — board export to .xlsx / .csv. */
let t: TestContext;
let admin: string;
let carol: string; // viewer
let acmeId: string;
let boardId: string;
let statusKey: string;
let amountKey: string;
let secretKey: string;
const ids: string[] = [];
/** The CSV byte-order mark (written as a char code: tools turn the escape into the raw character). */
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** The entries of a zip (our writer: deflate, local headers) → name → content. */
const unzip = (buf: Buffer) => {
  const out = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const crc = buf.readUInt32LE(i + 14);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const data = inflateRawSync(buf.subarray(i + 30 + nameLen, i + 30 + nameLen + size));
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString('utf8'));
    i += 30 + nameLen + size;
  }
  return out;
};

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
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'לידים', workspace_id: wsId }))).id;
  statusKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'סטטוס', type: 'status' }))).id;
  amountKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'סכום', type: 'numbers' }))).id;
  secretKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'סודי', type: 'text' }))).id;
  // Only owners see the "secret" column (05 §6.1).
  await as(admin).put(`/boards/${boardId}/columns/${secretKey}/restriction`, { kind: 'view' });
  const board = await body(await as(admin).get(`/boards/${boardId}`));
  const label = board.columns.find((c: Json) => c.id === statusKey).settings.labels[1];
  for (const [name, amount] of [
    ['דנה, "סטודיו"', 1500],
    ['יוסי', 250.5],
    ['רונית', null],
  ] as const) {
    const it = await body(await as(admin).post(`/boards/${boardId}/items`, { name }));
    ids.push(it.id);
    if (amount !== null) await as(admin).put(`/items/${it.id}/cells/${amountKey}`, { value: amount });
    await as(admin).put(`/items/${it.id}/cells/${secretKey}`, { value: 'מספר חשבון' });
  }
  await as(admin).put(`/items/${ids[0]}/cells/${statusKey}`, { value: { index: label.id } });
});
afterAll(() => t.close());

const exportAs = (cookie: string, payload: Json) => as(cookie).post(`/boards/${boardId}/export`, payload);

describe('board export', () => {
  it('CSV: BOM, header (name, group, columns), quoted values, a Hebrew filename', async () => {
    const res = await exportAs(admin, { format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''${encodeURIComponent('לידים')}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.toString('utf8').slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('שם,קבוצה,סטטוס,סכום,סודי');
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.startsWith('"דנה, ""סטודיו"""'))).toContain(',"1,500",'); // a new numbers column shows 1,500
  });

  it('follows the view: its filter and its column order; or just the selection', async () => {
    const filtered = await exportAs(admin, {
      format: 'csv',
      query: {
        filter: {
          kind: 'group',
          operator: 'and',
          negate: false,
          rules: [{ kind: 'rule', column_id: amountKey, operator: 'is_not_empty', values: [], negate: false }],
        },
      },
      columns: [amountKey, statusKey],
    });
    const lines = (await filtered.text()).trim().split('\r\n');
    expect(lines[0]!.replace(BOM_RE, '')).toBe('שם,קבוצה,סכום,סטטוס');
    expect(lines).toHaveLength(3);
    const picked = (await (await exportAs(admin, { format: 'csv', item_ids: [ids[2]] })).text()).trim().split('\r\n');
    expect(picked).toHaveLength(2);
    expect(picked[1]).toContain('רונית');
  });

  it('a column hidden from someone is not in their file', async () => {
    const res = await exportAs(carol, { format: 'csv' });
    expect(res.status).toBe(200);
    const header = (await res.text()).split('\r\n')[0]!.replace(BOM_RE, '');
    expect(header).toBe('שם,קבוצה,סטטוס,סכום');
  });

  it('XLSX: a valid workbook, right-to-left, bold header, numbers as numbers', async () => {
    const res = await exportAs(admin, { format: 'xlsx' });
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">שם</t></is></c>');
    expect(sheet).toContain('<v>1500</v>');
    expect(sheet).toContain('<v>250.5</v>');
    expect(sheet).toContain('דנה, &quot;סטודיו&quot;');
    expect(files.get('xl/workbook.xml')).toContain('name="לידים"');
  });

  it('with subitems: under their parent, indented, with the sub-board columns after', async () => {
    const sub = await body(await as(admin).post(`/items/${ids[1]}/subitems`, { name: 'משימת משנה' }));
    await as(admin).post(`/items/${sub.id}/subitems`, { name: 'עוד רמה' });
    const lines = (await (await exportAs(admin, { format: 'csv', include_subitems: true })).text())
      .replace(BOM_RE, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toMatch(/^שם,קבוצה,סטטוס,סכום,סודי,תת-פריט: /);
    const at = lines.findIndex((l) => l.startsWith('יוסי'));
    expect(lines[at + 1]).toMatch(/^↳ משימת משנה,/);
    expect(lines[at + 2]).toMatch(/^"? {2}↳ עוד רמה/);
    // Without the flag: parents only.
    expect((await (await exportAs(admin, { format: 'csv' })).text()).includes('משימת משנה')).toBe(false);
  });
});
