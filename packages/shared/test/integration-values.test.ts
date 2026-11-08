// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  cellsFromValues,
  columnValuesOf,
  integrationFields,
  rulesToFilter,
  valuesNeedMembers,
  type BoardSchema,
  type IntegrationColumn,
} from '../src';

/**
 * What integrations without code of their own (the Make app) leave to the API: plain values → cells
 * (the same rules as the n8n node's `toCells`), the column-values form, flat filter rules, text by column title.
 */
const col = (id: string, title: string, type: string, extra: Partial<IntegrationColumn> = {}): IntegrationColumn => ({
  id,
  title,
  type,
  description: null,
  writable: true,
  value_model: 'text',
  options: null,
  value_schema: null,
  linked_board_ids: null,
  ...extra,
});
const COLUMNS: IntegrationColumn[] = [
  col('name', 'Name', 'name', { writable: false }),
  col('status', 'Status', 'status', {
    value_model: 'label',
    options: [
      { id: 0, label: 'New', color: null },
      { id: 1, label: 'Done', color: null },
    ],
  }),
  col('tags', 'Tags', 'dropdown', {
    value_model: 'labels',
    options: [
      { id: 3, label: 'VIP', color: null },
      { id: 4, label: 'Lead', color: null },
    ],
  }),
  col('phone', 'Phone', 'phone'),
  col('owner', 'Owner', 'people', { value_model: 'people' }),
  col('due', 'Due', 'date', { value_model: 'date' }),
  col('span', 'Span', 'timeline'),
  col('files', 'Files', 'file', { writable: false, value_model: 'files' }),
  col('hours', 'Hours', 'numbers'),
  col('done', 'Done', 'checkbox'),
  col('site', 'Site', 'link'),
  col('at', 'At', 'hour'),
  col('label', 'Labels', 'tags', { value_model: 'tags' }),
  col('client', 'Client', 'board_relation', { value_model: 'links' }),
  col('country', 'Country', 'country', {
    value_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  }),
];
const MEMBERS = [
  { user_id: 'u1', name: 'Dana Levi', email: 'dana@example.com' },
  { user_id: 'u2', name: 'Avi Cohen', email: 'avi@example.com' },
  { user_id: 'u3', name: 'Avi Cohen', email: 'avi2@example.com' },
];

describe('plain values → cells', () => {
  it('converts every type the way the n8n node does', () => {
    expect(
      cellsFromValues(
        COLUMNS,
        {
          status: 'done',
          tags: 'vip, 4',
          phone: ' 050-1234567 ',
          owner: 'DANA@example.com, u2',
          due: '2026-10-20T14:30',
          span: '2026-10-01 - 2026-10-05',
          hours: '1,200.5',
          done: 'yes',
          site: 'example.com',
          at: '9:05',
          label: 'vip, 01JBTAG0000000000000000000',
          client: 'i1, i2, i1',
          country: 'IL',
        },
        MEMBERS,
      ),
    ).toEqual({
      status: { index: 1 },
      tags: { ids: [3, 4] },
      phone: { phone: '050-1234567' },
      owner: {
        persons_and_teams: [
          { id: 'u1', kind: 'person' },
          { id: 'u2', kind: 'person' },
        ],
      },
      due: { date: '2026-10-20', time: '14:30' },
      span: { from: '2026-10-01', to: '2026-10-05' },
      hours: 1200.5,
      done: { checked: true },
      site: { url: 'https://example.com' },
      at: { hour: 9, minute: 5 },
      label: { tag_ids: ['01JBTAG0000000000000000000'], tags: ['vip'] },
      client: { item_ids: ['i1', 'i2'] },
      country: { code: 'IL' },
    });
  });

  it('takes a JSON object as the stored value, skips empty values, and reads offsets in the time zone', () => {
    expect(cellsFromValues(COLUMNS, { status: '{"index":0}', phone: '', hours: null })).toEqual({
      status: { index: 0 },
    });
    expect(cellsFromValues(COLUMNS, { status: 1, due: '2026-10-20T00:00' })).toEqual({
      status: { index: 1 },
      due: { date: '2026-10-20' },
    });
    expect(cellsFromValues(COLUMNS, { due: '2026-10-19T21:00:00.000Z' }, [], { timeZone: 'Asia/Jerusalem' })).toEqual({
      due: { date: '2026-10-20' },
    });
    expect(cellsFromValues(COLUMNS, { due: '2026-10-19T21:00:00.000Z' })).toEqual({
      due: { date: '2026-10-19', time: '21:00' },
    });
  });

  it('stops with a message that names the column and the choices', () => {
    expect(() => cellsFromValues(COLUMNS, { status: 'Maybe' })).toThrow(
      /"Maybe" is not a label of "Status". Labels: New, Done/,
    );
    expect(() => cellsFromValues(COLUMNS, { nope: 'x' })).toThrow(/no column "nope"/);
    expect(() => cellsFromValues(COLUMNS, { files: 'x' })).toThrow(/cannot be written/);
    expect(() => cellsFromValues(COLUMNS, { owner: 'nobody' }, MEMBERS)).toThrow(/No member "nobody"/);
    expect(() => cellsFromValues(COLUMNS, { owner: 'Avi Cohen' }, MEMBERS)).toThrow(/several people/);
    expect(() => cellsFromValues(COLUMNS, { due: 'soon' })).toThrow(/not a date for "Due"/);
  });

  it('needs the member list only for people given by name or email', () => {
    expect(valuesNeedMembers(COLUMNS, { owner: 'dana@example.com' })).toBe(true);
    expect(valuesNeedMembers(COLUMNS, { owner: { persons_and_teams: [] } })).toBe(false);
    expect(valuesNeedMembers(COLUMNS, { status: 'Done' })).toBe(false);
  });
});

