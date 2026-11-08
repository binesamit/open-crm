// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  actionDescriptionSchema,
  aiTool,
  type DescNames,
  describeAction,
  descriptionCellKeys,
  descriptionRefs,
  plainDescription,
} from '../src';

const NAMES: Record<string, string> = {
  'item:i1': 'Lead X',
  'group:g1': 'New',
  'item:i2': 'Lead Y',
  'board:b9': 'Clients',
  'dashboard:d1': 'Sales',
  'widget:w1': 'By status',
};
const names: DescNames = {
  board: 'Leads',
  name: (r) => NAMES[`${r.kind}:${r.id}`],
  cell: (col, raw) =>
    col === 'status'
      ? { title: 'Status', text: raw === null ? null : 'Won' }
      : col === 'date'
        ? { title: 'Due', text: '07/10/2026' }
        : undefined,
};

describe('describeAction (sync-ai)', () => {
  it('finds the refs and cells of an input by field name', () => {
    expect(descriptionRefs({ item_id: 'i1', group_id: 'g1', position: { after_id: 'i2' }, x: 1 })).toEqual([
      { kind: 'item', id: 'i1' },
      { kind: 'group', id: 'g1' },
      { kind: 'item', id: 'i2' },
    ]);
    expect(descriptionCellKeys({ cells: { status: 'Won', date: '2026-10-07' } })).toEqual(['status', 'date']);
  });

  it('a single cell becomes the one-cell sentence with names', () => {
    const d = describeAction(aiTool('update_item')!, { item_id: 'i1', cells: { status: 'Won' } }, names);
    expect(actionDescriptionSchema.parse(d)).toEqual({
      tool: 'update_item',
      variant: 'one_cell',
      params: { item: 'Lead X', column: 'Status', value: 'Won', board: 'Leads' },
      details: [],
    });
    expect(plainDescription('Update item', d)).toBe('Update item: "Lead X" · "Leads" · Status: Won');
  });

  it('a cleared cell, several cells, a rename', () => {
    expect(describeAction(aiTool('update_item')!, { item_id: 'i1', cells: { status: null } }, names).variant).toBe(
      'clear_cell',
    );
    const many = describeAction(
      aiTool('update_item')!,
      { item_id: 'i1', name: 'Lead Z', cells: { status: 'Won', date: '2026-10-07' } },
      names,
    );
    expect(many.variant).toBeNull();
    expect(many.params.name).toBe('Lead Z');
    expect(many.details).toEqual([
      { field: 'name', label: null, value: { kind: 'text', text: 'Lead Z' } },
      { field: 'cell', label: 'Status', value: { kind: 'text', text: 'Won' } },
      { field: 'cell', label: 'Due', value: { kind: 'text', text: '07/10/2026' } },
    ]);
  });

  it('positions, enums, booleans, dates and unknown names', () => {
    const d = describeAction(
      aiTool('move_item')!,
      { item_id: 'i1', group_id: 'g1', position: { after_id: 'i2' } },
      names,
    );
    expect(d.params).toEqual({ item: 'Lead X', group: 'New', board: 'Leads' });
    expect(d.details).toEqual([{ field: 'position_after', label: null, value: { kind: 'text', text: 'Lead Y' } }]);
    expect(
      describeAction(aiTool('move_item')!, { item_id: 'i1', group_id: 'g1', position: 'top' }, names).details,
    ).toEqual([{ field: 'position', label: null, value: { kind: 'enum', value: 'top' } }]);
    expect(
      describeAction(aiTool('set_automation_active')!, { automation_id: 'a1', is_active: true }, names),
    ).toMatchObject({
      params: { automation: null },
      details: [{ field: 'is_active', value: { kind: 'bool', value: true } }],
    });
    expect(
      describeAction(
        aiTool('log_time')!,
        { item_id: 'i1', column_id: 'time', started_at: '2026-10-07T09:00:00+03:00' },
        names,
      ).details,
    ).toEqual([{ field: 'started_at', label: null, value: { kind: 'datetime', value: '2026-10-07T09:00:00+03:00' } }]);
  });

  it('a subitem is described under its parent; nested objects stay technical', () => {
    const d = describeAction(
      aiTool('create_item')!,
      { parent_item_id: 'i1', name: 'Call back' },
      { ...names, board: 'Leads · subitems' },
    );
    expect(d.variant).toBe('subitem');
    expect(d.params).toEqual({ parent_item: 'Lead X', name: 'Call back' });
    const auto = describeAction(
      aiTool('create_automation')!,
      { board_id: 'b9', recipe: { trigger: {} }, is_active: false },
      names,
    );
    expect(auto.params).toEqual({ board: 'Clients' });
    expect(auto.details.map((x) => x.field)).toEqual(['is_active']);
  });

  it('dashboard widgets (): the dashboard and the widget by name, the type as a list value', () => {
    const noBoard: DescNames = { name: names.name };
    const add = describeAction(aiTool('add_dashboard_widget')!, { dashboard_id: 'd1', type: 'chart' }, noBoard);
    expect(add).toMatchObject({ variant: 'untitled', params: { dashboard: 'Sales' } });
    expect(add.details).toEqual([{ field: 'type', label: null, value: { kind: 'enum', value: 'chart' } }]);
    const titled = describeAction(
      aiTool('add_dashboard_widget')!,
      { dashboard_id: 'd1', type: 'text', title: 'Notes' },
      noBoard,
    );
    expect(titled).toMatchObject({ variant: null, params: { dashboard: 'Sales', title: 'Notes' } });
    const rename = describeAction(aiTool('update_dashboard_widget')!, { widget_id: 'w1', title: 'Pie' }, noBoard);
    expect(rename.params).toEqual({ widget: 'By status', title: 'Pie' });
    expect(rename.details).toEqual([{ field: 'title', label: null, value: { kind: 'text', text: 'Pie' } }]);
  });

  it('a remote tool (no schema) still gets its names and scalars', () => {
    const d = describeAction({ name: 'crm__send' }, { item_id: 'i1', subject: 'Hi' }, names);
    expect(d).toMatchObject({ tool: 'crm__send', params: { item: 'Lead X' }, details: [{ field: 'subject' }] });
  });
});
