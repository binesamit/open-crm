// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** r16motion: the user's animations setting rides on GET / PUT /me/appearance (jsonb, no migration). */
let t: TestContext;
let owner: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
});
afterAll(async () => {
  await t.close();
});

describe('animations per user', () => {
  it('defaults to "by device", saves a choice beside the text size, and null goes back', async () => {
    expect(await body(await t.api(owner).get('/me/appearance'))).toMatchObject({ motion: 'system', user: {} });
    await t.api(owner).put('/me/appearance', { text_size: 'large' });
    const put = await t.api(owner).put('/me/appearance', { motion: 'off' });
    expect(put.status).toBe(200);
    expect(await body(put)).toMatchObject({
      motion: 'off',
      text_size: 'large',
      user: { motion: 'off', text_size: 'large' },
    });
    expect(await body(await t.api(owner).get('/me/appearance'))).toMatchObject({ motion: 'off' });
    expect(await body(await t.api(owner).put('/me/appearance', { motion: null }))).toMatchObject({
      motion: 'system',
      text_size: 'large',
    });
    expect((await t.api(owner).put('/me/appearance', { motion: 'bouncy' })).status).toBeGreaterThanOrEqual(400);
  });
});
