// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  conversionSupport,
  conversionTargets,
  convertCell,
  DEFAULT_REGION,
  parseDateText,
  parseNumberText,
  planConversion,
  prepareConversion,
  type ConvertEnv,
  type ConvertOptions,
} from '../src';

/** D28 — column type conversion: the support table and the parse matrix of every pair the plan lists (§3). */

const people = [
  { id: 'u1', kind: 'person' as const, name: 'דנה כהן', email: 'dana@x.test' },
  { id: 'u2', kind: 'person' as const, name: 'Avi Levi', email: 'avi@x.test' },
  { id: 'u3', kind: 'person' as const, name: 'Avi Levi', email: 'avi2@x.test' },
  { id: 't1', kind: 'team' as const, name: 'מכירות' },
];
const env: ConvertEnv = { people, tags: [{ id: 'g1', name: 'vip' }], region: DEFAULT_REGION };

/** Converts each value of a column of `from` to `to`; returns the outcomes in order. */
const run = (
  from: string,
  to: string,
  values: unknown[],
  opts: { settings?: unknown; options?: ConvertOptions; env?: ConvertEnv } = {},
) => {
  const plan = planConversion({
    from: { type: from, settings: opts.settings ?? null },
    toType: to,
    options: opts.options,
    env: opts.env ?? env,
    cells: values.map((value, i) => ({ itemId: `i${i}`, value })),
  });
  return { plan, out: plan.results.map((r) => (r.outcome === 'converted' ? r.value : r.outcome)) };
};

describe('support', () => {
  it('lists the convertible targets and refuses the computed / own-writer / relation types with a reason', () => {
    expect(conversionSupport('text', 'numbers')).toMatchObject({ ok: true, direct: false });
    expect(conversionSupport('status', 'dropdown')).toMatchObject({ ok: true, direct: true });
    expect(conversionSupport('text', 'text')).toEqual({ ok: false, reason: 'same_type' });
    expect(conversionSupport('name', 'text')).toEqual({ ok: false, reason: 'name_column' });
    expect(conversionSupport('formula', 'text')).toEqual({ ok: false, reason: 'computed' });
    expect(conversionSupport('text', 'formula')).toEqual({ ok: false, reason: 'computed' });
    expect(conversionSupport('mirror', 'text')).toEqual({ ok: false, reason: 'computed' });
    expect(conversionSupport('progress', 'numbers')).toEqual({ ok: false, reason: 'computed' });
    expect(conversionSupport('file', 'text')).toEqual({ ok: false, reason: 'own_writer' });
    expect(conversionSupport('time_tracking', 'text')).toEqual({ ok: false, reason: 'own_writer' });
    expect(conversionSupport('button', 'text')).toEqual({ ok: false, reason: 'own_writer' });
    expect(conversionSupport('board_relation', 'text')).toEqual({ ok: false, reason: 'relations' });
    expect(conversionSupport('ai', 'text')).toEqual({ ok: false, reason: 'ai' });
    expect(conversionSupport('text', 'nope')).toEqual({ ok: false, reason: 'unknown_type' });
    const targets = conversionTargets('text');
    expect(targets).toEqual(expect.arrayContaining(['numbers', 'status', 'dropdown', 'tags', 'date', 'people']));
    expect(targets).not.toContain('formula');
    expect(targets).not.toContain('text');
    expect(conversionTargets('formula')).toEqual([]);
  });

  it('asks only the options of the pair', () => {
    expect(conversionSupport('text', 'date')).toMatchObject({ options: ['date_order'] });
    expect(conversionSupport('timeline', 'date')).toMatchObject({ options: ['timeline_side'] });
    expect(conversionSupport('people', 'text')).toMatchObject({ options: ['people_as'] });
    expect(conversionSupport('numbers', 'text')).toMatchObject({ options: ['number_unit'] });
    expect(conversionSupport('numbers', 'rating')).toMatchObject({ options: ['rating_max'] });
    expect(conversionSupport('text', 'status')).toMatchObject({ options: [] });
  });
});

