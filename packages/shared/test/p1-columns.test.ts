// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  boardChartData,
  cellFromText,
  colorFromText,
  columnTypes,
  computeProgress,
  progressConfigured,
  subitemsProgress,
  countryName,
  DEFAULT_REGION,
  deriveValues,
  formatHourValue,
  groupRows,
  hourFromText,
  isoWeekNumber,
  isWorkingTime,
  locationFromText,
  parseCellValue,
  parseCountry,
  parseSheetCell,
  pendingGeocode,
  planQuery,
  querySchema,
  resolveField,
  summarize,
  timeZoneFromText,
  weekOf,
  type QueryColumn,
  type QueryEnv,
  type QueryRow,
} from '../src';

/** M8 ד10–ד11: the P1 column modules — values, text, filters, sort, group and footers. */
const get = (type: string) => columnTypes.get(type)!;
const parse = (type: string, raw: unknown, settings?: unknown) =>
  parseCellValue(get(type), settings ?? get(type).defaultSettings, raw);

const columns: QueryColumn[] = [
  { id: 'name', type: 'name', settings: {} },
  { id: 'at', type: 'hour', settings: {} },
  { id: 'wk', type: 'week', settings: {} },
  { id: 'tz', type: 'world_clock', settings: {} },
  { id: 'paint', type: 'color_picker', settings: { format: 'hex' } },
  { id: 'land', type: 'country', settings: {} },
  { id: 'place', type: 'location', settings: {} },
  { id: 'prog', type: 'progress', settings: {} },
];
const env: QueryEnv = {
  columns,
  meId: 'u1',
  today: '2026-10-07',
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
};
const cell = (type: string, value: unknown) => {
  const d = deriveValues(get(type), get(type).defaultSettings, value);
  return { value, text: d.textValue };
};
const row = (id: string, values: Record<string, [string, unknown]>): QueryRow => ({
  id,
  group_id: 'g1',
  parent_item_id: null,
  depth: 0,
  name: id,
  position: id,
  key: null,
  created_at: '2026-10-01T00:00:00Z',
  created_by: null,
  updated_at: '2026-10-01T00:00:00Z',
  cells: Object.fromEntries(Object.entries(values).map(([k, [type, v]]) => [k, cell(type, v)])),
});
const rows = [
  row('a', {
    at: ['hour', { hour: 9, minute: 30 }],
    wk: ['week', { start: '2026-10-04', end: '2026-10-10' }],
    tz: ['world_clock', { timezone: 'Asia/Jerusalem' }],
    paint: ['color_picker', { color: '#ff0000' }],
    land: ['country', { code: 'IL' }],
    place: ['location', { address: 'Dizengoff 50, Tel Aviv', lat: 32.08, lng: 34.77 }],
    prog: ['progress', { percent: 50 }],
  }),
  row('b', {
    at: ['hour', { hour: 17, minute: 0 }],
    wk: ['week', { start: '2026-10-11', end: '2026-10-17' }],
    tz: ['world_clock', { timezone: 'America/New_York' }],
    paint: ['color_picker', { color: '#00ff00' }],
    land: ['country', { code: 'US' }],
    place: ['location', { address: 'Times Square, New York' }],
    prog: ['progress', { percent: 100 }],
  }),
  row('c', {}),
];
const run = (q: unknown) => applyPlan(rows, planQuery(querySchema.parse(q), env), env.timezone).map((r) => r.id);
const rule = (column_id: string, operator: string, values: unknown[] = []) => ({
  filter: { kind: 'group', operator: 'and', rules: [{ kind: 'rule', column_id, operator, values }] },
});

describe('registry', () => {
  it('registers every P1 type', () => {
    for (const t of ['progress', 'button', 'hour', 'week', 'world_clock', 'color_picker', 'country', 'location']) {
      const def = get(t);
      expect(def, t).toBeTruthy();
      expect(def.priority).toBe('P1');
    }
    expect(get('progress').readOnly).toBe(true);
    expect(get('button').engine).toBe('button');
  });
});