describe('the column-values form', () => {
  const schema: BoardSchema = {
    id: 'b1',
    name: 'Leads',
    kind: 'public',
    groups: [],
    columns: COLUMNS,
    subitems: { board_id: 'b2', columns: [col('stage', 'Stage', 'status', { options: [] })] },
  };
  it('renders each writable column in its type', () => {
    const byName = Object.fromEntries(integrationFields(schema).map((f) => [f.name, f]));
    expect(Object.keys(byName)).not.toContain('files');
    expect(byName.status).toEqual({
      name: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { label: 'New', value: 0 },
        { label: 'Done', value: 1 },
      ],
    });
    expect(byName.tags).toMatchObject({ type: 'select', multiple: true });
    expect(byName.owner).toMatchObject({ type: 'select', multiple: true, options: 'rpc://listUsers' });
    expect(byName.client!.options).toBe('rpc://listValues?boardId=b1&column_id=client&purpose=write');
    expect(byName.label!.options).toBe('rpc://listValues?boardId=b1&column_id=label&purpose=write');
    expect(byName.done).toMatchObject({ type: 'boolean' });
    expect(byName.hours).toMatchObject({ type: 'number' });
    expect(byName.site).toMatchObject({ type: 'url' });
    expect(byName.due).toMatchObject({ type: 'text', help: expect.stringContaining('YYYY-MM-DD') });
    expect(byName.country).toMatchObject({ type: 'text', help: 'Text, or the column value as JSON' });
  });
  it('the sub-board’s fields with subitems', () => {
    expect(integrationFields(schema, true)).toEqual([{ name: 'stage', label: 'Stage', type: 'select', options: [] }]);
  });
});

describe('flat rules and text by title', () => {
  it('rules become one AND group; a picked value wins; empty checks take no values', () => {
    expect(
      rulesToFilter([
        { column_id: 'status', operator: 'any_of', value: 'New, Done' },
        { column_id: 'owner', operator: 'any_of', value: 'x', choice: 'u1' },
        { column_id: 'phone', operator: 'is_empty', value: 'ignored' },
        { column_id: 'hours', operator: 'greater_than', value: 5 },
      ]),
    ).toEqual({
      kind: 'group',
      operator: 'and',
      negate: false,
      rules: [
        { kind: 'rule', column_id: 'status', operator: 'any_of', values: ['New', 'Done'], negate: false },
        { kind: 'rule', column_id: 'owner', operator: 'any_of', values: ['u1'], negate: false },
        { kind: 'rule', column_id: 'phone', operator: 'is_empty', values: [], negate: false },
        { kind: 'rule', column_id: 'hours', operator: 'greater_than', values: [5], negate: false },
      ],
    });
  });
  it('column_values: the text of each cell by column title', () => {
    expect(
      columnValuesOf({ status: { text: 'Done' }, gone: { text: 'x' }, empty: null }, new Map([['status', 'Status']])),
    ).toEqual({ Status: 'Done', gone: 'x', empty: null });
  });
});
