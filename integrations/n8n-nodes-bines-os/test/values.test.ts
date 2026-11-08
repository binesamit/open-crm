// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  autoMapping,
  mapperFields,
  needsMembers,
  simplifyItem,
  toCells,
  toCellValue,
  ValueError,
  type IntegrationColumn,
} from '../nodes/shared/values';
import { MEMBERS, SCHEMA } from './mock';

const col = (id: string) => SCHEMA.columns.find((c) => c.id === id)!;
const typed = (type: string, extra: Partial<IntegrationColumn> = {}): IntegrationColumn => ({
  id: type,
  title: type,
  type,
  description: null,
  writable: true,
  value_model: 'text',
  options: null,
  value_schema: null,
  ...extra,
});

describe('column values → stored values', () => {
  it('status by label text (any case), by id, and refuses an unknown label naming the labels', () => {
    expect(toCellValue(col('status'), 'done')).toEqual({ index: 1 });
    expect(toCellValue(col('status'), 0)).toEqual({ index: 0 });
    expect(toCellValue(col('status'), '1')).toEqual({ index: 1 });
    expect(() => toCellValue(col('status'), 'Lost')).toThrow(/Labels: New, Done/);
  });

  it('people by email, unique name or id; ambiguous and unknown names fail', () => {
    expect(toCellValue(col('owner'), 'DANA@example.com, u2', MEMBERS)).toEqual({
      persons_and_teams: [
        { id: 'u1', kind: 'person' },
        { id: 'u2', kind: 'person' },
      ],
    });
    expect(toCellValue(col('owner'), 'Avi Cohen', MEMBERS)).toEqual({
      persons_and_teams: [{ id: 'u2', kind: 'person' }],
    });
    expect(() => toCellValue(col('owner'), 'Nobody', MEMBERS)).toThrow(ValueError);
    const twins = [...MEMBERS, { user_id: 'u3', name: 'Dana Levi', email: 'dana2@example.com' }];
    expect(() => toCellValue(col('owner'), 'Dana Levi', twins)).toThrow(/several people/);
  });

  it('dates keep their local date and time, without a time-zone shift; midnight is a date only', () => {
    expect(toCellValue(col('due'), '2026-10-06')).toEqual({ date: '2026-10-06' });
    expect(toCellValue(col('due'), '2026-10-06T14:30:00.000+03:00')).toEqual({ date: '2026-10-06', time: '14:30' });
    expect(toCellValue(col('due'), '2026-10-06T00:00:00')).toEqual({ date: '2026-10-06' });
    expect(() => toCellValue(col('due'), 'next week')).toThrow(ValueError);
  });

  it('the common types', () => {
    expect(toCellValue(typed('text'), 42)).toBe('42');
    expect(toCellValue(typed('long_text'), 'hi')).toEqual({ text: 'hi' });
    expect(toCellValue(typed('numbers'), '1,234.5')).toBe(1234.5);
    expect(() => toCellValue(typed('numbers'), 'abc')).toThrow(ValueError);
    expect(toCellValue(typed('checkbox'), true)).toEqual({ checked: true });
    expect(toCellValue(typed('checkbox'), 'false')).toBeNull();
    expect(toCellValue(typed('email'), ' a@b.co ')).toEqual({ email: 'a@b.co' });
    expect(toCellValue(col('phone'), '050-1234567')).toEqual({ phone: '050-1234567' });
    expect(toCellValue(typed('link'), 'example.com')).toEqual({ url: 'https://example.com' });
    expect(toCellValue(typed('rating'), '4')).toEqual({ rating: 4 });
    expect(toCellValue(typed('timeline'), '2026-10-01 - 2026-10-09')).toEqual({ from: '2026-10-01', to: '2026-10-09' });
    expect(toCellValue(typed('hour'), '09:15')).toEqual({ hour: 9, minute: 15 });
    expect(
      toCellValue(
        typed('dropdown', {
          options: [
            { id: 1, label: 'A', color: null },
            { id: 2, label: 'B', color: null },
          ],
        }),
        'a, B',
      ),
    ).toEqual({ ids: [1, 2] });
  });

  it('other types follow their JSON Schema; a JSON object is always the raw value', () => {
    expect(toCellValue(col('country'), 'IL')).toEqual({ code: 'IL' });
    const relation = typed('board_relation', {
      value_schema: { type: 'object', properties: { item_ids: { type: 'array' } }, required: ['item_ids'] },
    });
    expect(toCellValue(relation, 'i1, i2')).toEqual({ item_ids: ['i1', 'i2'] });
    expect(toCellValue(typed('location'), '{"address":"Tel Aviv"}')).toEqual({ address: 'Tel Aviv' });
    expect(toCellValue(col('status'), { index: 0 })).toEqual({ index: 0 });
    const twoFields = typed('week', {
      value_schema: {
        type: 'object',
        properties: { start: { type: 'string' }, end: { type: 'string' } },
        required: ['start', 'end'],
      },
    });
    expect(() => toCellValue(twoFields, 'x')).toThrow(/needs a JSON value/);
  });

  it('empty input leaves the column alone', () => {
    expect(toCellValue(col('status'), '')).toBeUndefined();
    expect(toCellValue(col('status'), null)).toBeUndefined();
    expect(toCells(SCHEMA.columns, { status: '', phone: '0501234567' })).toEqual({ phone: { phone: '0501234567' } });
  });

  it('refuses unknown and read-only columns', () => {
    expect(() => toCells(SCHEMA.columns, { nope: 'x' })).toThrow(/no column "nope"/);
    expect(() => toCells(SCHEMA.columns, { files: 'x' })).toThrow(/cannot be written/);
  });

  it('knows when the member list is needed', () => {
    expect(needsMembers(SCHEMA.columns, { owner: 'dana@example.com' })).toBe(true);
    expect(needsMembers(SCHEMA.columns, { owner: { persons_and_teams: [] } })).toBe(false);
    expect(needsMembers(SCHEMA.columns, { status: 'Done' })).toBe(false);
  });
});

describe('fields and mapping', () => {
  it('renders writable columns in their n8n type, status with its labels', () => {
    const fields = mapperFields(SCHEMA.columns);
    expect(fields.map((f) => f.id)).toEqual(['status', 'phone', 'owner', 'due', 'country']);
    const status = fields.find((f) => f.id === 'status')!;
    expect(status.type).toBe('options');
    expect(status.options).toEqual([
      { name: 'New', value: 0 },
      { name: 'Done', value: 1 },
    ]);
    expect(fields.find((f) => f.id === 'due')!.type).toBe('dateTime');
  });

  it('maps columns between boards by id, then by title, with the same type', () => {
    const to: IntegrationColumn[] = [
      { ...col('status'), id: 'stage', title: 'status' },
      { ...col('phone') },
      { ...col('due'), type: 'timeline' },
    ];
    expect(autoMapping(SCHEMA.columns, to)).toMatchObject({ status: 'stage', phone: 'phone', due: null, owner: null });
  });

  it('flattens an item: its values by column title', () => {
    const out = simplifyItem(
      { id: 'i1', name: 'Dana', cells: { status: { value: { index: 1 }, text: 'Done' } } },
      SCHEMA.columns,
    );
    expect(out.column_values).toEqual({ Status: 'Done' });
    expect(out.cells).toBeTruthy();
  });
});