describe('hour', () => {
  it('parses text and validates', () => {
    expect(hourFromText('9:30')).toEqual({ hour: 9, minute: 30 });
    expect(hourFromText('0930')).toEqual({ hour: 9, minute: 30 });
    expect(hourFromText('9:30 pm')).toEqual({ hour: 21, minute: 30 });
    expect(hourFromText('12 am')).toEqual({ hour: 0, minute: 0 });
    expect(hourFromText('25:00')).toBeUndefined();
    expect(hourFromText('hello')).toBeUndefined();
    expect(parse('hour', { hour: 24, minute: 0 }).ok).toBe(false);
  });
  it('formats by the column, else the reader', () => {
    const v = { hour: 13, minute: 5 };
    expect(parse('hour', v)).toMatchObject({ ok: true, derived: { textValue: '13:05', numberValue: 785 } });
    expect(formatHourValue(v, '12h')).toBe('1:05 PM');
    expect(get('hour').toText(v, { format: 'auto' }, { region: { ...DEFAULT_REGION, time_format: '12h' } })).toBe(
      '1:05 PM',
    );
    expect(get('hour').toText(v, { format: '24h' }, { region: { ...DEFAULT_REGION, time_format: '12h' } })).toBe(
      '13:05',
    );
  });
  it('sorts by time of day and filters by text', () => {
    expect(run({ sort: [{ column_id: 'at', direction: 'desc' }] })).toEqual(['b', 'a', 'c']);
    expect(run(rule('at', 'contains_text', ['09:']))).toEqual(['a']);
  });
});

