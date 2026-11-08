// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cellFromText,
  columnTypes,
  deriveValues,
  nextLabelId,
  ownWriter,
  parseCellValue,
  reconcileLabels,
  withLabelColorKeys,
} from '../src';

const get = (type: string) => columnTypes.get(type)!;

describe('parseCellValue', () => {
  it('derives text/number/date per type', () => {
    const status = parseCellValue(get('status'), get('status').defaultSettings, { index: 1 });
    expect(status).toMatchObject({ ok: true, derived: { textValue: 'הושלם', numberValue: 1 } });

    const num = parseCellValue(get('numbers'), { unit: { symbol: '₪', direction: 'left' } }, '1500');
    expect(num).toMatchObject({ ok: true, value: 1500, derived: { textValue: '₪1500', numberValue: 1500 } });

    const date = parseCellValue(get('date'), {}, { date: '2026-10-01' });
    expect(date.ok && date.derived.dateValue?.toISOString()).toBe('2026-10-01T00:00:00.000Z');

    const tl = parseCellValue(get('timeline'), {}, { from: '2026-10-01', to: '2026-10-15' });
    expect(tl).toMatchObject({ ok: true, derived: { textValue: '01/10/2026 – 15/10/2026' } });
  });

  it('rejects invalid values with a code', () => {
    expect(parseCellValue(get('status'), get('status').defaultSettings, { index: 99 })).toMatchObject({
      ok: false,
      error: 'label_not_found',
    });
    expect(parseCellValue(get('timeline'), {}, { from: '2026-10-15', to: '2026-10-01' }).ok).toBe(false);
    expect(parseCellValue(get('link'), {}, { url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(parseCellValue(get('email'), {}, { email: 'not-an-email' }).ok).toBe(false);
    expect(parseCellValue(get('rating'), { max: 5 }, { rating: 7 })).toMatchObject({
      ok: false,
      error: 'rating_out_of_range',
    });
  });

  it('resolves people names through the context', () => {
    const res = parseCellValue(
      get('people'),
      {},
      { persons_and_teams: [{ id: 'u1', kind: 'person' }] },
      {
        userName: (id) => (id === 'u1' ? 'דנה' : undefined),
      },
    );
    expect(res).toMatchObject({ ok: true, derived: { textValue: 'דנה' } });
  });
});

describe('built-in templates (seed/templates)', () => {
  const dir = join(__dirname, '../../../seed/templates');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('has the 21 templates', () => expect(files).toHaveLength(21));

  it.each(files)('%s: format 2 — every column a registered type with valid settings, colours as keys', (file) => {
    const t = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      format_version?: number;
      columns: { type: string; settings?: Record<string, unknown> }[];
      add_columns?: { type: string; settings?: Record<string, unknown> }[];
    };
    expect(t.format_version).toBe(2);
    for (const col of [...t.columns, ...(t.add_columns ?? [])]) {
      const def = columnTypes.get(col.type);
      expect(def, `${file} ${col.type}`).toBeTruthy();
      const settings = col.settings ?? {};
      const check = def!.settingsSchema.safeParse(settings);
      expect(check.success, `${file} ${col.type} ${JSON.stringify(check.error?.issues)}`).toBe(true);
      expect(withLabelColorKeys(settings), `${file} ${col.type}`).toEqual(settings);
    }
  });
});

describe('label settings (03 §2.5–2.6)', () => {
  const a = { id: 0, label: 'א' };
  const b = { id: 1, label: 'ב' };
  const c = { id: 2, label: 'ג' };

  it('keeps a removed label that is in use, deactivated', () => {
    const r = reconcileLabels([a, b, c], [a, c], new Set([1]));
    expect(r).toEqual({ ok: true, labels: [a, c, { ...b, is_deactivated: true }] });
  });

  it('drops a removed label nobody uses', () => {
    expect(reconcileLabels([a, b], [a], new Set())).toEqual({ ok: true, labels: [a] });
  });

  it('rejects duplicate ids', () => {
    expect(reconcileLabels([a], [a, { id: 0, label: 'x' }], new Set())).toEqual({
      ok: false,
      error: 'duplicate_label_id',
    });
  });

  it('allocates ids past every existing one, deactivated included', () => {
    expect(nextLabelId([a, { ...c, is_deactivated: true }])).toBe(3);
    expect(nextLabelId([])).toBe(0);
  });

  it('derives text for a cell on a deactivated label', () => {
    const def = columnTypes.get('status')!;
    const settings = { labels: [{ id: 5, label: 'ישן', color: '#c4c4c4', index: 0, is_deactivated: true }] };
    expect(deriveValues(def, settings, { index: 5 }).textValue).toBe('ישן');
  });
});

describe('phone values (M1.1 #4)', () => {
  const phone = columnTypes.get('phone')!;
  const ok = (p: string) => parseCellValue(phone, phone.defaultSettings, { phone: p }).ok;
  it('accepts short, star and international numbers', () => {
    for (const p of ['*2700', '03-5551234', '1800', '+972 50 123 4567', '12', '(03) 555-12#4'])
      expect(ok(p)).toBe(true);
  });
  // any way of writing a number is kept (marked not valid when not recognised); only text without a
  // single digit is not a phone.
  it('keeps any text with a digit; refuses text without one', () => {
    for (const p of ['1', '05x123', '054.547.2821']) expect(ok(p)).toBe(true);
    for (const p of ['abc', '+', '', 'שלוחה']) expect(ok(p)).toBe(false);
  });
});

describe('tags and vote (03 §3.1, §3.11 — D19)', () => {
  it('tags: ids in the value, names through the context, by name from text', () => {
    const res = parseCellValue(
      get('tags'),
      {},
      { tag_ids: ['t1', 't2'] },
      { tagName: (id) => ({ t1: 'לקוח', t2: 'VIP' })[id] },
    );
    expect(res).toMatchObject({ ok: true, derived: { textValue: 'לקוח, VIP' } });
    expect(parseCellValue(get('tags'), {}, { tags: ['x'] }).ok).toBe(false); // names are resolved by the service
    expect(cellFromText('tags', '#לקוח, VIP, לקוח', {})).toEqual({ tags: ['לקוח', 'VIP'] });
    expect(get('tags').filterModel).toBe('tags');
  });

  it('vote: the number is the count of voters; written only through its endpoint', () => {
    const res = parseCellValue(get('vote'), {}, { voter_ids: ['u1', 'u2', 'u3'] });
    expect(res).toMatchObject({ ok: true, derived: { textValue: '3', numberValue: 3 } });
    expect(ownWriter(get('vote'))).toBe(true);
    expect(ownWriter(get('tags'))).toBe(false);
    expect(cellFromText('vote', '3', {})).toBeUndefined();
  });
});

describe('numbers format (03 §2.4)', () => {
  const text = (v: number, s: Record<string, unknown>) => get('numbers').toText(v, s, {});
  it('currency, percent, custom unit; decimals kept with the thousands separator', () => {
    expect(text(1234.5, { unit: { symbol: '$', direction: 'left' }, precision: 2, thousands: true })).toBe('$1,234.50');
    expect(text(1234.5, { unit: { symbol: '₪', direction: 'right' }, precision: 0, thousands: true })).toBe('1,235₪');
    expect(text(12.5, { unit: { symbol: '%', direction: 'right' } })).toBe('12.5%');
    expect(text(1234567.891, { thousands: true })).toBe('1,234,567.891');
    expect(text(7, { unit: { symbol: 'ק"ג', direction: 'right' }, precision: 1 })).toBe('7.0ק"ג');
  });
});

describe('formula number format (03 §2.18)', () => {
  const formula = get('formula');
  const text = (v: unknown, s: Record<string, unknown>) => formula.toText({ result: v }, { formula: '', ...s }, {});
  it('shows a number result with the numbers settings; other results unchanged', () => {
    expect(text(1234.5, { unit: { symbol: '₪', direction: 'left' }, precision: 2, thousands: true })).toBe('₪1,234.50');
    expect(text(0.125, { unit: { symbol: '%', direction: 'right' }, precision: 1 })).toBe('0.1%');
    // No fixed decimals: rounded to 2, as before.
    expect(text(1 / 3, {})).toBe('0.33');
    expect(text(1234567.891, { thousands: true })).toBe('1,234,567.89');
    expect(text('abc', { precision: 2 })).toBe('abc');
    expect(text(null, { precision: 2 })).toBe('');
    expect(formula.formatNumber!(2000, { formula: '', unit: { symbol: '$', direction: 'left' }, precision: 0 })).toBe(
      '$2000',
    );
    expect(formula.settingsSchema.safeParse({ formula: '1', precision: -1, thousands: true }).success).toBe(true);
    expect(formula.settingsSchema.safeParse({ formula: '1', precision: 5 }).success).toBe(false);
  });
});

describe('item numbers (03 §2.19)', () => {
  const itemId = get('item_id');
  it('takes an empty prefix (just the number) and sorts by the number', () => {
    expect(itemId.settingsSchema.safeParse({ display: 'custom_key', prefix: '', padding: 1 }).success).toBe(true);
    expect(itemId.settingsSchema.safeParse({ display: 'custom_key', prefix: 'PRJ-' }).success).toBe(true);
    expect(itemId.settingsSchema.safeParse({ display: 'custom_key', prefix: 'ש' }).success).toBe(false);
    expect(itemId.defaultSettings).toEqual({ display: 'custom_key', prefix: '', padding: 1 });
    expect(itemId.toNumber!({ key: '324' }, {})).toBe(324);
    expect(itemId.toNumber!({ key: 'P2-0009' }, {})).toBe(9);
    expect(itemId.toNumber!({ key: '01JA2B3C4D5E6F7G8H9J0K1M2N' }, {})).toBeNull();
  });
});
