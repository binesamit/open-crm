// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateFormula,
  FORMULA_TEXT_MAX,
  formulaRefs,
  parseFormula,
  validateFormula,
  type RefValue,
} from '../src/formula';

const run = (src: string, refs: Record<string, RefValue> = {}, now = new Date('2026-10-01T09:00:00Z')) =>
  evaluateFormula(parseFormula(src), { ref: (k) => refs[k] ?? null, now });

describe('formula engine', () => {
  it('does arithmetic with precedence and blanks as 0', () => {
    expect(run('1+2*3')).toBe(7);
    expect(run('(1+2)*3')).toBe(9);
    expect(run('-{a}+10', { a: 4 })).toBe(6);
    expect(run('{a}-{b}', { a: 10 })).toBe(10);
    expect(run('2^3^2')).toBe(512);
    expect(run('{a}/{b}', { a: 1, b: 0 })).toBeNull();
  });

  it('compares numbers numerically and text as text', () => {
    expect(run('{a}>0', { a: '5' })).toBe(true);
    expect(run('{s}="תקלה"', { s: 'תקלה' })).toBe(true);
    expect(run('{s}<>"נפתר"', { s: 'חדש' })).toBe(true);
    expect(run('{d}<>""', { d: null })).toBe(false);
  });

  it('runs the imported Bines formulas unchanged', () => {
    const health =
      'IF(OR({lookup_mm6xf1br}>0,{lookup_mm6xk7pe}>0),"🔴 אדום",IF(OR({lookup_mm6xwq5g}>0,{lookup_mm6xce5v}>0),"🟡 צהוב","🟢 ירוק"))';
    expect(run(health, { lookup_mm6xf1br: 1200 })).toBe('🔴 אדום');
    expect(run(health, { lookup_mm6xwq5g: 2 })).toBe('🟡 צהוב');
    expect(run(health)).toBe('🟢 ירוק');

    expect(
      run('IF({numeric_mm6x844p}>0,ROUND({numeric_mm6x1m4s}/{numeric_mm6x844p}*100,1),0)', {
        numeric_mm6x844p: 3,
        numeric_mm6x1m4s: 1,
      }),
    ).toBe(33.3);

    const sla =
      'IF(AND({color_mm6xrcv7}<>"נפתר",{color_mm6xrcv7}<>"סגור",{date_mm6xzz5f}<>"",{date_mm6xzz5f}<TODAY()),"חריגה","")';
    expect(run(sla, { color_mm6xrcv7: 'בטיפול', date_mm6xzz5f: '2026-09-30' })).toBe('חריגה');
    expect(run(sla, { color_mm6xrcv7: 'נפתר', date_mm6xzz5f: '2026-09-30' })).toBe('');
    expect(run(sla, { color_mm6xrcv7: 'בטיפול', date_mm6xzz5f: null })).toBe('');

    expect(
      run('ROUND(HOURS_DIFF({resolved_at},{opened_at}),1)', {
        resolved_at: '2026-10-01T12:30:00Z',
        opened_at: '2026-10-01T09:00:00Z',
      }),
    ).toBe(3.5);
  });

  it('has the date and text helpers', () => {
    expect(run('DAYS("2026-10-11","2026-10-01")')).toBe(10);
    expect(run('ADD_DAYS(TODAY(),7)')).toBe('2026-10-08');
    expect(run('FORMAT_DATE("2026-10-01","DD/MM/YYYY")')).toBe('01/10/2026');
    expect(run('CONCATENATE("BT-",{n})&"!"', { n: 42 })).toBe('BT-42!');
    expect(run('SWITCH({s},"a",1,"b",2,0)', { s: 'b' })).toBe(2);
    expect(run('LEFT("שלום",2)')).toBe('של');
    expect(run('WORKDAYS("2026-10-10","2026-10-04")')).toBe(5); // Sun 4/10 – Sat 10/10: Sun–Thu count, Fri+Sat off
    expect(run('{t#end}', { t: { start: '2026-10-01', end: '2026-10-05' } })).toBe('2026-10-05');
  });

  describe('TODAY() and dates with a time in the account timezone', () => {
    const at = (src: string, now: string, timeZone?: string, refs: Record<string, RefValue> = {}) =>
      evaluateFormula(parseFormula(src), { ref: (k) => refs[k] ?? null, now: new Date(now), timeZone });

    it('is the local date around midnight (Israel, summer UTC+3)', () => {
      // 23:30 UTC on 4/10 = 02:30 on 5/10 in Jerusalem.
      expect(at('TODAY()', '2026-10-04T23:30:00Z')).toBe('2026-10-04');
      expect(at('TODAY()', '2026-10-04T23:30:00Z', 'Asia/Jerusalem')).toBe('2026-10-05');
      // 20:59 UTC = 23:59 local: still the 4th; 21:00 UTC = 00:00 local: the 5th.
      expect(at('TODAY()', '2026-10-04T20:59:59Z', 'Asia/Jerusalem')).toBe('2026-10-04');
      expect(at('TODAY()', '2026-10-04T21:00:00Z', 'Asia/Jerusalem')).toBe('2026-10-05');
    });

    it('follows winter time and zones behind UTC', () => {
      // Jerusalem winter UTC+2: 22:00 UTC on 31/12 is already 1/1.
      expect(at('YEAR(TODAY())', '2026-12-31T22:00:00Z', 'Asia/Jerusalem')).toBe(2027);
      expect(at('TODAY()', '2026-12-31T21:59:00Z', 'Asia/Jerusalem')).toBe('2026-12-31');
      // New York (UTC-4 in October): 02:00 UTC on 5/10 is still the 4th.
      expect(at('TODAY()', '2026-10-05T02:00:00Z', 'America/New_York')).toBe('2026-10-04');
    });

    it('compares and counts days from the local today', () => {
      const due = { d: '2026-10-05' };
      expect(at('{d}<TODAY()', '2026-10-05T22:00:00Z', 'Asia/Jerusalem', due)).toBe(true); // 01:00 on the 6th
      expect(at('{d}<TODAY()', '2026-10-05T20:00:00Z', 'Asia/Jerusalem', due)).toBe(false); // 23:00 on the 5th
      expect(at('DAYS(TODAY(),{d})', '2026-10-05T22:00:00Z', 'Asia/Jerusalem', due)).toBe(1);
      expect(at('ADD_DAYS(TODAY(),1)', '2026-10-05T22:00:00Z', 'Asia/Jerusalem')).toBe('2026-10-07');
    });

    it('reads the calendar and clock of a date with a time there; plain dates never shift', () => {
      const v = { t: '2026-10-04T22:30:00Z', d: '2026-10-04' };
      expect(at('DAY({t})', '2026-10-05T00:00:00Z', 'Asia/Jerusalem', v)).toBe(5);
      expect(at('HOUR({t})', '2026-10-05T00:00:00Z', 'Asia/Jerusalem', v)).toBe(1);
      expect(at('MINUTE({t})', '2026-10-05T00:00:00Z', 'Asia/Jerusalem', v)).toBe(30);
      expect(at('FORMAT_DATE({t},"DD/MM/YYYY")', '2026-10-05T00:00:00Z', 'Asia/Jerusalem', v)).toBe('05/10/2026');
      expect(at('ADD_DAYS({t},1)', '2026-10-05T00:00:00Z', 'Asia/Jerusalem', v)).toBe('2026-10-06');
      expect(at('DAY({d})', '2026-10-05T00:00:00Z', 'America/New_York', v)).toBe(4);
      expect(at('HOUR({t})', '2026-10-05T00:00:00Z', undefined, v)).toBe(22);
      // NOW() stays an instant.
      expect(at('NOW()', '2026-10-04T23:30:00Z', 'Asia/Jerusalem')).toBe('2026-10-04T23:30:00.000Z');
    });
  });

  it('collects refs and validates', () => {
    expect([...formulaRefs(parseFormula('IF({a}>0,{b},{c#end})'))].sort()).toEqual(['a', 'b', 'c']);
    expect(validateFormula('IF({a}>0,1')).toMatch(/\)/);
    expect(validateFormula('NOPE(1)')).toMatch(/Unknown function/);
    expect(validateFormula('{x}+1', new Set(['a']))).toMatch(/Unknown column/);
    expect(validateFormula('ROUND({a},1)', new Set(['a']))).toBeNull();
  });

  it('parses every formula in the built-in templates', () => {
    const dir = join(__dirname, '../../../seed/templates');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        columns: { type: string; settings: { formula?: string } }[];
        add_columns?: { type: string; settings: { formula?: string } }[];
      };
      for (const c of [...t.columns, ...(t.add_columns ?? [])].filter((c) => c.type === 'formula')) {
        expect(validateFormula(c.settings.formula ?? ''), `${f}: ${c.settings.formula}`).toBeNull();
      }
    }
  });
});