describe('week', () => {
  it('a week is seven days from the first weekday', () => {
    expect(weekOf('2026-10-07', 0)).toEqual({ start: '2026-10-04', end: '2026-10-10' });
    expect(weekOf('2026-10-07', 1)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(parse('week', { start: '2026-10-04', end: '2026-10-09' }).ok).toBe(false);
    expect(isoWeekNumber('2026-01-01')).toBe(1);
    expect(isoWeekNumber('2026-10-07')).toBe(41);
  });
  it('reads text: a date or a 7-day range', () => {
    expect(cellFromText('week', '07/10/2026', {})).toEqual({ start: '2026-10-04', end: '2026-10-10' });
    expect(cellFromText('week', '07/10/2026', { first_day: 1 })).toEqual({ start: '2026-10-05', end: '2026-10-11' });
    expect(cellFromText('week', '04/10/2026 – 10/10/2026', {})).toEqual({ start: '2026-10-04', end: '2026-10-10' });
    expect(cellFromText('week', '04/10/2026 – 12/10/2026', {})).toBeUndefined();
  });
  it('filters and sorts as dates', () => {
    const p = parse('week', { start: '2026-10-04', end: '2026-10-10' });
    expect(p.ok && p.derived.dateValue?.toISOString().slice(0, 10)).toBe('2026-10-04');
    expect(p.ok && p.derived.dateEndValue?.toISOString().slice(0, 10)).toBe('2026-10-10');
    expect(run(rule('wk', 'greater_than', ['EXACT:2026-10-10']))).toEqual(['b']);
    expect(run({ sort: [{ column_id: 'wk', direction: 'desc' }] })).toEqual(['b', 'a', 'c']);
  });
});

describe('world clock', () => {
  it('accepts zones and cities', () => {
    expect(timeZoneFromText('asia/jerusalem')).toBe('Asia/Jerusalem');
    expect(timeZoneFromText('New York')).toBe('America/New_York');
    expect(timeZoneFromText('Atlantis')).toBeUndefined();
    expect(parse('world_clock', { timezone: 'Mars/Base' }).ok).toBe(false);
    expect(cellFromText('world_clock', 'London', {})).toEqual({ timezone: 'Europe/London' });
  });
  it('knows working hours in the zone', () => {
    const wed10utc = new Date('2026-10-07T10:00:00Z'); // 13:00 in Jerusalem, 06:00 in New York
    expect(isWorkingTime('Asia/Jerusalem', {}, wed10utc)).toBe(true);
    expect(isWorkingTime('America/New_York', {}, wed10utc)).toBe(false);
    expect(isWorkingTime('Asia/Jerusalem', { work_days: [5] }, wed10utc)).toBe(false);
  });
  it('filters by zone', () => {
    expect(run(rule('tz', 'contains_text', ['new_york']))).toEqual(['b']);
  });
});

describe('colour picker', () => {
  it('reads hex, short hex and rgb', () => {
    expect(colorFromText('#ABCDEF')).toBe('#abcdef');
    expect(colorFromText('abc')).toBe('#aabbcc');
    expect(colorFromText('rgb(255, 0, 16)')).toBe('#ff0010');
    expect(colorFromText('rgb(300, 0, 0)')).toBeUndefined();
    expect(colorFromText('red')).toBeUndefined();
  });
  it('shows the column format', () => {
    expect(parse('color_picker', { color: '#FF0000' })).toMatchObject({ ok: true, value: { color: '#ff0000' } });
    expect(get('color_picker').toText({ color: '#ff0010' }, { format: 'rgb' }, {})).toBe('rgb(255, 0, 16)');
    expect(parse('color_picker', { color: 'red' }).ok).toBe(false);
    expect(run(rule('paint', 'any_of', ['#FF0000']))).toEqual(['a']);
  });
});

describe('country', () => {
  it('codes and names in Hebrew and English', () => {
    expect(parseCountry('il')).toBe('IL');
    expect(parseCountry('Israel')).toBe('IL');
    expect(parseCountry(countryName('FR', 'he'))).toBe('FR');
    expect(parseCountry('USA')).toBe('US');
    expect(parseCountry('Atlantis')).toBeNull();
    expect(parse('country', { code: 'XX' }).ok).toBe(false);
  });
  it('stores both names for search and shows the reader language', () => {
    const p = parse('country', { code: 'IL' });
    expect(p.ok && p.derived.textValue).toContain('Israel');
    expect(get('country').toText({ code: 'IL' }, {}, { region: { ...DEFAULT_REGION, language: 'en' } })).toBe('Israel');
    expect(run({ search: 'israel' })).toEqual(['a']);
    const groups = groupRows(rows, resolveField('land', env), { timezone: env.timezone, emptyLabel: '-' });
    expect(groups.map((g) => g.rows.length).sort()).toEqual([1, 1, 1]);
  });
});

describe('location', () => {
  it('reads an address or coordinates', () => {
    expect(locationFromText('Dizengoff 50, Tel Aviv')).toEqual({ address: 'Dizengoff 50, Tel Aviv' });
    expect(locationFromText('32.08, 34.78')).toEqual({ address: '32.08, 34.78', lat: 32.08, lng: 34.78 });
    expect(parse('location', { address: 'x', lat: 100, lng: 0 }).ok).toBe(false);
    expect(parse('location', { address: 'x', lat: 10 }).ok).toBe(false);
  });
  it('knows which values still need geocoding', () => {
    expect(pendingGeocode({ address: 'Tel Aviv' })).toBe('Tel Aviv');
    expect(pendingGeocode({ address: 'Tel Aviv', lat: 1, lng: 2 })).toBeNull();
    expect(pendingGeocode({ address: 'nowhere', geocode_failed: true })).toBeNull();
    expect(get('location').geocodeQuery?.({ address: 'Haifa' })).toBe('Haifa');
  });
  it('filters by address text and counts in the footer', () => {
    expect(run(rule('place', 'contains_text', ['tel aviv']))).toEqual(['a']);
    expect(run(rule('place', 'is_empty'))).toEqual(['c']);
    expect(summarize(resolveField('place', env), rows, env.timezone, 'filled')).toBeTruthy();
  });
});

describe('progress', () => {
  const statusColumns = ['s1', 's2'];
  it('weights status columns (all equal by default) and subitems', () => {
    expect(computeProgress({}, { statusColumns, isDone: (k) => k === 's1' })).toBe(50);
    expect(computeProgress({}, { statusColumns: [], isDone: () => false })).toBeNull();
    expect(
      computeProgress(
        {
          columns: [
            { column_id: 's1', weight: 3 },
            { column_id: 's2', weight: 1 },
          ],
        },
        { statusColumns, isDone: (k) => k === 's1' },
      ),
    ).toBe(75);
    expect(
      computeProgress(
        { subitems: { column_id: 'st', weight: 1 } },
        { statusColumns, isDone: () => true, subitems: { total: 4, done: 1 } },
      ),
    ).toBe(25);
    // A column that no longer exists is ignored.
    expect(
      computeProgress({ columns: [{ column_id: 'gone', weight: 1 }] }, { statusColumns, isDone: () => true }),
    ).toBeNull();
  });
  it('r15cols: an explicit source — subitems alone, columns alone with done labels, or both weighted', () => {
    const isDone = (k: string, labels: number[]) => k === 's1' || (k === 's2' && labels.includes(7));
    const sub = { column_id: 'st', weight: 1 };
    // Subitems alone: their share is the progress, whatever the weight; status columns do not count.
    expect(
      computeProgress(
        { source: 'subitems', subitems: { ...sub, weight: 9 } },
        { statusColumns, isDone, subitems: 0.25 },
      ),
    ).toBe(25);
    // Columns alone: subitems do not count; the column's done labels go to isDone.
    expect(
      computeProgress(
        {
          source: 'columns',
          columns: [
            { column_id: 's1', weight: 1 },
            { column_id: 's2', weight: 1, done_labels: [7] },
          ],
          subitems: sub,
        },
        { statusColumns, isDone, subitems: 0 },
      ),
    ).toBe(100);
    // Both: weighted together.
    expect(
      computeProgress(
        { source: 'both', columns: [{ column_id: 's2', weight: 1 }], subitems: { ...sub, weight: 3 } },
        { statusColumns, isDone, subitems: 1 },
      ),
    ).toBe(75);
    // Not set up: no value (the cell and the dialog say what to set).
    expect(computeProgress({ source: 'columns' }, { statusColumns, isDone })).toBeNull();
    expect(computeProgress({ source: 'subitems' }, { statusColumns, isDone, subitems: 1 })).toBeNull();
    expect(progressConfigured({ source: 'both', columns: [{ column_id: 's1', weight: 1 }] })).toBe(false);
    expect(progressConfigured({})).toBe(true); // older columns: every status column
    // No subitems to measure: no value.
    expect(
      computeProgress({ source: 'subitems', subitems: sub }, { statusColumns, isDone, subitems: null }),
    ).toBeNull();
  });

  it('r15cols: the subitems share — flat, recursive (sub-subitems by their share) and weighted', () => {
    const leaf = (done: boolean, weight: number | null = null) => ({ done, weight });
    const tree = [
      { done: false, weight: 3, children: [leaf(true), leaf(false)] }, // ½ when recursive
      leaf(true, 1),
    ];
    expect(subitemsProgress([])).toBeNull();
    // Flat, weighted: A (not done) weighs 3, B (done) 1 → ¼.
    expect(subitemsProgress(tree)).toBe(0.25);
    // Recursive, weighted: A counts by its sub-subitems (½) → (3·½ + 1) / 4.
    expect(subitemsProgress(tree, true)).toBe(0.625);
    // No weights (or all 0): every subitem counts the same.
    const plain = tree.map((n) => ({ ...n, weight: null }));
    expect(subitemsProgress(plain)).toBe(0.5);
    expect(subitemsProgress(plain, true)).toBe(0.75);
    expect(
      subitemsProgress(
        tree.map((n) => ({ ...n, weight: 0 })),
        true,
      ),
    ).toBe(0.75);
    // Any depth: a sub-subitem with its own subitems counts by theirs.
    const deep = [
      {
        done: false,
        weight: null,
        children: [{ done: false, weight: null, children: [leaf(true), leaf(true)] }, leaf(false)],
      },
    ];
    expect(subitemsProgress(deep, true)).toBe(0.5);
    // A subitem whose board has no such status column is left out.
    expect(subitemsProgress([{ done: null, weight: null }, leaf(true)])).toBe(1);
    expect(subitemsProgress([{ done: null, weight: null }])).toBeNull();
  });

  it('is a number column for filters, sort and footers', () => {
    expect(get('progress').toText({ percent: 68 }, get('progress').defaultSettings, {})).toBe('68%');
    expect(run(rule('prog', 'greater_than', [60]))).toEqual(['b']);
    expect(run({ sort: [{ column_id: 'prog', direction: 'asc' }] })).toEqual(['a', 'b', 'c']);
    expect(summarize(resolveField('prog', env), rows, env.timezone)).toMatchObject({ fn: 'avg', text: '75%' });
  });
});

describe('button', () => {
  it('has no value and a configurable action', () => {
    const def = get('button');
    expect(def.defaultSettings).toMatchObject({ action: { kind: 'automation' }, confirm: false });
    expect(def.settingsSchema.safeParse({ action: { kind: 'open_url', url: 'https://x.y/{item.id}' } }).success).toBe(
      true,
    );
    expect(def.settingsSchema.safeParse({ action: { kind: 'explode' } }).success).toBe(false);
    expect(cellFromText('button', 'click', {})).toBeUndefined();
  });
});

describe('text in sheets and imports', () => {
  it('bulk edit parses the P1 types and flags bad text', () => {
    const col = (type: string) => ({ id: 'c', type, title: 'c', settings: {}, mode: 'edit' as const });
    const benv = { people: [], tags: [], groups: [] };
    expect(parseSheetCell(col('hour'), '8:15', benv)).toEqual({ kind: 'value', value: { hour: 8, minute: 15 } });
    expect(parseSheetCell(col('country'), 'ישראל', benv)).toEqual({ kind: 'value', value: { code: 'IL' } });
    expect(parseSheetCell(col('color_picker'), 'nope', benv)).toEqual({ kind: 'invalid' });
    expect(parseSheetCell(col('location'), '', benv)).toEqual({ kind: 'clear' });
  });
});

describe('chart view data (M8 ד9)', () => {
  const statusCols: QueryColumn[] = [
    ...columns,
    {
      id: 'st',
      type: 'status',
      settings: {
        labels: [
          { id: 0, label: 'Open', color: '#fdab3d', index: 0 },
          { id: 1, label: 'Done', color: '#00c875', index: 1, is_done: true },
        ],
      },
    },
    { id: 'amt', type: 'numbers', settings: {} },
  ];
  const cenv: QueryEnv = { ...env, columns: statusCols };
  const r = (id: string, group: string, st: number | null, amt: number | null): QueryRow => ({
    ...row(id, {}),
    group_id: group,
    cells: {
      ...(st === null ? {} : { st: { value: { index: st }, text: st ? 'Done' : 'Open' } }),
      ...(amt === null ? {} : { amt: { value: amt, text: String(amt) } }),
    },
  });
  const data = [r('1', 'g1', 0, 10), r('2', 'g1', 1, 5), r('3', 'g2', 1, null), r('4', 'g2', null, 7)];
  const ctx = {
    groups: [
      { id: 'g1', title: 'First', color: '#579bfc' },
      { id: 'g2', title: 'Second', color: null },
    ],
  };
  it('counts per group by default, in group order', () => {
    const d = boardChartData(data, undefined, cenv, ctx);
    expect(d.rows.map((x) => [x.label, x.values.value])).toEqual([
      ['First', 2],
      ['Second', 2],
    ]);
    expect(d.rows[0]!.color).toBe('#579bfc');
  });
  it('sums a number column per status label (label colours), empty last', () => {
    const d = boardChartData(
      data,
      { x: { kind: 'column', column_id: 'st', date_unit: 'month' }, measure: { fn: 'sum', column_id: 'amt' } },
      cenv,
      ctx,
    );
    const byLabel = Object.fromEntries(d.rows.map((x) => [x.label || x.key, x.values.value]));
    expect(byLabel).toMatchObject({ Open: 10, Done: 5, __empty__: 7 });
    expect(d.rows.find((x) => x.label === 'Done')?.color).toBe('#00c875');
  });
  it('stacks by a series and folds extra buckets into other', () => {
    const d = boardChartData(
      data,
      {
        chart_type: 'stacked_bar',
        x: { kind: 'group' },
        series: { kind: 'column', column_id: 'st', date_unit: 'month' },
      },
      cenv,
      ctx,
    );
    expect(d.series.length).toBe(3);
    const folded = boardChartData(
      data,
      { x: { kind: 'column', column_id: 'st', date_unit: 'month' }, max_buckets: 2 },
      cenv,
      ctx,
    );
    expect(folded.rows.length).toBe(2);
    expect(folded.rows.at(-1)!.key).toBe('__other__');
  });
});
