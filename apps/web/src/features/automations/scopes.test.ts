// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ACTIONS, TRIGGERS, type ActionType, type TriggerType } from '@bines/shared';
import {
  actionSections,
  columnFits,
  columnSections,
  isSubitemAction,
  MULTI_COLUMN_TRIGGERS,
  pickInSection,
  toggleTriggerColumn,
  triggerSections,
} from './scopes';

const col = (id: string, type: string) => ({ id, type });
const main = [col('name', 'name'), col('status', 'status'), col('text', 'text'), col('formula', 'formula')];
const sub = [col('name', 'name'), col('s_status', 'status'), col('s_num', 'numbers')];

describe('r17ui: menu sections', () => {
  it('puts every subitem trigger in the subitems section and keeps every trigger', () => {
    const types = Object.keys(TRIGGERS) as TriggerType[];
    const sections = triggerSections(types);
    const subs = sections.find((s) => s.section === 'subitems')!.types;
    expect(subs).toEqual(
      expect.arrayContaining(['subitem_created', 'subitem_status_changed', 'subitem_column_changed']),
    );
    expect(sections.flatMap((s) => s.types).sort()).toEqual([...types].sort());
  });

  it('puts the parent / subitem actions together and keeps every action once', () => {
    const types = Object.keys(ACTIONS) as ActionType[];
    const sections = actionSections(types);
    const subs = sections.find((s) => s.section === 'subitems')!.types;
    for (const k of [
      'create_subitem',
      'set_parent_column',
      'set_subitems_column',
      'copy_from_parent',
      'copy_to_parent',
      'copy_to_subitems',
    ] as ActionType[]) {
      expect(subs).toContain(k);
      expect(isSubitemAction(k)).toBe(true);
    }
    const all = sections.flatMap((s) => s.types);
    expect(all.sort()).toEqual([...types].sort());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('r17ui: column sections', () => {
  const board = { itemLevel: 'main' as const, parentLevel: null, main, sub, subLevels: false };

  it('a column trigger lists the item columns and the subitem columns', () => {
    const s = columnSections('column_changed', true, board)!;
    expect(s.map((x) => [x.label, x.type])).toEqual([
      ['auto.cols.item', 'column_changed'],
      ['auto.cols.subitem', 'subitem_column_changed'],
    ]);
    // The name counts for column triggers; read-only columns never do.
    expect(s[0]!.columns.map((c) => c.id)).toEqual(['name', 'status', 'text']);
    expect(s[1]!.columns.map((c) => c.id)).toEqual(['name', 's_status', 's_num']);
  });

  it('a status trigger lists status columns only, the same from its subitem variant', () => {
    const a = columnSections('status_changed', true, board)!;
    const b = columnSections('subitem_status_changed', true, board)!;
    expect(a).toEqual(b);
    expect(a.flatMap((x) => x.columns.map((c) => c.id))).toEqual(['status', 's_status']);
  });

  it('no sub-board: one section', () => {
    expect(columnSections('column_changed', true, { ...board, sub: [] })!.length).toBe(1);
  });

  it('set_column on a board item reaches its subitems', () => {
    const s = columnSections('set_column', false, board)!;
    expect(s.map((x) => [x.scope, x.type, x.label])).toEqual([
      ['item', 'set_column', 'auto.cols.item'],
      ['subitems', 'set_subitems_column', 'auto.cols.subitem'],
    ]);
  });

  it('on a subitem run: its own columns, its parent, and sub-subitems only where the board allows them', () => {
    const run = { ...board, itemLevel: 'sub' as const, parentLevel: 'main' as const };
    expect(columnSections('set_column', false, run)!.map((x) => [x.scope, x.label])).toEqual([
      ['item', 'auto.cols.subitem'],
      ['parent', 'auto.cols.parentItem'],
    ]);
    const deep = { ...run, subLevels: true, parentLevel: 'sub' as const };
    expect(columnSections('set_parent_column', false, deep)!.map((x) => [x.scope, x.label])).toEqual([
      ['item', 'auto.cols.subitem'],
      ['subitems', 'auto.cols.subSubitem'],
      ['parent', 'auto.cols.parentSubitem'],
    ]);
  });

  it('other blanks keep their plain list', () => {
    expect(columnSections('clear_column', false, board)).toBeNull();
    expect(columnSections('date_arrived', true, board)).toBeNull();
  });
});

describe('r17ui: picking in a section', () => {
  it('same section: only the column', () => {
    expect(pickInSection({ type: 'set_column', column: 'a', value: 'x' }, { type: 'set_column' }, 'b')).toEqual({
      column: 'b',
    });
  });

  it('a subitem column switches the trigger to its subitem variant, and back drops its level', () => {
    expect(
      pickInSection({ type: 'column_changed', column: 'text' }, { type: 'subitem_column_changed' }, 's_num'),
    ).toEqual({ type: 'subitem_column_changed', column: 's_num' });
    expect(
      pickInSection(
        { type: 'subitem_column_changed', column: 's_num', level: 'subitem' },
        { type: 'column_changed' },
        'text',
      ),
    ).toEqual({ type: 'column_changed', column: 'text', level: undefined, all_subitems: undefined });
  });

  it('a status trigger moved to subitems gets all_subitems and its labels reset', () => {
    expect(
      pickInSection(
        { type: 'status_changed', column: 'status', labels: ['Done'] },
        { type: 'subitem_status_changed' },
        's_status',
      ),
    ).toEqual({ type: 'subitem_status_changed', column: 's_status', all_subitems: false, labels: 'any' });
  });

  it('actions keep their value and drop the subitems filter when leaving the subitems', () => {
    expect(
      pickInSection(
        { type: 'set_subitems_column', column: 's_num', value: 3, where: { kind: 'group' } },
        { type: 'set_parent_column' },
        'text',
      ),
    ).toEqual({ type: 'set_parent_column', column: 'text', where: undefined });
  });
});

describe('s4f: the date trigger column picker', () => {
  it('offers last updated columns (computed time) next to dates, not other computed columns', () => {
    for (const type of ['date_arrived', 'date_arrives_before']) {
      expect(columnFits(type, true, { type: 'date' })).toBe(true);
      expect(columnFits(type, true, { type: 'timeline' })).toBe(true);
      expect(columnFits(type, true, { type: 'last_updated' })).toBe(true);
      expect(columnFits(type, true, { type: 'creation_log' })).toBe(false);
      expect(columnFits(type, true, { type: 'text' })).toBe(false);
    }
    // "When a column changes" still cannot listen to it (read-only, computed).
    expect(columnFits('column_changed', true, { type: 'last_updated' })).toBe(false);
  });
});

describe('item templates in the action menu (phase 2)', () => {
  it('"subitems from a template" sits with the subitem actions, "an item from a template" across boards', () => {
    const sections = actionSections(['add_template_subitems', 'create_item_from_template', 'create_item']);
    expect(sections.find((s) => s.section === 'subitems')!.types).toEqual(['add_template_subitems']);
    expect(sections.find((s) => s.section === 'cross_board')!.types).toEqual([
      'create_item_from_template',
      'create_item',
    ]);
  });
});

describe('toggleTriggerColumn', () => {
  const item = { type: 'column_changed' };
  it('adds and removes columns of a "when … changes" trigger, keeping one', () => {
    const one = { type: 'column_changed', column: 'qty' };
    const two = { ...one, ...toggleTriggerColumn(one, item, 'service') };
    expect(two).toEqual({ type: 'column_changed', column: 'qty', columns: ['qty', 'service'] });
    expect(toggleTriggerColumn(two, item, 'qty')).toEqual({ column: 'service', columns: undefined });
    expect(toggleTriggerColumn(one, item, 'qty')).toEqual({});
  });
  it('moves to the other level with the picked column alone', () => {
    const two = { type: 'column_changed', column: 'qty', columns: ['qty', 'service'] };
    expect(toggleTriggerColumn(two, { type: 'subitem_column_changed' }, 's_num')).toMatchObject({
      type: 'subitem_column_changed',
      column: 's_num',
      columns: undefined,
    });
  });
  it('set_computed writes numbers, texts, dates and hours only', () => {
    expect(columnFits('set_computed', false, { type: 'numbers' })).toBe(true);
    expect(columnFits('set_computed', false, { type: 'date' })).toBe(true);
    expect(columnFits('set_computed', false, { type: 'status' })).toBe(false);
    expect(MULTI_COLUMN_TRIGGERS.has('subitem_column_changed')).toBe(true);
  });
});
