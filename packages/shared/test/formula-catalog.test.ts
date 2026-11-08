// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { evaluateFormula, FORMULA_CATALOG, FORMULA_FUNCTIONS, formatFormulaResult, parseFormula } from '../src';

/** The function reference shown in the formula column settings is complete and its examples are true. */
describe('formula catalog', () => {
  it('documents every function the engine knows, once', () => {
    const names = FORMULA_CATALOG.map((f) => f.name);
    expect([...names].sort()).toEqual([...FORMULA_FUNCTIONS].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  for (const f of FORMULA_CATALOG) {
    it(`${f.name}: ${f.example} = ${f.result}`, () => {
      const v = evaluateFormula(parseFormula(f.example), { ref: () => null, now: new Date('2026-10-03T10:00:00Z') });
      expect(formatFormulaResult(v)).toBe(f.result);
    });
  }
});
