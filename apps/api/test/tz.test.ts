// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * A member who never chose a timezone (`users.timezone` null) follows the account's (A3). The 0034 migration moves
 * existing users from the old default to null unless their profile shows they chose it.
 */
let t: TestContext;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

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
});
afterAll(() => t?.close());

describe('users.timezone', () => {
  it('a new user has no zone of their own', async () => {
    const token = t.inviteTokenFor('admin@acme.test');
    const admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
    await t.api(admin).post('/invitations/accept', { token });
    expect((await body(await t.api(admin).get('/auth/me'))).user.timezone).toBeNull();
    expect((await body(await t.api(admin, acmeId).get('/users/me'))).timezone).toBeNull();
  });

  it('the migration clears the old default only where it was never chosen', async () => {
    const user = async (email: string, timezone: string | null) => {
      const id = newId();
      await t.pg.query(`insert into users (id, email, name, timezone) values ($1, $2, $3, $4)`, [
        id,
        email,
        email,
        timezone,
      ]);
      return id;
    };
    const untouched = await user('untouched@x.test', 'Asia/Jerusalem');
    const chose = await user('chose@x.test', 'Asia/Jerusalem');
    const otherEdit = await user('other@x.test', 'Asia/Jerusalem');
    const london = await user('london@x.test', 'Europe/London');
    const event = (actor: string, after: Json) =>
      t.pg.query(
        `insert into activity_log (id, account_id, type, actor_id, payload) values ($1, $2, 'user.profile_updated', $3, $4)`,
        [newId(), acmeId, actor, JSON.stringify({ before: {}, after })],
      );
    await event(chose, { timezone: 'Asia/Jerusalem' }); // moved away and back, or picked it on purpose
    await event(otherEdit, { title: 'Sales' }); // saved the profile without touching the zone

    const sql = readFileSync(fileURLToPath(new URL('../drizzle/0034_tz.sql', import.meta.url)), 'utf8');
    const update = sql.split('--> statement-breakpoint').at(-1)!;
    await t.pg.query(update);

    const zones = Object.fromEntries(
      (
        await t.pg.query<{ id: string; timezone: string | null }>(
          `select id, timezone from users where id = any($1::varchar[])`,
          [[untouched, chose, otherEdit, london]],
        )
      ).rows.map((r) => [r.id, r.timezone]),
    );
    expect(zones).toEqual({
      [untouched]: null,
      [chose]: 'Asia/Jerusalem',
      [otherEdit]: null,
      [london]: 'Europe/London',
    });
  });
});
