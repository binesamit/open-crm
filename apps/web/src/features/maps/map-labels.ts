// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Round 11 (product owner: "על המפה צריך שיהיו שמות הכתובות, הערים…"): the map's place / street labels in the UI language.
 * Vector styles (OpenFreeMap "liberty" and other OpenMapTiles styles) label with `name:latin` / `name:nonlatin` /
 * `name_en` / `name`; this rewrites every symbol layer whose `text-field` reads a name to the UI language first, then
 * the local name: Hebrew UI → `name:he` → `name`; English UI → `name:en` → `name_en` → `name:latin` → `name`.
 * Layers that label other things (house numbers, road shields `ref`) are left alone. Generic — any style works.
 */
type Lang = 'he' | 'en';
type Layer = { id: string; type: string; layout?: Record<string, unknown> };

const NAME_FIELD = /"name(?:[:_][a-z-]+)?"|\{name(?:[:_][a-z-]+)?\}/i;

/** Does this `text-field` (an expression or a legacy "{token}" string) show a feature's name? */
export const readsName = (field: unknown): boolean => {
  if (field == null) return false;
  const text = typeof field === 'string' ? field : JSON.stringify(field);
  return NAME_FIELD.test(text) && !/housenumber|"ref"|\{ref\}/.test(text);
};

export const labelExpression = (lang: Lang): unknown[] =>
  lang === 'he'
    ? ['coalesce', ['get', 'name:he'], ['get', 'name']]
    : ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];

/** The layers to relabel, with their new `text-field`. */
export const localizedLabels = (layers: readonly Layer[], lang: Lang): { id: string; field: unknown[] }[] =>
  layers
    .filter((l) => l.type === 'symbol' && readsName(l.layout?.['text-field']))
    .map((l) => ({ id: l.id, field: labelExpression(lang) }));

/** Applies {@link localizedLabels} to a loaded MapLibre map (a failing layer keeps its own labels). */
export const localizeMap = (
  map: {
    getStyle: () => { layers?: readonly Layer[] } | undefined;
    setLayoutProperty: (id: string, name: string, value: unknown) => unknown;
  },
  lang: Lang,
) => {
  for (const { id, field } of localizedLabels(map.getStyle()?.layers ?? [], lang)) {
    try {
      map.setLayoutProperty(id, 'text-field', field);
    } catch {
      // a style the expression does not fit: its own label stays
    }
  }
};
