// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderNameSource } from '@bines/shared';
import {
  draftReady,
  draftToSource,
  insertColumn,
  removeSegment,
  segmentRefs,
  segmentsToTemplate,
  setSegmentText,
  templateToSegments,
  type Segment,
} from './template-segments';

const text = (t: string): Segment => ({ kind: 'text', text: t });
const col = (key: string): Segment => ({ kind: 'column', key });

describe('name template segments (way 2)', () => {
  it('loads a template as text / column / text …', () => {
    expect(templateToSegments('{client} – {date}')).toEqual([
      text(''),
      col('client'),
      text(' – '),
      col('date'),
      text(''),
    ]);
    expect(templateToSegments('')).toEqual([text('')]);
    expect(templateToSegments(undefined)).toEqual([text('')]);
  });

  it('round-trips, escaping literal braces', () => {
    for (const t of ['{client} – {date}', 'Order {{x}} {num}', 'Lead: {a}{b}'])
      expect(segmentsToTemplate(templateToSegments(t))).toBe(t);
    expect(segmentsToTemplate([text('a {b}'), col('k'), text('')])).toBe('a {{b}}{k}');
  });

  it('inserts a column at the caret, splitting the text', () => {
    const segs = [text('Order  for')];
    const next = insertColumn(segs, 'num', { index: 0, offset: 6 });
    expect(next).toEqual([text('Order '), col('num'), text(' for')]);
    expect(segmentsToTemplate(next)).toBe('Order {num} for');
  });

  it('appends a column when there is no caret', () => {
    expect(insertColumn([text('A ')], 'k')).toEqual([text('A '), col('k'), text('')]);
  });

  it('builds a two-column template from the list + text between', () => {
    let segs = templateToSegments('');
    segs = insertColumn(segs, 'client');
    segs = setSegmentText(segs, 2, ' – ');
    segs = insertColumn(segs, 'when', { index: 2, offset: 3 });
    expect(segmentsToTemplate(segs)).toBe('{client} – {when}');
    expect(segmentRefs(segs)).toEqual(['client', 'when']);
    const source = draftToSource({
      mode: 'template',
      columnId: null,
      segments: segs,
      emptyText: 'No name',
      warn: true,
    });
    expect(source).toEqual({
      mode: 'template',
      template: '{client} – {when}',
      empty_text: 'No name',
      warn_duplicates: true,
    });
    const texts: Record<string, string | null> = { client: 'Acme', when: '' };
    expect(renderNameSource(source, (k) => texts[k])).toBe('Acme');
  });

  it('removes a chip and joins its neighbours', () => {
    const segs = templateToSegments('a {x} b');
    expect(removeSegment(segs, 1)).toEqual([text('a  b')]);
  });

  it('is ready only with a column / a template column', () => {
    expect(draftReady({ mode: 'free', columnId: null, segments: [text('')] })).toBe(true);
    expect(draftReady({ mode: 'column', columnId: null, segments: [text('')] })).toBe(false);
    expect(draftReady({ mode: 'column', columnId: 'rel', segments: [text('')] })).toBe(true);
    expect(draftReady({ mode: 'template', columnId: null, segments: [text('only text')] })).toBe(false);
    expect(draftToSource({ mode: 'column', columnId: 'rel', segments: [], emptyText: ' ', warn: false })).toEqual({
      mode: 'column',
      column_id: 'rel',
      warn_duplicates: false,
    });
  });

  it('"open the card after creating" is saved only when on, and never for free names', () => {
    const base = { columnId: 'rel', segments: [], emptyText: '', warn: false };
    expect(draftToSource({ ...base, mode: 'column', openOnCreate: true })).toMatchObject({ open_on_create: true });
    expect(draftToSource({ ...base, mode: 'column', openOnCreate: false })).not.toHaveProperty('open_on_create');
    expect(draftToSource({ ...base, mode: 'free', openOnCreate: true })).not.toHaveProperty('open_on_create');
  });
});
