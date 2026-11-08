// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EARTHY_PALETTE_HEX, LEGACY_LABEL_HEX, newId, normalizeLabelColor, PALETTE } from '@bines/shared';
import { accountSettings, columns, supportTags, views } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * D-PAL: label colours are palette keys. Migration 0080 rewrites the hex that older rows hold (column
 * labels, colouring rules, account defaults, support tags, the system view's name); until then — and for a cache or
 * an old event after — the API reads an old hex as the nearest key.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const MIGRATION = readFileSync(fileURLToPath(new URL('../drizzle/0080_own_palette.sql', import.meta.url)), 'utf8');
const VIVID = readFileSync(fileURLToPath(new URL('../drizzle/0081_vivid_palette.sql', import.meta.url)), 'utf8');
const migrate = async () => {
  for (const s of MIGRATION.split('--> statement-breakpoint')) await t.pg.exec(s);
};
const migrateVivid = async () => {
  for (const s of VIVID.split('--> statement-breakpoint')) await t.pg.exec(s);
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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Palette', workspace_id: ws.id }))).id;
});
afterAll(() => t.close());

describe('own palette', () => {
  it('a new status column starts with our keys and names (in progress / done / blocked)', async () => {
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Stage', type: 'status' }));
    expect(col.settings.labels.map((l: Json) => [l.label, l.color])).toEqual([
      ['בתהליך', 'yellow'],
      ['הושלם', 'forest'],
      ['חסום', 'crimson'],
    ]);
  });

  it('an English account starts its status columns in English (In progress / Done / Blocked); the built-in trio follows the language', async () => {
    expect((await as(admin).patch('/accounts/me', { settings: { locale: { language: 'en' } } })).status).toBe(200);
    const me = await body(await as(admin).get('/accounts/me'));
    expect(me.settings.defaults.status_labels.map((l: Json) => l.label)).toEqual(['In progress', 'Done', 'Blocked']);
    const col = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Phase', type: 'status' }));
    expect(col.settings.labels.map((l: Json) => [l.label, l.color])).toEqual([
      ['In progress', 'yellow'],
      ['Done', 'forest'],
      ['Blocked', 'crimson'],
    ]);
    expect((await as(admin).patch('/accounts/me', { settings: { locale: { language: 'he' } } })).status).toBe(200);
  });

  it('API input with a hex is stored as the nearest key', async () => {
    const col = await body(
      await as(admin).post(`/boards/${boardId}/columns`, {
        title: 'Hexed',
        type: 'status',
        settings: {
          labels: [
            { id: 0, label: 'Old', color: '#fdab3d', index: 0 },
            { id: 1, label: 'Mine', color: '#1a8f4f', index: 1 },
          ],
        },
      }),
    );
    expect(col.settings.labels.map((l: Json) => l.color)).toEqual(['yellow', 'forest']);
  });

  it('migration 0080: old hex → keys in labels, colouring rules, defaults, support tags; the system view is renamed', async () => {
    // As stored before: a status column, a view's colouring rule and the account defaults with the old hex values.
    const [col] = await t.db
      .select()
      .from(columns)
      .where(and(eq(columns.boardId, boardId), eq(columns.title, 'Stage')));
    await t.db
      .update(columns)
      .set({
        settings: {
          labels: [
            { id: 0, label: 'Working', color: '#fdab3d', index: 0 },
            { id: 1, label: 'Done', color: '#00c875', index: 1, is_done: true },
            { id: 2, label: 'Blocked', color: '#df2f4a', index: 2 },
            { id: 3, label: 'Custom', color: '#1a8f4f', index: 3 },
            { id: 4, label: 'Ours', color: 'plum', index: 4 },
          ],
        },
      })
      .where(eq(columns.id, col!.id));
    // Before the migration ran, an edit through the API already stores keys (the old hex read as the nearest key).
    const before = await body(await as(admin).get(`/boards/${boardId}`));
    const stage = before.columns.find((c: Json) => c.title === 'Stage');
    const saved = await body(
      await as(admin).patch(`/boards/${boardId}/columns/${stage.id}`, { settings: { labels: stage.settings.labels } }),
    );
    expect(saved.settings.labels.map((l: Json) => l.color)).toEqual(['yellow', 'forest', 'crimson', 'forest', 'plum']);
    await t.db.update(columns).set({ settings: stage.settings }).where(eq(columns.id, col!.id));

    const viewList = await body(await as(admin).get(`/boards/${boardId}/views`));
    const main = viewList.data.find((v: Json) => v.is_system);
    await t.db
      .update(views)
      .set({
        name: 'טבלה ראשית',
        settings: sql`jsonb_set(${views.settings}, '{coloring}', ${JSON.stringify([
          {
            id: 'r1',
            rule: { column_id: 'name', operator: 'is_not_empty', values: [] },
            target: 'row',
            color: '#e2445c',
          },
        ])}::jsonb)`,
      })
      .where(eq(views.id, main.id));
    await t.db
      .update(accountSettings)
      .set({
        settings: sql`jsonb_set(${accountSettings.settings}, '{defaults}', ${JSON.stringify({
          status_labels: [
            { label: 'A', color: '#579bfc' },
            { label: 'B', color: '#00c875', is_done: true },
          ],
        })}::jsonb)`,
      })
      .where(eq(accountSettings.accountId, acmeId));
    const [tag] = await t.db.insert(supportTags).values({ id: newId(), name: 'old-tag', color: '#ff158a' }).returning();

    // The account defaults read as keys before the migration, too.
    expect(
      (await body(await as(admin).get('/accounts/me'))).settings.defaults.status_labels.map((l: Json) => l.color),
    ).toEqual(['blue', 'forest']);

    await migrate();

    const [after] = await t.db.select().from(columns).where(eq(columns.id, col!.id));
    expect((after!.settings as Json).labels.map((l: Json) => l.color)).toEqual([
      'yellow',
      'forest',
      'crimson',
      'forest', // an unknown hex → the nearest palette colour
      'plum', // a key stays
    ]);
    const [v] = await t.db.select().from(views).where(eq(views.id, main.id));
    expect(v!.name).toBe('טבלה');
    expect((v!.settings as Json).coloring[0].color).toBe('crimson');
    const [s] = await t.db.select().from(accountSettings).where(eq(accountSettings.accountId, acmeId));
    expect((s!.settings as Json).defaults.status_labels.map((l: Json) => l.color)).toEqual(['blue', 'forest']);
    const [tg] = await t.db.select().from(supportTags).where(eq(supportTags.id, tag!.id));
    expect(tg!.color).toBe('#a8566e'); // 0080 wrote the earthy pink …
    await migrateVivid();
    const [tv] = await t.db.select().from(supportTags).where(eq(supportTags.id, tag!.id));
    expect(tv!.color).toBe(PALETTE.pink.light); // … 0081 makes it our vivid pink
    // Running it again changes nothing.
    await migrate();
    const [again] = await t.db.select().from(columns).where(eq(columns.id, col!.id));
    expect(again!.settings).toEqual(after!.settings);

    // An account that saved the old built-in default trio as is gets ours; changed defaults (above) are kept.
    await t.db
      .update(accountSettings)
      .set({
        settings: sql`jsonb_set(${accountSettings.settings}, '{defaults}', ${JSON.stringify({
          status_labels: [
            { label: 'בעבודה', color: '#fdab3d' },
            { label: 'הושלם', color: '#00c875', is_done: true },
            { label: 'תקוע', color: '#df2f4a' },
          ],
        })}::jsonb)`,
      })
      .where(eq(accountSettings.accountId, acmeId));
    await migrate();
    const [d] = await t.db.select().from(accountSettings).where(eq(accountSettings.accountId, acmeId));
    expect((d!.settings as Json).defaults.status_labels).toEqual([
      { label: 'בתהליך', color: 'yellow' },
      { label: 'הושלם', color: 'forest', is_done: true },
      { label: 'חסום', color: 'crimson' },
    ]);
  });

  it('the migration holds the same hex → key table as the code', () => {
    const values = [...MIGRATION.matchAll(/\('(#[0-9a-f]{6})', '([a-z]+)'\)/g)].map((m) => [m[1]!, m[2]!]);
    expect(Object.fromEntries(values)).toEqual(LEGACY_LABEL_HEX);
    expect(values).toHaveLength(Object.keys(LEGACY_LABEL_HEX).length);
    // The nearest-colour anchors are the earlier (earthy) palette's light and dark values, which the code still reads
    // exactly as their key (olive / brown are renamed: gold).
    const anchors = [...MIGRATION.matchAll(/\('([a-z]+)', '(#[0-9a-f]{6})'\)/g)].map((m) => [m[2]!, m[1]!] as const);
    for (const [h, k] of anchors) expect(EARTHY_PALETTE_HEX[h], h).toBe(normalizeLabelColor(k));
    expect(new Set(anchors.map(([h]) => h))).toEqual(new Set(Object.keys(EARTHY_PALETTE_HEX)));
  });

  it('migration 0081 moves every earthy hex to the vivid light value of its key', () => {
    const pairs = [...VIVID.matchAll(/\('(#[0-9a-f]{6})', '(#[0-9a-f]{6})'\)/g)].map((m) => [m[1]!, m[2]!]);
    expect(Object.fromEntries(pairs)).toEqual(
      Object.fromEntries(Object.entries(EARTHY_PALETTE_HEX).map(([h, k]) => [h, PALETTE[k].light])),
    );
  });
});