describe('S-70: formulas cannot exhaust the shared API process', () => {
  it('text a formula builds stops at FORMULA_TEXT_MAX', () => {
    const t0 = Date.now();
    expect((run('REPT("ab", 250000000)') as string).length).toBe(FORMULA_TEXT_MAX);
    expect((run('SUBSTITUTE(REPT("a", 9000), "a", REPT("x", 9000))') as string).length).toBe(FORMULA_TEXT_MAX);
    expect((run('CONCATENATE(REPT("a", 9000), REPT("b", 9000))') as string).length).toBe(FORMULA_TEXT_MAX);
    expect((run('REPT("a", 9000) & REPT("b", 9000)') as string).length).toBe(FORMULA_TEXT_MAX);
    expect((run('REPLACE("abc", 2, 1, REPT("z", 20000))') as string).length).toBe(FORMULA_TEXT_MAX);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Ordinary use is unchanged.
    expect(run('REPT("ab", 3)')).toBe('ababab');
    expect(run('REPT("ab", 0)')).toBe('');
    expect(run('SUBSTITUTE("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(run('CONCATENATE("a", 1, "b")')).toBe('a1b');
  });

  it('WORKDAYS counts whole weeks at once — same answers, no loop per day', () => {
    // The previous day-by-day count, as the reference.
    const reference = (from: string, to: string) => {
      let [a, b] = [new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`)];
      let sign = 1;
      if (a > b) [a, b, sign] = [b, a, -1];
      let n = 0;
      for (let d = a; d <= b; d = new Date(d.getTime() + 86_400_000))
        if (d.getUTCDay() !== 5 && d.getUTCDay() !== 6) n++;
      return n * sign;
    };
    const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 40; i++)
      for (const len of [0, 1, 2, 5, 6, 7, 8, 13, 14, 30, 100]) {
        const [s, e] = [day(i), day(i + len)];
        expect(run(`WORKDAYS("${e}","${s}")`), `${s}..${e}`).toBe(reference(s, e));
        expect(run(`WORKDAYS("${s}","${e}")`), `${e}..${s}`).toBe(reference(e, s));
      }
    const t0 = Date.now();
    expect(typeof run('WORKDAYS("9999-12-31","0001-01-01")')).toBe('number');
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
