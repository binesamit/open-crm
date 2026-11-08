// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/** The text of a PDF (pdf.js through `unpdf`, a dependency of the API package). */
const pdfText = async (file: string) => {
  const resolveFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { extractText, getDocumentProxy } = (await import(pathToFileURL(resolveFromApi.resolve('unpdf')).href)) as {
    getDocumentProxy: (data: Uint8Array) => Promise<unknown>;
    extractText: (pdf: unknown, opts: { mergePages: true }) => Promise<{ text: string }>;
  };
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(readFileSync(file))), { mergePages: true });
  return text.replace(/\s+/g, ' ');
};

/**
 * Interactive documents: a quote made from the "quote and agreement" starter on an item with
 * subitems (base, add-ons, a subscription), opened from the item card's Documents tab and its builder, marked as
 * sent, then opened by the client on the public page: ticking an add-on moves the total, a question lands on the
 * item, a drawn signature approves it — and the board's signature cell opens the certificate.
 */
test('interactive document: builder, public page, live total, question, signature, certificate', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = {
    get: async <T>(path: string) => (await (await page.request.get(`/api/v1${path}`, { headers })).json()) as T,
    post: async <T>(path: string, data: unknown) =>
      (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as T,
    patch: async <T>(path: string, data: unknown) =>
      (await (await page.request.patch(`/api/v1${path}`, { headers, data })).json()) as T,
  };
  const ws = (await api.get<{ data: { id: string }[] }>('/workspaces')).data[0]!.id;
  const board = await api.post<{ id: string }>('/boards', { name: `הצעות ${Date.now()}`, workspace_id: ws });
  for (const col of [
    { id: 'client', title: 'לקוח', type: 'text' },
    { id: 'mail', title: 'מייל', type: 'email' },
    { id: 'sig', title: 'חתימה', type: 'signature' },
    { id: 'files', title: 'קבצים', type: 'file' },
    { id: 'total', title: 'סה"כ', type: 'numbers' },
  ])
    await api.post(`/boards/${board.id}/columns`, col);
  const item = await api.post<{ id: string }>(`/boards/${board.id}/items`, { name: 'הצעה 1027' });
  await api.patch(`/items/${item.id}`, { cells: { client: 'סטודיו הגל הלבן', mail: { email: 'noa@example.com' } } });
  const sub = async (name: string) => (await api.post<{ id: string }>(`/items/${item.id}/subitems`, { name })).id;
  const base = await sub('חבילת בסיס');
  const subBoard = (await api.get<{ subitems_board_id: string }>(`/boards/${board.id}`)).subitems_board_id;
  for (const col of [
    { id: 'kind', title: 'סוג', type: 'text' },
    { id: 'price', title: 'מחיר', type: 'numbers' },
    { id: 'unit', title: 'ליחידה', type: 'numbers' },
    { id: 'qty', title: 'כמות', type: 'numbers' },
    { id: 'sel', title: 'נבחר', type: 'checkbox' },
  ])
    await api.post(`/boards/${subBoard}/columns`, col);
  await api.patch(`/items/${base}`, { cells: { kind: 'בסיס', price: 5000 } });
  await api.patch(`/items/${await sub('חיבור WhatsApp')}`, { cells: { kind: 'תוספת', price: 1200 } });
  await api.patch(`/items/${await sub('התראת איחור')}`, { cells: { kind: 'תוספת', price: 350 } });
  await api.patch(`/items/${await sub('מנוי')}`, {
    cells: { kind: 'מנוי', unit: 150, qty: 5, sel: { checked: true } },
  });

  // The template: the "quote and agreement" starter, mapped to this board (what the builder's pickers would set).
  type Section = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const template = await api.post<{ id: string; sections: Section[]; settings: Record<string, unknown> }>(
    '/idoc-templates',
    {
      name: `הצעת מחיר ${Date.now()}`,
      starter: 'quote_agreement',
      board_id: board.id,
    },
  );
  const filter = (v: string) => ({
    kind: 'subitems',
    relation_column_key: null,
    filter_column_key: 'kind',
    filter_values: [v],
  });
  const sections = template.sections.map((s: Section): Section => {
    if (s.kind === 'header') return { ...s, fields: [{ label: 'לכבוד', value: '{col:client}' }, ...s.fields] };
    if (s.kind === 'lines' && s.preset === 'fixed_lines')
      return { ...s, source: filter('בסיס'), mapping: { ...s.mapping, price: 'price' } };
    if (s.kind === 'lines' && s.preset === 'addons')
      return { ...s, source: filter('תוספת'), mapping: { ...s.mapping, price: 'price', selected: 'sel' } };
    if (s.kind === 'lines' && s.preset === 'subscription')
      return {
        ...s,
        source: filter('מנוי'),
        mapping: { ...s.mapping, recurring_unit_price: 'unit', quantity: 'qty', selected: 'sel' },
      };
    if (s.kind === 'lines') return { ...s, source: filter('צד שלישי') };
    if (s.kind === 'signature') return { ...s, signature_column_key: 'sig', file_column_key: 'files' };
    return s;
  });
  await api.patch(`/idoc-templates/${template.id}`, {
    sections,
    settings: {
      ...template.settings,
      contact_email_column_key: 'mail',
      contact_name_column_key: 'client',
      total_one_time_column_key: 'total',
    },
  });

  // The item card → Documents → new from the template: the builder opens on the item's real rows.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  await page.locator('[data-testid="card-tab"][data-tab-id="documents"]').click();
  await expect(page.getByTestId('idoc-empty')).toBeVisible();
  await page.getByTestId('idoc-new').click();
  await page.getByTestId('idoc-new-from-template').first().click();
  const builder = page.getByTestId('idoc-builder');
  await expect(builder).toBeVisible();
  await expect(builder.getByTestId('idoc-section-row')).toHaveCount(sections.length);
  await expect(builder.getByTestId('idoc-preview-page').getByText('חיבור WhatsApp')).toBeVisible();
  // Screens for the operating guide (docs/INTERACTIVE-DOCUMENTS.he.md, the help-center package).
  await page.screenshot({ path: 'test-results/idoc-guide-editor.png' });
  // A header field typed by hand instead of a field of the item (the product owner): the preview shows it as typed.
  await builder.getByTestId('idoc-section-row').first().click();
  const bound = builder.getByTestId('idoc-bound').last();
  await bound.locator('button').first().click();
  await page.getByText('✎ הקלדת ערך קבוע').click();
  await builder.getByTestId('idoc-bound-text').fill('ערך ידני 77');
  await expect(builder.getByTestId('idoc-preview-page').getByText('ערך ידני 77')).toBeVisible();
  // A click on a section in the page picks it, as the list does: outlined there, active in the list.
  const addons = builder.getByTestId('idoc-preview-page').locator('[data-pick]', { hasText: 'חיבור WhatsApp' }).first();
  await addons.click({ position: { x: 8, y: 8 } });
  await expect(addons).toHaveAttribute('aria-current', 'true');
  const picked = await addons.getAttribute('data-pick');
  await expect(
    builder.locator(`[data-testid="idoc-section-row"][data-section="${picked}"] [aria-current="true"]`),
  ).toBeVisible();
  // The catalog lists the presets in groups; "soon" ones are disabled.
  await builder.getByTestId('idoc-add-section').click();
  await expect(page.getByTestId('idoc-add-faq')).toBeVisible();
  await page.getByTestId('idoc-add-faq').click();
  await expect(builder.getByTestId('idoc-section-row')).toHaveCount(sections.length + 1);
  await builder.getByTestId('idoc-builder-save').click();
  // Saved: nothing left to save, so closing does not ask about unsaved changes.
  await expect(page.getByText('נשמר', { exact: true })).toBeVisible();
  await expect(builder.getByTestId('idoc-builder-save')).toBeDisabled();
  await builder.getByTestId('idoc-builder-close').click();
  await expect(builder).toHaveCount(0);

  // Mark as sent (the sender shares the link): the row shows "sent".
  await page.getByTestId('idoc-send').click();
  await page.getByRole('switch').last().check();
  await page.getByTestId('idoc-send-confirm').click();
  await expect(page.getByTestId('idoc-row-doc')).toHaveAttribute('data-status', 'sent');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/idoc-guide-tab.png' });
  await page.getByTestId('idoc-share').first().screenshot({ path: 'test-results/idoc-guide-share.png' });
  const doc = (await api.get<{ data: { url: string; id: string }[] }>(`/items/${item.id}/idocs`)).data[0]!;

  // The client: a fresh browser, no session.
  const client = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cp = await client.newPage();
  forbidNativeDialogs(cp);
  await cp.goto(new URL(doc.url).pathname);
  await expect(cp.getByTestId('idoc-page')).toBeVisible();
  await expect(cp.getByText('סטודיו הגל הלבן').first()).toBeVisible();
  const total = cp.getByTestId('idoc-grand-total');
  // 5,000 base before VAT → 5,900 with 18% VAT.
  await expect(total).toContainText('5,900');
  await cp.screenshot({ path: 'test-results/idoc-public-desktop.png', fullPage: true });
  const whatsapp = cp.locator('[data-testid="idoc-row"]', { hasText: 'חיבור WhatsApp' });
  await whatsapp.getByTestId('idoc-row-check').check();
  await expect(whatsapp).toHaveAttribute('data-selected', 'true');
  // + 1,200 → 6,200 × 1.18 = 7,316.
  await expect(total).toContainText('7,316');
  // Select all / clear all of the add-ons (the product owner): a tri-state box, the total follows at once.
  const selectAll = cp.locator('#sec-s5').getByTestId('idoc-select-all');
  await expect(selectAll).not.toBeChecked();
  await selectAll.check();
  await expect(cp.locator('#sec-s5 [data-testid="idoc-row"][data-selected="false"]')).toHaveCount(0);
  await expect(total).not.toContainText('7,316');
  await selectAll.uncheck();
  await expect(cp.locator('#sec-s5 [data-testid="idoc-row"][data-selected="true"]')).toHaveCount(0);
  await expect(total).toContainText('5,900');
  await whatsapp.getByTestId('idoc-row-check').check();
  await expect(total).toContainText('7,316');
  await expect.poll(() => selectAll.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
  // The client downloads the PDF of what they see now.
  const [pdf] = await Promise.all([cp.waitForEvent('download'), cp.getByTestId('idoc-public-pdf').click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  // A real PDF of some size, its Hebrew drawn in reading order: pdf.js turns a right-to-left run back into reading
  // order when it extracts it, so a line drawn mirrored would come back reversed.
  const pdfFile = (await pdf.path())!;
  const pdfBytes = readFileSync(pdfFile);
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdfBytes.length).toBeGreaterThan(5000);
  const pdfContent = await pdfText(pdfFile);
  expect(pdfContent).toContain('לכבוד סטודיו הגל הלבן');
  expect(pdfContent).toContain('ערך ידני 77');
  expect(pdfContent).not.toContain([...'סטודיו הגל הלבן'].reverse().join(''));
  const head = await cp.request.get(`/api/v1/public/idocs/${new URL(doc.url).pathname.split('/p/')[1]}/pdf`);
  expect(head.headers()['content-type']).toBe('application/pdf');

  // A question about the add-ons arrives on the item.
  await cp.locator('#sec-s5').getByTestId('idoc-ask-section').click();
  await cp.getByTestId('idoc-question-input').fill('ה-SMS יוצא גם על קבלה?');
  await cp.getByTestId('idoc-question-send').click();
  await expect(cp.getByTestId('idoc-questions')).toContainText('ה-SMS יוצא גם על קבלה?');

  // Sign: name, the consent, a drawn signature.
  await cp.getByTestId('idoc-sign-name').fill('נועה פרץ');
  await cp.getByTestId('idoc-consent').first().check();
  const pad = await cp.getByTestId('idoc-signature-pad').boundingBox();
  await cp.mouse.move(pad!.x + 30, pad!.y + 60);
  await cp.mouse.down();
  for (const [dx, dy] of [
    [80, 20],
    [140, 70],
    [200, 30],
    [260, 60],
  ] as const)
    await cp.mouse.move(pad!.x + dx, pad!.y + dy);
  await cp.mouse.up();
  await cp.getByTestId('idoc-sign').click();
  await expect(cp.getByTestId('idoc-signed')).toContainText('נועה פרץ');

  // The phone view of the signed page.
  await cp.setViewportSize({ width: 390, height: 844 });
  await cp.reload();
  await expect(cp.getByTestId('idoc-signed')).toBeVisible();
  await cp.screenshot({ path: 'test-results/idoc-public-phone.png', fullPage: true });
  // the product owner: inside a section text wraps — no section is wider than its box, the page never scrolls sideways.
  const overflow = await cp.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    sections: Array.from(document.querySelectorAll('[data-testid="idoc-page"] section'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.id),
  }));
  expect(overflow).toEqual({ page: 0, sections: [] });
  await client.close();

  // Back in the app: the item's update, the document status, the signature cell and its certificate.
  await page.reload();
  await expect(page.locator('[data-testid="update-document"]').first()).toBeVisible();
  await page.goto(`/a/demo/b/${board.id}`);
  const cell = page.locator(`[data-item-id="${item.id}"] [data-column="sig"]`).first().getByTestId('signature-cell');
  await expect(cell).toContainText('נועה פרץ');
  await cell.click();
  const cert = page.getByTestId('signature-certificate');
  await expect(cert).toBeVisible();
  await expect(cert).toContainText('SHA-256');
  await expect(cert).toContainText('חיבור WhatsApp');
  await page.screenshot({ path: 'test-results/idoc-guide-certificate.png' });
  await page.keyboard.press('Escape');

  // The team downloads the signed PDF from the documents tab.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  await page.locator('[data-testid="card-tab"][data-tab-id="documents"]').click();
  const [signedPdf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('idoc-pdf').first().click()]);
  expect(signedPdf.suggestedFilename()).toMatch(/-signed\.pdf$/);
});
