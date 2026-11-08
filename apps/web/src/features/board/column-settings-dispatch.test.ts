// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import { ENGINE_FORMS, hasColumnSettings, settingsFormFor, TYPE_FORMS } from './ColumnSettings';
import { P1_FORMS } from './P1ColumnForms';

/**
 * Prod drift guard: the column menu's "הגדרות עמודה" (`hasColumnSettings`) must reach every settings form the
 * dialog has. Read from the real tables and the column-type registry, so a new form can never be unreachable again
 * (the date column's form was, from a hand-kept copy of the list).
 */
const types = columnTypes.all().map((d) => d.type);

describe('column settings dispatch', () => {
  it('offers the settings for every registered type that has a form', () => {
    const withForm = types.filter((type) => settingsFormFor(type));
    expect(withForm.length).toBeGreaterThan(0);
    for (const type of withForm) expect(hasColumnSettings(type), type).toBe(true);
  });

  it('every form table entry is a real type / engine, and finds its form', () => {
    for (const type of [...Object.keys(TYPE_FORMS), ...Object.keys(P1_FORMS)]) {
      expect(columnTypes.has(type), `${type} is not a registered column type`).toBe(true);
      expect(settingsFormFor(type), type).toBeDefined();
      expect(hasColumnSettings(type), type).toBe(true);
    }
    const engines = new Set(types.map((type) => columnTypes.get(type)?.engine).filter(Boolean));
    for (const engine of Object.keys(ENGINE_FORMS)) {
      expect(engines.has(engine as never), `no column type has the engine ${engine}`).toBe(true);
      for (const type of types.filter((x) => columnTypes.get(x)?.engine === engine))
        expect(hasColumnSettings(type), type).toBe(true);
    }
  });

  it('the date column has its form (include time, weekday, year, Hebrew date)', () => {
    expect(settingsFormFor('date')).toBeDefined();
    expect(hasColumnSettings('date')).toBe(true);
  });
});
