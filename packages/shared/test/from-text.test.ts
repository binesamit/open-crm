// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cellFromText, convertCellValue, parseDateText } from '../src/columns/from-text';
import { columnTypes } from '../src/columns';

const status = { labels: [{ id: 3, label: 'בטיפול', color: '#fdab3d', index: 0 }] };
const dropdown = {
  labels: [
    { id: 1, label: 'אדום' },
    { id: 2, label: 'כחול' },
    { id: 9, label: 'ישן', is_deactivated: true },
  ],
};
const people = [
  { id: 'u1', kind: 'person' as const, name: 'דנה כהן', email: 'dana@x.test' },
  { id: 't1', kind: 'team' as const, name: 'מכירות' },
];

describe('cellFromText (paste, 07 §10)', () => {
  it('empty text clears; unknown text is skipped (undefined)', () => {
    expect(cellFromText('numbers', '  ', null)).toBeNull();
    expect(cellFromText('numbers', 'abc', null)).toBeUndefined();
    expect(cellFromText('formula', '5', null)).toBeUndefined();
  });

  it('reads numbers, dates, timelines, links, checkboxes', () => {
    expect(cellFromText('numbers', '₪1,250.5', null)).toBe(1250.5);
    expect(cellFromText('date', '03/10/2026', null)).toEqual({ date: '2026-10-03' });
    expect(cellFromText('date', '2026-10-03 9:05', null)).toEqual({ date: '2026-10-03', time: '09:05' });
    expect(cellFromText('date', '31/02/2026', null)).toBeUndefined();
    expect(cellFromText('timeline', '01/10/2026 – 05/10/2026', null)).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(cellFromText('link', 'example.com/x', null)).toEqual({ url: 'https://example.com/x' });
    expect(cellFromText('checkbox', 'v', null)).toEqual({ checked: true });
    expect(cellFromText('email', 'a@b.co', null)).toEqual({ email: 'a@b.co' });
    expect(parseDateText('3.10.26')).toBe('2026-10-03');
  });

  it('labels by name (active ones), people and teams by name or email', () => {
    expect(cellFromText('status', 'בטיפול', status)).toEqual({ index: 3 });
    expect(cellFromText('status', 'אחר', status)).toBeUndefined();
    expect(cellFromText('dropdown', 'כחול, אדום, ישן', dropdown)).toEqual({ ids: [2, 1] });
    expect(cellFromText('people', 'dana@x.test, מכירות', null, people)).toEqual({
      persons_and_teams: [
        { id: 'u1', kind: 'person' },
        { id: 't1', kind: 'team' },
      ],
    });
  });
});

describe('convertCellValue (move to another board, 04 §6.2)', () => {
  it('keeps same-type values, maps labels by text, converts known pairs', () => {
    expect(convertCellValue({ type: 'numbers', value: 5, text: '5' }, { type: 'numbers', settings: null })).toBe(5);
    expect(
      convertCellValue({ type: 'status', value: { index: 9 }, text: 'בטיפול' }, { type: 'status', settings: status }),
    ).toEqual({ index: 3 });
    expect(
      convertCellValue({ type: 'status', value: { index: 9 }, text: 'אחר' }, { type: 'status', settings: status }),
    ).toBeUndefined();
    expect(
      convertCellValue(
        { type: 'date', value: { date: '2026-10-03' }, text: '03/10/2026' },
        { type: 'timeline', settings: null },
      ),
    ).toEqual({ from: '2026-10-03', to: '2026-10-03' });
    expect(convertCellValue({ type: 'numbers', value: 7, text: '7' }, { type: 'text', settings: null })).toBe('7');
    expect(
      convertCellValue({ type: 'long_text', value: { text: 'שלום' }, text: 'שלום' }, { type: 'text', settings: null }),
    ).toBe('שלום');
  });
});

describe('fromText is a registry hook (03 §1 — audit 2026-10-10 dedup #2)', () => {
  // Exactly the types the old switch in from-text.ts read; anything else is not pasted as text.
  const pasteable = [
    'text',
    'long_text',
    'ai',
    'numbers',
    'rating',
    'checkbox',
    'email',
    'phone',
    'link',
    'date',
    'timeline',
    'status',
    'dropdown',
    'tags',
    'people',
    'hour',
    'week',
    'world_clock',
    'color_picker',
    'country',
    'location',
  ].sort();

  it('every pasteable type has fromText, and no other type does', () => {
    const withHook = columnTypes
      .all()
      .filter((d) => d.fromText)
      .map((d) => d.type)
      .sort();
    expect(withHook).toEqual(pasteable);
  });

  it('cellFromText dispatches through the def: blank clears any type, a hook-less or unknown type is skipped', () => {
    expect(cellFromText('files', '   ', null)).toBeNull();
    expect(cellFromText('files', 'x', null)).toBeUndefined();
    expect(cellFromText('no_such_type', 'x', null)).toBeUndefined();
    expect(columnTypes.get('rating')!.fromText!(' 7 ', {}, { people: [] })).toEqual({ rating: 7 });
    expect(columnTypes.get('checkbox')!.fromText!('לא', {}, { people: [] })).toBeNull();
  });

  it('the defs keep the old trim rules: long text and AI keep the text as typed, the rest trim', () => {
    expect(cellFromText('long_text', '  a\nb  ', null)).toEqual({ text: '  a\nb  ' });
    expect(cellFromText('ai', '  a  ', null)).toEqual({ text: '  a  ' });
    expect(cellFromText('text', '  a  ', null)).toBe('a');
    expect(cellFromText('phone', ' 050-1234567 ', null)).toEqual({ phone: '050-1234567' });
    expect(cellFromText('tags', ' #a, #b ,a ', null)).toEqual({ tags: ['a', 'b'] });
    expect(
      cellFromText('date', '2026-10-03 9:05', null, [], { region: { timezone: 'Asia/Jerusalem' } as never }),
    ).toEqual({
      date: '2026-10-03',
      time: '06:05',
    });
  });
});
