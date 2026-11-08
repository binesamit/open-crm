// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  cardSubitemsOf,
  itemCardSettingsSchema,
  resolveCardSubitems,
  saveCardSubitemsDefault,
  type CardSubitemsView,
  type FilterGroup,
} from '../src';

const all = ['qty', 'price', 'status', 'date', 'notes'];
const qtyFilter: FilterGroup = {
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id: 'qty', operator: 'greater_than', values: [1], negate: false }],
};
const view = (id: string, p: Partial<CardSubitemsView['settings']> = {}): CardSubitemsView => ({
  id,
  settings: {
    query: { sort: [] },
    hidden_columns: [],
    column_order: [],
    show_summary: true,
    summaries: {},
    ...p,
  },
});

describe('card subitems settings (cardsub)', () => {
  it('defaults: shown in fields, the first few columns, no filter, summary on', () => {
    const r = resolveCardSubitems({ card: undefined, allColumns: all, views: [] });
    expect(r).toMatchObject({ inFields: true, viewId: null, columns: all.slice(0, 4), sort: [], showSummary: true });
    expect(r.filter).toBeUndefined();
  });

  it('invalid saved settings fall back to the defaults', () => {
    expect(cardSubitemsOf({ subitems: { in_fields: 'x' } }).in_fields).toBe(true);
    expect(cardSubitemsOf(null).sort).toEqual([]);
  });

  it('the card switch turns the table under the fields off', () => {
    expect(resolveCardSubitems({ card: { subitems: { in_fields: false } }, allColumns: all, views: [] }).inFields).toBe(
      false,
    );
  });

  it('without a view: the subitems tab columns, unknown ones dropped', () => {
    const r = resolveCardSubitems({ card: {}, allColumns: all, tabColumns: ['price', 'gone', 'qty'], views: [] });
    expect(r.columns).toEqual(['price', 'qty']);
  });

  it("the card's default view: its order minus hidden columns, its filter, sort and footer", () => {
    const v = view('v1', {
      column_order: ['status', 'qty'],
      hidden_columns: ['notes'],
      query: { filter: qtyFilter, sort: [{ column_id: 'price', direction: 'desc', nulls: 'last' }] },
      summaries: { qty: 'avg' },
    });
    const r = resolveCardSubitems({ card: { subitems: { view_id: 'v1' } }, allColumns: all, views: [v] });
    expect(r.viewId).toBe('v1');
    expect(r.columns).toEqual(['status', 'qty', 'price', 'date']);
    expect(r.filter).toEqual(qtyFilter);
    expect(r.sort[0]!.column_id).toBe('price');
    expect(r.summaries).toEqual({ qty: 'avg' });
  });

  it("a deleted default view falls back to the card's own columns", () => {
    const r = resolveCardSubitems({ card: { subitems: { view_id: 'gone' } }, allColumns: all, views: [] });
    expect(r.viewId).toBeNull();
    expect(r.columns).toEqual(all.slice(0, 4));
  });

  it("the card's filter / sort / summaries refine its default view; another picked view shows as it is", () => {
    const v1 = view('v1', { summaries: { qty: 'avg', price: 'max' } });
    const v2 = view('v2', { query: { sort: [{ column_id: 'date', direction: 'asc', nulls: 'last' }] } });
    const card = {
      subitems: {
        view_id: 'v1',
        filter: qtyFilter,
        sort: [{ column_id: 'qty', direction: 'asc', nulls: 'last' }],
        summaries: { qty: 'sum' },
      },
    };
    const def = resolveCardSubitems({ card, allColumns: all, views: [v1, v2] });
    expect(def.filter).toEqual(qtyFilter);
    expect(def.sort[0]!.column_id).toBe('qty');
    expect(def.summaries).toEqual({ qty: 'sum', price: 'max' });
    const other = resolveCardSubitems({ card, allColumns: all, views: [v1, v2], picked: 'v2' });
    expect(other.viewId).toBe('v2');
    expect(other.filter).toBeUndefined();
    expect(other.sort[0]!.column_id).toBe('date');
    const none = resolveCardSubitems({ card, allColumns: all, views: [v1, v2], picked: null, tabColumns: ['notes'] });
    expect(none.viewId).toBeNull();
    expect(none.columns).toEqual(['notes']);
  });

  it('an ad-hoc draft wins; a cleared filter clears the view filter', () => {
    const v = view('v1', { query: { filter: qtyFilter, sort: [] } });
    const r = resolveCardSubitems({
      card: { subitems: { view_id: 'v1' } },
      allColumns: all,
      views: [v],
      draft: { filter: null, sort: [{ column_id: 'notes', direction: 'desc', nulls: 'last' }] },
    });
    expect(r.filter).toBeUndefined();
    expect(r.sort[0]!.direction).toBe('desc');
    const cols = resolveCardSubitems({
      card: {},
      allColumns: all,
      views: [],
      draft: { columns: ['date', 'x', 'qty'] },
    });
    expect(cols.columns).toEqual(['date', 'qty']);
  });

  it('save as default: the picked view plus the draft; untouched parts stay with the view', () => {
    const card = cardSubitemsOf({ subitems: { view_id: 'v1', filter: qtyFilter, in_fields: false } });
    const picked = saveCardSubitemsDefault(card, 'v2', {});
    expect(picked).toMatchObject({ view_id: 'v2', sort: [], in_fields: false });
    expect(picked.filter).toBeUndefined();
    const kept = saveCardSubitemsDefault(card, undefined, {
      sort: [{ column_id: 'qty', direction: 'asc', nulls: 'last' }],
    });
    expect(kept.filter).toEqual(qtyFilter);
    expect(kept.view_id).toBe('v1');
    const cleared = saveCardSubitemsDefault(card, null, { filter: null });
    expect(cleared.view_id).toBeUndefined();
    expect(cleared.filter).toBeUndefined();
    // What is saved passes the board's card schema.
    expect(itemCardSettingsSchema.safeParse({ tabs: [], subitems: kept }).success).toBe(true);
  });
});
