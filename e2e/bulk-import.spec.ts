// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { zip } from '../apps/api/src/lib/xlsx';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * "ייבוא ועריכה" (until "עריכה גדולה") B3 — import a file into the bulk-edit sheet (product owner: "להוסיף אפשרות לייבוא מאקסל"): an.xlsx with
 * two sheets (choose the second; a real date cell), auto-mapping by name, one file column made a new column and one
 * left out, matching existing items by name (case-insensitive) → updated + appended rows → the B2 review → one
 * batch → values after a reload. Then a .csv (semicolons, mapped by hand) → written → undone from the activity log:
 * every change of the batch is gone (new rows, values, the new label).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

type XCell = string | number | { date: string };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const col = (i: number) => String.fromCharCode(65 + i);
const serial = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
const sheetXml = (rows: XCell[][]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) => {
            const ref = `${col(ci)}${ri + 1}`;
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            if (typeof v === 'object') return `<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
          })
          .join('')}</row>`,
    )
    .join('')}</sheetData></worksheet>`;

/** A minimal two-sheet workbook (dates styled with the built-in d/m/yyyy format 14). */
const xlsx = (sheets: [string, XCell[][]][]) =>
  zip([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join(
          '',
        )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map(([name], i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      'xl/styles.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ],
    ...sheets.map(([, rows], i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(rows)]),
  ]);

type Col = { id: string; type: string; title: string; settings: { labels?: { id: number; label: string }[] } };
type Item = { id: string; name: string; cells: Record<string, { value: unknown; text: string | null }> };

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'delete', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `ייבוא ${tag}`, workspace_id: ws.id });
  const detail = await api<{ columns: { id: string; type: string }[] }>('get', `/boards/${board.id}`);
  for (const c of detail.columns.filter((x) => x.type !== 'name'))
    await api('delete', `/boards/${board.id}/columns/${c.id}`);
  await api('post', `/boards/${board.id}/columns`, { title: 'מצב', type: 'status' });
  await api('post', `/boards/${board.id}/columns`, { title: 'הערה', type: 'text' });
  await api('post', `/boards/${board.id}/columns`, { title: 'כמות', type: 'numbers' });
  await api('post', `/boards/${board.id}/columns`, { title: 'תאריך', type: 'date' });
  await api('post', `/boards/${board.id}/items`, { name: `Alpha ${tag}` });
  await api('post', `/boards/${board.id}/items`, { name: `Beta ${tag}` });
  const columns = async () => (await api<{ columns: Col[] }>('get', `/boards/${board.id}`)).columns;
  const items = async () => (await api<{ data: Item[] }>('get', `/boards/${board.id}/items`)).data;
  return { board, tag, columns, items };
};

const openSheet = async (page: Page) => {
  await page.getByTestId('board-more').click();
  await page.getByRole('menu').getByTestId('board-bulk-edit').click();
  // "ייבוא" opens on the choice of a file; the sheet is one click away.
  await page.getByTestId('bulk-start-sheet').click();
  const grid = page.getByTestId('bulk-grid');
  await expect(grid).toBeVisible();
  return grid;
};
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const mapRow = (page: Page, source: string) => page.locator(`[data-testid="bulk-import-row"][data-source="${source}"]`);
const pick = async (page: Page, trigger: ReturnType<Page['locator']>, option: string) => {
  await trigger.click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: option, exact: true }).click();
};
const finishAndApprove = async (page: Page) => {
  await page.getByTestId('bulk-finish').click();
  await expect(page.getByTestId('bulk-review')).toBeVisible();
};

test('bulk import: xlsx (second sheet, new column, ignored column, match by name) and csv, undo from the log', async ({
  page,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, tag, columns, items } = await setup(page);
  const cols = await columns();
  const id = (title: string) => cols.find((c) => c.title === title)!.id;
  const name = cols.find((c) => c.type === 'name')!;
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `Beta ${tag}`)).toBeVisible();

  // ---- .xlsx ----
  const label = `סגור-${tag}`.slice(0, 20);
  const file = xlsx([
    ['הערות', [['לא זה'], ['גם לא']]],
    [
      'לקוחות',
      [
        ['שם', 'מצב', 'כמות', 'תאריך', 'עיר', 'פנימי'],
        [`alpha ${tag}`, label, 5, { date: '2026-03-05' }, 'חיפה', 'x'],
        [`Gamma ${tag}`, label, 7, { date: '2026-04-01' }, 'תל אביב', 'y'],
      ],
    ],
  ]);
  await openSheet(page);
  await page.getByTestId('bulk-import-file').setInputFiles({
    name: `לקוחות-${tag}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: file,
  });
  const panel = page.getByTestId('bulk-import');
  await expect(panel).toBeVisible();
  await pick(page, page.getByTestId('bulk-import-sheet'), 'לקוחות');
  // Auto-mapped by title; the two extra columns are not imported until chosen.
  await expect(mapRow(page, 'שם')).toHaveAttribute('data-target', name.id);
  await expect(mapRow(page, 'מצב')).toHaveAttribute('data-target', id('מצב'));
  await expect(mapRow(page, 'כמות')).toHaveAttribute('data-target', id('כמות'));
  await expect(mapRow(page, 'תאריך')).toHaveAttribute('data-target', id('תאריך'));
  await expect(mapRow(page, 'עיר')).toHaveAttribute('data-target', 'ignore');
  await expect(mapRow(page, 'פנימי')).toHaveAttribute('data-target', 'ignore');
  // "עיר" becomes a new text column.
  await pick(page, mapRow(page, 'עיר').getByTestId('bulk-import-target'), 'עמודה חדשה…');
  await expect(mapRow(page, 'עיר')).toHaveAttribute('data-target', 'new');
  await pick(page, mapRow(page, 'עיר').getByTestId('bulk-import-new-type'), 'טקסט');
  await mapRow(page, 'עיר').getByTestId('bulk-import-new-title').fill(`עיר ${tag}`);
  // Matching by name is on (the file's "alpha" is the sheet's "Alpha"): one update, one new row.
  await expect(page.getByTestId('bulk-import-match')).toHaveText(name.title);
  await expect(page.getByTestId('bulk-import-summary')).toHaveAttribute('data-updated', '1');
  await expect(page.getByTestId('bulk-import-summary')).toHaveAttribute('data-created', '1');
  await expect(page.getByTestId('bulk-import-preview')).toContainText('חיפה');
  await expect(page.getByTestId('bulk-import-preview')).not.toContainText('פנימי');
  await page.getByTestId('bulk-import-apply').click();

  const grid = page.getByTestId('bulk-grid');
  await expect(grid).toHaveAttribute('data-rows', '3');
  await expect(page.locator('[data-bulk-header^="__new_"]')).toHaveText(`עיר ${tag}`);
  await finishAndApprove(page);
  await expect(page.getByTestId('bulk-review-counts')).toHaveAttribute('data-updated', '1');
  await expect(page.getByTestId('bulk-review-counts')).toHaveAttribute('data-created', '1');
  await expect(page.locator(`[data-testid="bulk-new-label"][data-label="${label}"]`)).toHaveAttribute(
    'data-add',
    'true',
  );
  await expect(page.getByTestId('bulk-review-columns')).toContainText(`עיר ${tag}`);
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveCount(0);

  await page.reload();
  await expect(row(page, `Gamma ${tag}`)).toBeVisible();
  await expect(row(page, `Alpha ${tag}`)).toBeVisible(); // matched: not renamed to "alpha"
  await expect(page.locator(`[data-header]`, { hasText: `עיר ${tag}` })).toBeVisible();
  const city = (await columns()).find((c) => c.title === `עיר ${tag}`)!;
  expect(city.type).toBe('text');
  expect((await columns()).some((c) => c.title === 'פנימי')).toBe(false);
  const byName = async (n: string) => (await items()).find((i) => i.name === n)!;
  const alpha = await byName(`Alpha ${tag}`);
  expect(alpha.cells[id('כמות')]!.value).toBe(5);
  expect(alpha.cells[id('מצב')]!.text).toBe(label);
  expect(alpha.cells[id('תאריך')]!.value).toMatchObject({ date: '2026-03-05' });
  expect(alpha.cells[city.id]!.value).toBe('חיפה');
  const gamma = await byName(`Gamma ${tag}`);
  expect(gamma.cells[id('כמות')]!.value).toBe(7);
  expect(gamma.cells[id('תאריך')]!.value).toMatchObject({ date: '2026-04-01' });

  // ---- .csv (semicolons, mapped by hand, dropped on the sheet), then undo from the activity log ----
  const csv = [`Name;Notes;Amount`, `beta ${tag};csv note;12`, `Delta ${tag};new row;3`].join('\r\n');
  await openSheet(page);
  await expect(grid).toHaveAttribute('data-rows', '3');
  // Dropped on the sheet this time.
  const dropped = await page.evaluateHandle(
    ({ text, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], fileName, { type: 'text/csv' }));
      return dt;
    },
    { text: csv, fileName: `rows-${tag}.csv` },
  );
  await page.getByTestId('bulk-sheet').dispatchEvent('dragover', { dataTransfer: dropped });
  await expect(page.getByTestId('bulk-drop')).toBeVisible();
  await page.getByTestId('bulk-sheet').dispatchEvent('drop', { dataTransfer: dropped });
  await expect(page.getByTestId('bulk-import')).toBeVisible();
  await expect(page.getByTestId('bulk-import-sheet')).toHaveCount(0);
  await expect(mapRow(page, 'Name')).toHaveAttribute('data-target', name.id);
  await pick(page, mapRow(page, 'Notes').getByTestId('bulk-import-target'), 'הערה');
  await pick(page, mapRow(page, 'Amount').getByTestId('bulk-import-target'), 'כמות');
  await expect(page.getByTestId('bulk-import-summary')).toHaveAttribute('data-updated', '1');
  await expect(page.getByTestId('bulk-import-summary')).toHaveAttribute('data-created', '1');
  await page.getByTestId('bulk-import-apply').click();
  await expect(grid).toHaveAttribute('data-rows', '4');
  await finishAndApprove(page);
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveCount(0);
  await expect(row(page, `Delta ${tag}`)).toBeVisible();
  await expect(row(page, `Beta ${tag}`).locator(`[data-column="${id('הערה')}"]`)).toContainText('csv note');

  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'יומן פעילות' }).click();
  const log = page.getByTestId('board-activity');
  // The batch is one row ("2 פריטים (…)"); the undo then writes rows of its own above it.
  const entry = log
    .getByTestId('activity-entry')
    .filter({ hasText: '2 פריטים (' })
    .filter({ hasText: `Delta ${tag}` });
  await expect(entry.getByTestId('activity-undo')).toBeVisible();
  await entry.getByTestId('activity-undo').click();
  // Events of trashed items leave the log; the rest of the batch shows as undone.
  await expect(log.locator('[data-testid="activity-entry"][data-undone="true"]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, `Delta ${tag}`)).toHaveCount(0);
  await page.reload();
  await expect(row(page, `Gamma ${tag}`)).toBeVisible();
  await expect(row(page, `Delta ${tag}`)).toHaveCount(0);
  const beta = await byName(`Beta ${tag}`);
  expect(beta.cells[id('הערה')]).toBeUndefined();
  expect(beta.cells[id('כמות')]).toBeUndefined();

  // The xlsx batch too: its new column and new label go, Gamma goes to the trash, Alpha's values come back.
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'יומן פעילות' }).click();
  const older = log
    .getByTestId('activity-entry')
    .filter({ hasText: '2 פריטים (' })
    .filter({ hasText: `Gamma ${tag}` });
  await older.getByTestId('activity-undo').click();
  await expect(row(page, `Gamma ${tag}`)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(row(page, `Alpha ${tag}`)).toBeVisible();
  await expect(row(page, `Gamma ${tag}`)).toHaveCount(0);
  const after = await columns();
  expect(after.some((c) => c.title === `עיר ${tag}`)).toBe(false);
  const status = after.find((c) => c.title === 'מצב')!;
  expect(
    status.settings.labels!.some((l) => l.label === label && !(l as { is_deactivated?: boolean }).is_deactivated),
  ).toBe(false);
  const alpha2 = await byName(`Alpha ${tag}`);
  expect(alpha2.cells[id('כמות')]).toBeUndefined();
  expect(alpha2.cells[id('מצב')]).toBeUndefined();
});
