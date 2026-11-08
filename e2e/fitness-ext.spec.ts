// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod — the "כושר" catalogue extension (extensions/catalog/fitness) on the core it needs
 * - an extension tab that uses more boards than its own (`settings.extension.board_ids`, picked in the app's dialog);
 * - on a phone the frame fills the screen, and a view whose manifest says `offline` is not covered by the offline
 *   screen: a set ticked without a network waits in the extension's queue and is sent when the network is back.
 * The boards are built here through the API (a workouts board whose subitems link to a library, a log with sets).
 */
const PORT = Number(process.env.E2E_FITNESS_PORT ?? 3996);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const api = (path: string) => `/api/v1${path}`;
type Headers = { 'x-account-id': string; origin: string };
type Json = Record<string, unknown> & { id: string };

let samples: ChildProcess | null = null;
test.beforeAll(async () => {
  const script = fileURLToPath(new URL('../extensions/catalog/serve.mjs', import.meta.url));
  samples = spawn(process.execPath, [script, String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`${ORIGIN}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the catalogue sample server did not start');
});
test.afterAll(() => {
  samples?.kill();
});

const post = async (page: Page, headers: Headers, path: string, data: unknown) => {
  const res = await page.request.post(api(path), { headers, data });
  expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as Json;
};
const get = async (page: Page, headers: Headers, path: string) =>
  (await (await page.request.get(api(path), { headers })).json()) as Json & { data: Json[] };

/** Workouts (subitems → library), a library of two exercises, a log with sets; one workout of two exercises. */
const buildBoards = async (page: Page, headers: Headers, t: string) => {
  const ws = (await get(page, headers, '/workspaces')).data[0]!.id;
  const board = (name: string) => post(page, headers, '/boards', { name: `${name} ${t}`, workspace_id: ws });
  const library = await board('ספריית תרגילים');
  const workouts = await board('אימונים');
  const log = await board('יומן אימונים');
  const exA = await post(page, headers, `/boards/${library.id}/items`, { name: 'פולי עליון' });
  const exB = await post(page, headers, `/boards/${library.id}/items`, { name: 'חתירה במכונה' });
  // The subitems boards come with the first subitem; then their columns.
  const w = await post(page, headers, `/boards/${workouts.id}/items`, { name: 'אימון A' });
  const first = await post(page, headers, `/items/${w.id}/subitems`, { name: 'פולי עליון' });
  const wSub = (await get(page, headers, `/boards/${workouts.id}`)).subitems_board_id as string;
  for (const c of [
    { id: 'ex', title: 'תרגיל', type: 'board_relation', settings: { board_ids: [library.id] } },
    { id: 'ord', title: 'סדר', type: 'numbers' },
    { id: 'sets', title: 'סטים', type: 'numbers' },
    { id: 'reps', title: 'חזרות', type: 'numbers' },
    { id: 'kg', title: 'משקל (ק״ג)', type: 'numbers' },
    { id: 'rest', title: 'מנוחה (שנ׳)', type: 'numbers' },
  ])
    await post(page, headers, `/boards/${wSub}/columns`, c);
  await page.request.patch(api(`/items/${first.id}`), {
    headers,
    data: { cells: { ex: { item_ids: [exA.id] }, ord: 1, sets: 2, reps: 10, kg: 40, rest: 60 } },
  });
  await post(page, headers, `/items/${w.id}/subitems`, {
    name: 'חתירה במכונה',
    cells: { ex: { item_ids: [exB.id] }, ord: 2, sets: 2, reps: 12, kg: 35, rest: 60 },
  });
  for (const c of [
    { id: 'date', title: 'תאריך', type: 'date' },
    { id: 'wo', title: 'אימון', type: 'board_relation', settings: { board_ids: [workouts.id] } },
    { id: 'minutes', title: 'משך (דק׳)', type: 'numbers' },
  ])
    await post(page, headers, `/boards/${log.id}/columns`, c);
  const tmp = await post(page, headers, `/boards/${log.id}/items`, { name: 'tmp' });
  await post(page, headers, `/items/${tmp.id}/subitems`, { name: 'tmp' });
  const lSub = (await get(page, headers, `/boards/${log.id}`)).subitems_board_id as string;
  for (const c of [
    { id: 'ex', title: 'תרגיל', type: 'board_relation', settings: { board_ids: [library.id] } },
    { id: 'set', title: 'סט', type: 'numbers' },
    { id: 'reps', title: 'חזרות', type: 'numbers' },
    { id: 'kg', title: 'משקל (ק״ג)', type: 'numbers' },
  ])
    await post(page, headers, `/boards/${lSub}/columns`, c);
  await page.request.delete(api(`/items/${tmp.id}`), { headers });
  return { library, workouts, log, lSub };
};

const install = async (page: Page, headers: Headers) => {
  const list = (await get(page, headers, '/extensions')) as unknown as { installed: { id: string; key: string }[] };
  for (const i of list.installed.filter((x) => x.key === 'fitness'))
    await page.request.delete(api(`/extensions/installations/${i.id}`), { headers });
  const source = { manifest_url: `${ORIGIN}/fitness/manifest.json` };
  const preview = await post(page, headers, '/extensions/preview', source);
  const inst = await post(page, headers, '/extensions/install', {
    source,
    consent: { accept: true, scopes: (preview.manifest as { permissions: string[] }).permissions },
    manifest_digest: preview.digest,
  });
  return inst.id;
};

const logRows = async (page: Page, headers: Headers, logId: string, subId: string) => ({
  logs: (await get(page, headers, `/boards/${logId}/items`)).data.filter((i) => !i.parent_item_id),
  sets: (await get(page, headers, `/boards/${subId}/items`)).data.filter((i) => i.parent_item_id),
});

test('fitness: a workout logged from the computer, a set kept offline on the phone and sent back online', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const t = Date.now().toString(36);
  const b = await buildBoards(page, headers, t);
  const installationId = await install(page, headers);
  try {
    const view = await post(page, headers, `/boards/${b.workouts.id}/views`, {
      name: 'מצב אימון',
      type: 'extension',
      settings: { extension: { installation_id: installationId, feature: 'app', board_ids: [b.library.id, b.log.id] } },
    });
    // The token covers the picked boards (the extension reads the library and writes the log).
    const tok = await post(page, headers, `/extensions/installations/${installationId}/token`, {
      feature: 'app',
      board_id: b.workouts.id,
      view_id: view.id,
    });
    expect(tok.board_ids).toEqual([b.workouts.id, b.library.id, b.log.id]);

    // ---- the computer: first run → its proposal → save → a workout
    await page.goto(`/a/demo/b/${b.workouts.id}?view=${view.id}`);
    const f = page.frameLocator(`iframe[src^="${ORIGIN}"]`);
    await expect(f.getByTestId('fit-settings')).toBeVisible({ timeout: 30_000 });
    await f.getByTestId('fit-save-settings').click();
    await expect(f.getByTestId('fit-start')).toBeVisible({ timeout: 30_000 });
    await expect(f.getByTestId('fit-workout')).toContainText('אימון A');
    await f.getByTestId('fit-start').click();
    await expect(f.getByTestId('fit-exercise')).toHaveCount(2);
    await f.getByTestId('fit-set-check').first().click();
    await expect(f.getByTestId('fit-rest')).toBeVisible();
    await f.getByTestId('fit-finish').click();
    await f.getByTestId('fit-save').click();
    await expect(f.getByTestId('fit-saved')).toBeVisible();
    await expect(f.locator('#sync')).toHaveText('הכול נשמר', { timeout: 15_000 });
    let rows = await logRows(page, headers, b.log.id, b.lSub);
    expect(rows.logs).toHaveLength(1);
    expect(rows.logs[0]!.name).toContain('אימון A');
    expect((rows.logs[0]!.cells as Record<string, { text?: string }>).wo?.text).toBe('אימון A');
    expect(rows.sets).toHaveLength(1);
    expect((rows.sets[0]!.cells as Record<string, { text?: string }>).reps?.text).toBe('10');

    // ---- the phone: the frame fills the screen; offline the set waits, back online it is sent
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      storageState: await page.context().storageState(),
    });
    const p = await phone.newPage();
    forbidNativeDialogs(p);
    await p.goto(`/a/demo/b/${b.workouts.id}?view=${view.id}`);
    const g = p.frameLocator(`iframe[src^="${ORIGIN}"]`);
    await expect(g.getByTestId('fit-start')).toBeVisible({ timeout: 30_000 });
    const h = await p.getByTestId('ext-view-box').evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThan(420);
    await g.getByTestId('fit-start').click();
    await expect(g.getByTestId('fit-exercise')).toHaveCount(1);
    await expect(g.locator('#sync')).toHaveText('הכול נשמר', { timeout: 15_000 });
    await phone.setOffline(true);
    await g.getByTestId('fit-set-check').first().click();
    await expect(g.locator('#sync')).toContainText('ממתינים');
    // The app's blocking offline screen stays away; its banner says so.
    await expect(p.getByTestId('pwa-offline')).toHaveCount(0);
    await expect(p.getByTestId('offline-banner')).toBeVisible();
    await phone.setOffline(false);
    await expect(g.locator('#sync')).toHaveText('הכול נשמר', { timeout: 30_000 });
    rows = await logRows(page, headers, b.log.id, b.lSub);
    expect(rows.logs).toHaveLength(2);
    expect(rows.sets).toHaveLength(2);
    await phone.close();
  } finally {
    await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
  }
});
