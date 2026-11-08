// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { EMPTY_BUCKET, resolveField, type QueryEnv } from '@bines/shared';
import type { Column, Item, Member } from '../board-api';
import { bucketSeed } from './bucket-seed';

const cols = [
  { id: 'stage', type: 'status', settings: { labels: [{ id: 1, label: 'פיתוח' }] } },
  { id: 'tags', type: 'dropdown', settings: {} },
  { id: 'owner', type: 'people', settings: {} },
  { id: 'labels', type: 'tags', settings: {} },
  { id: 'done', type: 'checkbox', settings: {} },
  { id: 'n', type: 'numbers', settings: {} },
  { id: 'stars', type: 'rating', settings: {} },
  { id: 'due', type: 'date', settings: {} },
  { id: 'txt', type: 'text', settings: {} },
  { id: 'mail', type: 'email', settings: {} },
  { id: 'rel', type: 'board_relation', settings: {} },
  { id: 'f', type: 'formula', settings: {} },
  { id: 'files', type: 'file', settings: {} },
  { id: 'votes', type: 'vote', settings: {} },
];
const env: QueryEnv = {
  today: '2026-10-08',
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
  columns: cols,
  meId: 'u1',
};
const members = [{ user_id: 'u1', name: 'Dana' }] as Member[];
const field = (id: string) => resolveField(id, env);
const seed = (id: string, key: string, extra: { columns?: Column[]; rows?: Item[]; title?: string } = {}) =>
  bucketSeed(field(id), key, { groupId: 'g1', members, env, ...extra });
const row = (cells: Item['cells']) => ({ id: 'i1', cells }) as unknown as Item;

describe('a new item in a grouped section gets the section value', () => {
  it('label, multi-value and simple columns map their key to a value', () => {
    expect(seed('stage', '1')).toEqual({ groupId: 'g1', cells: { stage: { index: 1 } } });
    expect(seed('tags', '3')).toEqual({ groupId: 'g1', cells: { tags: { ids: [3] } } });
    expect(seed('owner', 'u1')!.cells.owner).toEqual({ persons_and_teams: [{ id: 'u1', kind: 'person' }] });
    expect(seed('owner', 't9')!.cells.owner).toEqual({ persons_and_teams: [{ id: 't9', kind: 'team' }] });
    expect(seed('labels', 'tg')!.cells.labels).toEqual({ tag_ids: ['tg'] });
    expect(seed('done', 'checked')!.cells.done).toEqual({ checked: true });
    expect(seed('n', '42')!.cells.n).toBe(42);
    expect(seed('stars', '4')!.cells.stars).toEqual({ rating: 4 });
  });

  it('a date bucket gets a date inside it', () => {
    expect(seed('due', 'today')!.cells.due).toEqual({ date: '2026-10-08' });
  });

  it('the empty section leaves the value empty', () => {
    expect(seed('stage', EMPTY_BUCKET)).toEqual({ groupId: 'g1', cells: {} });
  });

  it('grouped by the board group: that group, no cells', () => {
    expect(bucketSeed(resolveField('__group__', env), 'g7', { groupId: 'g1', members, env })).toEqual({
      groupId: 'g7',
      cells: {},
    });
  });

  it('text keeps the section label casing; keyless values copy an item already in the section', () => {
    expect(seed('txt', 'alpha', { title: 'Alpha' })!.cells.txt).toBe('Alpha');
    expect(seed('txt', 'alpha', { rows: [row({ txt: { value: 'ALPHA', text: 'ALPHA' } })] })!.cells.txt).toBe('ALPHA');
    const link = { item_ids: ['x1'] };
    expect(seed('rel', 'acme', { rows: [row({}), row({ rel: { value: link, text: 'Acme' } })] })!.cells.rel).toBe(link);
    expect(
      seed('mail', 'a@b.c', { rows: [row({ mail: { value: { email: 'a@b.c' }, text: 'a@b.c' } })] })!.cells.mail,
    ).toEqual({ email: 'a@b.c' });
    // Nothing to copy from (a windowed section with no loaded row): no add.
    expect(seed('rel', 'acme')).toBeUndefined();
  });

  it('computed and own-endpoint columns cannot be seeded', () => {
    expect(seed('f', 'x')).toBeUndefined();
    expect(seed('files', 'x')).toBeUndefined();
    expect(seed('votes', '1')).toBeUndefined();
    expect(bucketSeed(resolveField('__creator__', env), 'u1', { groupId: 'g1', members, env })).toBeUndefined();
  });

  it('a column I may not edit: the item is created without the value; read-only: no add', () => {
    const restricted = [{ id: 'stage', restricted_edit: true }] as Column[];
    expect(seed('stage', '1', { columns: restricted })).toEqual({ groupId: 'g1', cells: {} });
    const readOnly = [{ id: 'stage', read_only: true }] as Column[];
    expect(seed('stage', '1', { columns: readOnly })).toBeUndefined();
  });

  it('no group on the board: nowhere to add', () => {
    expect(bucketSeed(field('stage'), '1', { groupId: undefined, members, env })).toBeUndefined();
  });
});
