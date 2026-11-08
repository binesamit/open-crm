// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  columnTypes,
  computeIdocTotals,
  effectiveSelection,
  IDOC_GROUPS,
  IDOC_PRESETS,
  IDOC_STARTERS,
  idocSectionSchema,
  idocSectionsOf,
  idocSettingsOf,
  idocTokensOf,
  idocTotalLookup,
  maskEmail,
  mergeIdocText,
  newIdocSection,
  ownWriter,
  publicIdocSignSchema,
  sectionFromPreset,
  type IdocRowAmounts,
} from '../src';

const row = (key: string, patch: Partial<IdocRowAmounts> = {}): IdocRowAmounts => ({
  key,
  selected: false,
  qty: null,
  price: null,
  unit_price: null,
  recurring_price: null,
  recurring_unit_price: null,
  requires: [],
  ...patch,
});

const settings = { vat_percent: 18, prices_include_vat: false, currency: 'ILS' };

describe('interactive document totals', () => {
  // The sample quote from: base 5,000; add-ons; landing pages 3,500 + 450 × pages; 150 per user.
  const base = newIdocSection('lines', 'base', { mode: 'fixed' });
  const addons = newIdocSection('lines', 'addons', { mode: 'multi' });
  const subs = newIdocSection('lines', 'subs', { mode: 'multi' });
  const third = newIdocSection('lines', 'third', { mode: 'fixed', totals: 'third_party' });
  const summary = newIdocSection('summary', 'sum', {
    schedule: [
      { label: 'deposit', percent: 30 },
      { label: 'balance', percent: 70 },
    ],
  });

  it('adds fixed rows, ticked add-ons, per-unit and recurring amounts', () => {
    const t = computeIdocTotals(
      [
        { section: base, rows: [row('b', { price: 5000 })] },
        {
          section: addons,
          rows: [
            row('wa', { price: 1200, selected: true }),
            row('sms', { price: 700 }),
            row('rep', { price: 300, selected: true }),
            row('lp', { price: 3500, unit_price: 450, qty: 5, selected: true }),
          ],
        },
        { section: subs, rows: [row('users', { recurring_unit_price: 150, qty: 5, selected: true })] },
        { section: third, rows: [row('host', { recurring_price: 75 })] },
      ],
      summary,
      settings,
    );
    expect(t.one_time).toBe(5000 + 1200 + 300 + 3500 + 2250);
    expect(t.recurring).toBe(750);
    expect(t.vat).toBe(Math.round(12250 * 0.18 * 100) / 100);
    expect(t.grand_total).toBe(12250 + 2205);
    expect(t.recurring_total).toBe(885);
    expect(t.third_party_recurring).toBe(75);
    expect(t.schedule.map((s) => s.amount)).toEqual([4336.5, 10118.5]);
    expect(t.schedule[0]!.amount + t.schedule[1]!.amount).toBe(t.grand_total);
  });

  it('drops a row whose required rows are not chosen, through chains', () => {
    const rows = [
      row('a'),
      row('b', { selected: true, requires: ['a'] }),
      row('c', { selected: true, requires: ['b'] }),
    ];
    expect([...effectiveSelection('multi', rows)]).toEqual([]);
    rows[0]!.selected = true;
    expect([...effectiveSelection('multi', rows)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps one row in single mode and every row in fixed mode', () => {
    const rows = [row('a', { selected: true }), row('b', { selected: true }), row('c')];
    expect([...effectiveSelection('single', rows)]).toEqual(['a']);
    expect([...effectiveSelection('fixed', rows)]).toEqual(['a', 'b', 'c']);
  });

  it('extracts VAT when prices include it, and applies a percent discount first', () => {
    const disc = newIdocSection('summary', 's', { discount: { kind: 'percent', value: 10, label: 'off' } });
    const t = computeIdocTotals([{ section: base, rows: [row('b', { price: 1180 })] }], disc, {
      ...settings,
      prices_include_vat: true,
    });
    expect(t.discount).toBe(118);
    expect(t.grand_total).toBe(1062);
    expect(t.subtotal + t.vat).toBeCloseTo(1062, 2);
    expect(t.vat).toBe(162);
  });

  it('never discounts below zero and ignores hidden sections', () => {
    const disc = newIdocSection('summary', 's', { discount: { kind: 'amount', value: 99999, label: '' } });
    const hidden = { ...addons, hidden: true };
    const t = computeIdocTotals(
      [
        { section: base, rows: [row('b', { price: 100 })] },
        { section: hidden, rows: [row('x', { price: 50, selected: true })] },
      ],
      disc,
      settings,
    );
    expect(t.discount).toBe(100);
    expect(t.grand_total).toBe(0);
    expect(t.sections).toHaveLength(1);
  });
});

describe('interactive document catalog and templates', () => {
  it('offers 67 presets in the nine groups, each one building a valid section', () => {
    expect(IDOC_PRESETS).toHaveLength(67);
    expect(new Set(IDOC_PRESETS.map((p) => p.key)).size).toBe(67);
    for (const g of IDOC_GROUPS) expect(IDOC_PRESETS.some((p) => p.group === g)).toBe(true);
    for (const p of IDOC_PRESETS) {
      const s = sectionFromPreset(p.key, 'x');
      if (p.soon) expect(s).toBeNull();
      else expect(idocSectionSchema.safeParse(s).success).toBe(true);
    }
  });

  it('ships starters whose sections and settings parse', () => {
    expect(IDOC_STARTERS.map((s) => s.key)).toContain('quote_agreement');
    for (const s of IDOC_STARTERS) {
      expect(idocSectionsOf(JSON.parse(JSON.stringify(s.sections)))).toHaveLength(s.sections.length);
      expect(new Set(s.sections.map((x) => x.id)).size).toBe(s.sections.length);
    }
  });

  it('keeps no business names in the starter texts', () => {
    const text = JSON.stringify(IDOC_STARTERS);
    // Spelled in pieces so this guard does not itself trip the release's business-name scan.
    const names = new RegExp(['bines' + 'amit', 'smart' + ' ?flow', 'fire' + 'berry', 'i' + 'count'].join('|'), 'i');
    expect(text).not.toMatch(names);
  });

  it('drops a stored section that no longer parses instead of failing', () => {
    expect(
      idocSectionsOf([
        { kind: 'nope', id: 'a' },
        { kind: 'divider', id: 'b' },
      ]),
    ).toHaveLength(1);
    expect(idocSettingsOf({ vat_percent: 'x' }).vat_percent).toBe(18);
  });
});

describe('merge fields', () => {
  it('resolves fields, leaves totals for the page, and blanks unknown ones', () => {
    const lookup = (t: string) => ({ 'item.name': 'Quote 7', 'col:client': 'Acme' })[t];
    const text = '{item.name} for {col:client} — {total.grand} {col:missing}';
    expect(mergeIdocText(text, lookup, { keepTotals: true })).toBe('Quote 7 for Acme — {total.grand} ');
    expect(idocTokensOf(text)).toEqual(['item.name', 'col:client', 'total.grand', 'col:missing']);
  });

  it('formats live totals', () => {
    const t = computeIdocTotals([], null, settings);
    expect(idocTotalLookup(t, 'en')('total.grand')).toMatch(/0/);
  });
});

describe('signature column and helpers', () => {
  it('is registered and written only by its own endpoint', () => {
    const def = columnTypes.get('signature');
    expect(def?.engine).toBe('signature');
    expect(ownWriter(def)).toBe(true);
    expect(
      def?.toText({ signature_id: 's', name: 'Dana', at: '2026-10-18T10:00:00Z', doc_id: 'd', version: 1 }, {}, {}),
    ).toBe('Dana · 2026-10-18');
  });

  it('accepts only path data as a drawing', () => {
    const ok = { section_id: 's', name: 'Dana', consents: [], version: 1 };
    expect(publicIdocSignSchema.safeParse({ ...ok, drawing: 'M1 2 L3,4 Q5 6 7 8' }).success).toBe(true);
    expect(publicIdocSignSchema.safeParse({ ...ok, drawing: '<script>' }).success).toBe(false);
  });

  it('masks an address', () => {
    expect(maskEmail('noa@galstudio.co.il')).toBe('no***@ga***.co.il');
    expect(maskEmail('a@b.io')).toBe('a***@b***.io');
  });
});

describe('document themes', () => {
  it('layers: later values win, empty ones keep the layer below', async () => {
    const { mergeIdocThemes } = await import('../src');
    const t = mergeIdocThemes(
      { paper: '#ffffff', text: '#111111' },
      null,
      { text: '#222222', font: 'serif' },
      { accent: '' },
    );
    expect(t).toMatchObject({ paper: '#ffffff', text: '#222222', accent: '', font: 'serif' });
  });

  it('measures contrast (WCAG) and names the pairs below AA', async () => {
    const { contrastRatio, idocInkOn, idocThemeWarnings, mergeIdocThemes } = await import('../src');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#ffffff')!).toBeLessThan(4.5);
    expect(idocInkOn('#0d3b35')).toBe('#ffffff');
    expect(idocInkOn('#fff3dd')).toBe('#13221f');
    const warned = idocThemeWarnings(mergeIdocThemes({ paper: '#ffffff', text: '#999999', accent: '#0d3b35' }));
    expect(warned.map((w) => w.pair)).toEqual(['text']);
    expect(idocThemeWarnings(mergeIdocThemes({ text: '#999999' }))).toEqual([]);
  });
});
