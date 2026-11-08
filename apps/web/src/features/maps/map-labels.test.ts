// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { labelExpression, localizedLabels, localizeMap, readsName } from './map-labels';

/** Round 11: map labels in the UI language (OpenFreeMap liberty shapes). */
const LIBERTY_PLACE = [
  'case',
  ['has', 'name:nonlatin'],
  ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']],
  ['coalesce', ['get', 'name_en'], ['get', 'name']],
];

describe('map labels', () => {
  it('finds the layers that show names', () => {
    expect(readsName(LIBERTY_PLACE)).toBe(true);
    expect(readsName('{name:latin}')).toBe(true);
    expect(readsName(['get', 'name'])).toBe(true);
    expect(readsName('{housenumber}')).toBe(false);
    expect(readsName(['get', 'ref'])).toBe(false);
    expect(readsName(undefined)).toBe(false);
  });

  it('relabels symbol layers only, Hebrew first in Hebrew', () => {
    const layers = [
      { id: 'water', type: 'fill' },
      { id: 'place_city', type: 'symbol', layout: { 'text-field': LIBERTY_PLACE } },
      { id: 'road_name', type: 'symbol', layout: { 'text-field': '{name}' } },
      { id: 'housenumber', type: 'symbol', layout: { 'text-field': '{housenumber}' } },
      { id: 'poi_icon', type: 'symbol', layout: { 'icon-image': 'x' } },
    ];
    const he = localizedLabels(layers, 'he');
    expect(he.map((l) => l.id)).toEqual(['place_city', 'road_name']);
    expect(he[0]!.field).toEqual(['coalesce', ['get', 'name:he'], ['get', 'name']]);
    expect(localizedLabels(layers, 'en')[0]!.field).toEqual(labelExpression('en'));
    expect(JSON.stringify(labelExpression('en'))).toContain('name:en');
  });

  it('applies to a map and survives a layer that refuses', () => {
    const set: string[] = [];
    localizeMap(
      {
        getStyle: () => ({
          layers: [
            { id: 'a', type: 'symbol', layout: { 'text-field': '{name}' } },
            { id: 'b', type: 'symbol', layout: { 'text-field': '{name}' } },
          ],
        }),
        setLayoutProperty: (id) => {
          if (id === 'a') throw new Error('bad');
          set.push(id);
        },
      },
      'he',
    );
    expect(set).toEqual(['b']);
  });
});