describe('parsers', () => {
  it('numbers: currencies, thousands, RTL marks, Hebrew currency words, negatives', () => {
    expect(parseNumberText('1,250 ₪')).toBe(1250);
    expect(parseNumberText('₪1,250.5')).toBe(1250.5);
    expect(parseNumberText('\u200f1,250\u200f ש"ח')).toBe(1250);
    expect(parseNumberText('3,000 ש״ח')).toBe(3000);
    expect(parseNumberText('$ 99.90')).toBe(99.9);
    expect(parseNumberText('€12')).toBe(12);
    expect(parseNumberText('45%')).toBe(45);
    expect(parseNumberText('(1,250)')).toBe(-1250);
    expect(parseNumberText('1250-')).toBe(-1250);
    expect(parseNumberText('-7')).toBe(-7);
    expect(parseNumberText('בערך 5')).toBeUndefined();
    expect(parseNumberText('חמש')).toBeUndefined();
    expect(parseNumberText('₪')).toBeUndefined();
    expect(parseNumberText('')).toBeUndefined();
  });

  it('dates: ISO, day first by default, month first for a US account format', () => {
    expect(parseDateText('31/12/2026')).toBe('2026-12-31');
    expect(parseDateText('31.12.26')).toBe('2026-12-31');
    expect(parseDateText('2026/12/31')).toBe('2026-12-31');
    expect(parseDateText('12/31/2026')).toBeNull();
    expect(parseDateText('12/31/2026', 'mdy')).toBe('2026-12-31');
    expect(parseDateText('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(parseDateText('מחר')).toBeNull();
  });
});

describe('text → numbers', () => {
  it('converts amounts (₪ kept as the unit), fails free text, leaves empty cells empty', () => {
    const { plan, out } = run('text', 'numbers', ['1,250 ₪', '₪ 300', '7', 'בערך 5', '   ', 'חמש']);
    expect(out).toEqual([1250, 300, 7, 'failed', 'empty', 'failed']);
    expect(plan.counts).toMatchObject({ converted: 3, failed: 2, empty: 1 });
    expect(plan.prepared.to.settings.unit).toEqual({ symbol: '₪', direction: 'left' });
    expect(plan.samples.failed.map((s) => s.before)).toEqual(['בערך 5', 'חמש']);
    expect(plan.samples.converted[0]).toMatchObject({ before: '1,250 ₪', after: '₪1,250' }); // a new numbers column shows 1,000
  });

  it('counts items without a cell as empty', () => {
    const plan = planConversion({
      from: { type: 'text', settings: null },
      toType: 'numbers',
      cells: [{ itemId: 'a', value: '5' }],
      itemCount: 4,
    });
    expect(plan.counts).toEqual({ items: 4, converted: 1, empty: 3, failed: 0, partial: 0 });
  });
});

describe('numbers → text', () => {
  const settings = { unit: { symbol: '₪', direction: 'left' }, thousands: true };
  it('keeps the unit by default, or the bare number', () => {
    expect(run('numbers', 'text', [1250, 3.5], { settings }).out).toEqual(['₪1,250', '₪3.5']);
    expect(run('numbers', 'text', [1250], { settings, options: { number_unit: false } }).out).toEqual(['1250']);
  });
});

describe('text → status (new labels)', () => {
  it('creates a label per distinct value (case-insensitive), most used kept, removed ones fail', () => {
    const { plan, out } = run('text', 'status', ['בטיפול', 'Done', 'done', 'בטיפול', '', 'ממתין']);
    const labels = plan.prepared.to.settings.labels as { id: number; label: string; color: string }[];
    expect(labels.map((l) => l.label)).toEqual(['בטיפול', 'Done', 'ממתין']);
    expect(plan.prepared.newLabels.map((l) => [l.name, l.count])).toEqual([
      ['בטיפול', 2],
      ['Done', 2],
      ['ממתין', 1],
    ]);
    expect(labels.every((l) => /^[a-z]+$/.test(l.color))).toBe(true);
    expect(out).toEqual([{ index: 0 }, { index: 1 }, { index: 1 }, { index: 0 }, 'empty', { index: 2 }]);

    const skipped = run('text', 'status', ['בטיפול', 'ממתין'], {
      options: { skip_labels: ['ממתין'], label_colors: { בטיפול: 'sage' } },
    });
    expect(skipped.out).toEqual([{ index: 0 }, 'failed']);
    expect(skipped.plan.prepared.skippedLabels).toEqual([{ name: 'ממתין', count: 1 }]);
    expect((skipped.plan.prepared.to.settings.labels as { color: string }[])[0]!.color).toBe('sage');
  });

  it('keeps at most 40 status labels; a label longer than 30 characters fails', () => {
    const values = Array.from({ length: 45 }, (_, i) => `v${i}`);
    const { plan } = run('text', 'status', [...values, 'x'.repeat(31)]);
    expect((plan.prepared.to.settings.labels as unknown[]).length).toBe(40);
    expect(plan.counts.failed).toBe(6);
  });
});

describe('text → dropdown / tags', () => {
  it('splits by comma, semicolon or line; each part a label', () => {
    const { plan, out } = run('text', 'dropdown', ['אדום, כחול', 'כחול;ירוק', 'אדום\nירוק']);
    expect((plan.prepared.to.settings.labels as { label: string }[]).map((l) => l.label)).toEqual([
      'אדום',
      'כחול',
      'ירוק',
    ]);
    expect(out).toEqual([{ ids: [0, 1] }, { ids: [1, 2] }, { ids: [0, 2] }]);
  });

  it('tags: names (# dropped), new tags listed apart from existing ones', () => {
    const { plan, out } = run('text', 'tags', ['#vip, חדש', 'חדש']);
    expect(out).toEqual([{ tags: ['vip', 'חדש'] }, { tags: ['חדש'] }]);
    expect(plan.prepared.newTags).toEqual([{ name: 'חדש', count: 2 }]);
  });
});

describe('status ↔ dropdown (direct, by label id)', () => {
  const status = {
    labels: [
      { id: 3, label: 'בטיפול', color: 'yellow', index: 0 },
      { id: 7, label: 'הושלם', color: 'forest', index: 1, is_done: true },
    ],
  };
  const dropdown = {
    labels: [
      { id: 1, label: 'אדום' },
      { id: 2, label: 'כחול' },
    ],
  };
  it('status → dropdown keeps the labels and their ids', () => {
    const { plan, out } = run('status', 'dropdown', [{ index: 7 }, { index: 3 }], { settings: status });
    expect(out).toEqual([{ ids: [7] }, { ids: [3] }]);
    expect(plan.prepared.to.settings.labels).toEqual([
      { id: 3, label: 'בטיפול' },
      { id: 7, label: 'הושלם' },
    ]);
  });
  it('dropdown → status takes the first label (the rest kept in the backup: partial)', () => {
    const { plan, out } = run('dropdown', 'status', [{ ids: [2, 1] }, { ids: [1] }, { ids: [] }], {
      settings: dropdown,
    });
    expect(out).toEqual([{ index: 2 }, { index: 1 }, 'empty']);
    expect(plan.counts.partial).toBe(1);
    expect((plan.prepared.to.settings.labels as { color?: string }[]).every((l) => !!l.color)).toBe(true);
  });
  it('status / dropdown → text: the label names', () => {
    expect(run('status', 'text', [{ index: 3 }], { settings: status }).out).toEqual(['בטיפול']);
    expect(run('dropdown', 'text', [{ ids: [1, 2] }], { settings: dropdown }).out).toEqual(['אדום, כחול']);
  });
});

describe('dates', () => {
  it('text → date in the account order, with time; free text fails', () => {
    expect(run('text', 'date', ['31/12/2026', '2026-01-05 9:30', 'מחר']).out).toEqual([
      { date: '2026-12-31' },
      { date: '2026-01-05', time: '09:30' },
      'failed',
    ]);
    const us: ConvertEnv = { ...env, region: { ...DEFAULT_REGION, date_format: 'MM/DD/YYYY' } };
    expect(run('text', 'date', ['12/31/2026'], { env: us }).out).toEqual([{ date: '2026-12-31' }]);
    expect(run('text', 'date', ['12/31/2026'], { options: { date_order: 'mdy' } }).out).toEqual([
      { date: '2026-12-31' },
    ]);
  });
  it('date → text in the account format', () => {
    expect(run('date', 'text', [{ date: '2026-12-31' }]).out).toEqual(['31/12/2026']);
  });
  it('date → timeline, timeline → date (start or end; the other end in the backup)', () => {
    expect(run('date', 'timeline', [{ date: '2026-03-01' }]).out).toEqual([{ from: '2026-03-01', to: '2026-03-01' }]);
    const tl = [{ from: '2026-03-01', to: '2026-03-09' }];
    const start = run('timeline', 'date', tl);
    expect(start.out).toEqual([{ date: '2026-03-01' }]);
    expect(start.plan.counts.partial).toBe(1);
    expect(run('timeline', 'date', tl, { options: { timeline_side: 'end' } }).out).toEqual([{ date: '2026-03-09' }]);
    expect(run('text', 'timeline', ['01/03/2026 – 09/03/2026']).out).toEqual([
      { from: '2026-03-01', to: '2026-03-09' },
    ]);
  });
});

describe('people', () => {
  it('people → text: names or emails', () => {
    const v = { persons_and_teams: [{ id: 'u1', kind: 'person' }] };
    expect(run('people', 'text', [v]).out).toEqual(['דנה כהן']);
    expect(run('people', 'text', [v], { options: { people_as: 'email' } }).out).toEqual(['dana@x.test']);
  });
  it('text → people by full name or email; unknown or ambiguous names fail', () => {
    expect(run('text', 'people', ['דנה כהן, מכירות', 'avi@x.test', 'Avi Levi', 'מישהו']).out).toEqual([
      {
        persons_and_teams: [
          { id: 'u1', kind: 'person' },
          { id: 't1', kind: 'team' },
        ],
      },
      { persons_and_teams: [{ id: 'u2', kind: 'person' }] },
      'failed',
      'failed',
    ]);
  });
});

describe('numbers ↔ rating', () => {
  it('a whole number within the scale; the scale grows to 10 when needed', () => {
    const r5 = run('numbers', 'rating', [1, 5, 0, 2.5]);
    expect(r5.out).toEqual([{ rating: 1 }, { rating: 5 }, 'failed', 'failed']);
    expect(r5.plan.prepared.to.settings.max).toBe(5);
    const r10 = run('numbers', 'rating', [8, 11]);
    expect(r10.plan.prepared.to.settings.max).toBe(10);
    expect(r10.out).toEqual([{ rating: 8 }, 'failed']);
    expect(run('numbers', 'rating', [4], { options: { rating_max: 3 } }).out).toEqual(['failed']);
    expect(run('rating', 'numbers', [{ rating: 4 }], { settings: { max: 5 } }).out).toEqual([4]);
  });
});

describe('contact types and checkbox ↔ text', () => {
  it('link / email / phone → their address; text → them when valid', () => {
    expect(run('link', 'text', [{ url: 'https://example.com', text: 'אתר' }]).out).toEqual(['https://example.com']);
    expect(run('email', 'text', [{ email: 'a@b.co', text: 'A' }]).out).toEqual(['a@b.co']);
    expect(run('phone', 'text', [{ phone: '050-1234567' }]).out).toEqual(['050-1234567']);
    expect(run('text', 'link', ['example.com', 'לא קישור']).out).toEqual([{ url: 'https://example.com' }, 'failed']);
    expect(run('text', 'email', ['a@b.co', 'a@']).out).toEqual([{ email: 'a@b.co' }, 'failed']);
    // The converted value carries the derived E.164.
    expect(run('text', 'phone', ['+972 50 1234567', 'abc']).out).toEqual([
      { phone: '+972 50 1234567', e164: '+972501234567', valid: true },
      'failed',
    ]);
  });
  it('checkbox ↔ text: V / כן / true / 1 ↔ "כן"', () => {
    expect(run('checkbox', 'text', [{ checked: true }, { checked: false }]).out).toEqual(['כן', 'empty']);
    expect(run('text', 'checkbox', ['V', 'כן', 'true', '1', 'אולי']).out).toEqual([
      { checked: true },
      { checked: true },
      { checked: true },
      { checked: true },
      'failed',
    ]);
  });
  it('text ↔ long text', () => {
    expect(run('text', 'long_text', ['שורה']).out).toEqual([{ text: 'שורה' }]);
    const long = run('long_text', 'text', [{ text: 'א'.repeat(2100) }]);
    expect((long.out[0] as string).length).toBe(2000);
    expect(long.plan.counts.partial).toBe(1);
  });
});

describe('any type → text', () => {
  it('never fails', () => {
    for (const [type, value, settings] of [
      ['numbers', 5, null],
      ['date', { date: '2026-01-01' }, null],
      ['checkbox', { checked: true }, null],
      ['rating', { rating: 3 }, { max: 5 }],
      ['country', { code: 'IL' }, null],
      ['tags', { tag_ids: ['g1'] }, null],
    ] as const) {
      const { plan } = run(type, 'text', [value], { settings });
      expect(plan.counts.failed, type).toBe(0);
      expect(plan.counts.converted, type).toBe(1);
    }
  });
  it('a stored value that does not read as its type fails (kept in the backup)', () => {
    const p = prepareConversion({ from: { type: 'numbers', settings: null }, toType: 'text', values: [] });
    expect(convertCell(p, { weird: true })).toMatchObject({ outcome: 'failed', reason: 'unreadable' });
  });
});
