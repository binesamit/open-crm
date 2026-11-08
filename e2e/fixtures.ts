// SPDX-License-Identifier: AGPL-3.0-only
import { type APIRequestContext, test as base } from '@playwright/test';
import { ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Isolation for specs that want a clean slate (s4f-e2e). Every spec still runs in the one local `demo` account
 * as the seeded owner; what it creates lives in a workspace of its own Playwright worker and is removed again:
 *
 *   import { expect, test } from './fixtures';
 *   test('…', async ({ page, scratch }) => {
 *     const board = await scratch.board('r19small');      // `r19small mxyz1a2b123`, in this worker's workspace
 *     …
 *   });                                                     // the board goes to the trash after the test
 *
 * - `ownerApi` (per worker): the owner's API session (its own browser context), with the demo headers.
 * - `scratchWorkspace` (per worker): `e2e w<worker> <uid>` — removed after the worker's last test (afterAll); a
 *   workspace still holding boards someone made through the UI stays and the cleanup script takes it later.
 * - `scratch` (per test): boards with unique names in that workspace, deleted when the test ends.
 *
 * Names end in a `uid()` token, so `apps/api/scripts/cleanup-local-test-data.ts` recognises any leftover.
 */
export { expect } from '@playwright/test';

const BASE_URL = WEB_URL;

/** A base-36 time stamp + 3 digits: unique per call, and a "random suffix" for the cleanup script. */
export const uid = () =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`;
export const uniqueName = (prefix: string) => `${prefix} ${uid()}`;

export type OwnerApi = {
  request: APIRequestContext;
  /** `x-account-id` (demo) + origin — what every account-scoped call needs. */
  headers: Record<string, string>;
  accountId: string;
  /** JSON call on `/api/v1<path>`; throws with the body when the answer is not 2xx. */
  call: <T = unknown>(method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, data?: unknown) => Promise<T>;
};

export type Scratch = {
  workspaceId: string;
  /** A new board `<prefix> <uid>` in this worker's workspace (through the API); deleted after the test. */
  board: (prefix: string) => Promise<{ id: string; name: string }>;
};

export const test = base.extend<
  { scratch: Scratch },
  { ownerApi: OwnerApi; scratchWorkspace: { id: string; name: string } }
>({
  ownerApi: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ baseURL: BASE_URL, locale: 'he-IL' });
      const page = await context.newPage();
      await signIn(page);
      const { accountId, headers } = await ownerContext(page);
      await page.close();
      const request = context.request;
      const call: OwnerApi['call'] = async (method, path, data) => {
        const res = await request[method](`/api/v1${path}`, { headers, data });
        if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as never;
      };
      await use({ request, headers, accountId, call });
      await context.close();
    },
    { scope: 'worker' },
  ],

  scratchWorkspace: [
    async ({ ownerApi }, use, workerInfo) => {
      const name = `e2e w${workerInfo.workerIndex} ${uid()}`;
      const ws = await ownerApi.call<{ id: string }>('post', '/workspaces', { name, kind: 'open' });
      await use({ id: ws.id, name });
      // afterAll of this worker: only an empty workspace can go (boards made through the UI keep it; the cleanup
      // script removes it later).
      await ownerApi.call('delete', `/workspaces/${ws.id}`).catch((e: Error) => {
        console.warn(`e2e: workspace "${name}" stays (${e.message.slice(0, 120)})`);
      });
    },
    { scope: 'worker' },
  ],

  scratch: async ({ ownerApi, scratchWorkspace }, use) => {
    const made: string[] = [];
    await use({
      workspaceId: scratchWorkspace.id,
      board: async (prefix) => {
        const name = uniqueName(prefix);
        const board = await ownerApi.call<{ id: string }>('post', '/boards', {
          name,
          workspace_id: scratchWorkspace.id,
        });
        made.push(board.id);
        return { id: board.id, name };
      },
    });
    for (const id of made) await ownerApi.call('delete', `/boards/${id}`).catch(() => undefined);
  },
});
