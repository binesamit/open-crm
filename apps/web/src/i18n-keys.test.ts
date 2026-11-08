// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en, he } from '@bines/shared';

/**
 * dedup-1: every message key the web app names exists in he.json AND en.json (the owner.license.* and
 * s37intdocs.* strings were never merged and the screens showed raw keys). The typecheck already refuses a literal
 * key passed to `t` / `msgKey`; this test also covers what the compiler cannot see: keys cast `as MessageKey`, the
 * branches of `cond ? 'a.b' : 'c.d'`, and the static prefix of a key built at runtime (`tDynamic(`plan.kind.${k}`)`
 * — some key must start with it). Keys looked up with a fallback (`key in he ? … : …`, `hasMessage`) are exempt.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const heKeys = new Set(Object.keys(he));
const enKeys = new Set(Object.keys(en));

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });

const KEY = String.raw`[a-zA-Z][\w-]*(?:\.[\w-]+)+`;
type Use = { file: string; key: string; prefix?: boolean };

const usesIn = (file: string, text: string): Use[] => {
  const out: Use[] = [];
  const add = (key: string, prefix = false) => out.push({ file: file.slice(SRC.length), key, prefix });
  // `t` and its aliases in this file (`import { t as tr }`), and the shared helpers.
  const aliases = [...text.matchAll(/\bt as (\w+)\b/g)].map((m) => m[1]!);
  const fns = ['t', 'tDynamic', 'msgKey', 'dynamicKey', ...aliases].join('|');
  const call = new RegExp(String.raw`(?<![\w.$])(?:${fns})\(\s*`, 'g');
  for (const m of text.matchAll(call)) {
    const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
    let lit: RegExpMatchArray | null;
    if ((lit = rest.match(new RegExp(String.raw`^'(${KEY})'`)))) add(lit[1]!);
    else if ((lit = rest.match(new RegExp(String.raw`^\`(${KEY}\.?)\$\{`)))) add(lit[1]!, true);
    else if ((lit = rest.match(new RegExp(String.raw`^\(?[^'"\`()]*\?\s*'(${KEY})'\s*:\s*'(${KEY})'`)))) {
      add(lit[1]!);
      add(lit[2]!);
    }
  }
  // Literal keys cast where the compiler cannot check them.
  for (const m of text.matchAll(new RegExp(String.raw`'(${KEY})' as MessageKey`, 'g'))) add(m[1]!);
  for (const m of text.matchAll(new RegExp(String.raw`\?\s*'(${KEY})'\s*:\s*'(${KEY})'\)\s*as MessageKey`, 'g'))) {
    add(m[1]!);
    add(m[2]!);
  }
  return out;
};

const all = sources(SRC).flatMap((f) => usesIn(f, readFileSync(f, 'utf8')));

describe('message keys used by the web app', () => {
  it('finds the keys (the scan itself works)', () => {
    expect(all.length).toBeGreaterThan(3000);
    expect(all.some((u) => u.key === 'owner.license.title')).toBe(true);
    expect(all.some((u) => u.prefix && u.key === 'owner.license.state.')).toBe(true);
  });

  it('every literal key exists in he.json and en.json', () => {
    const missing = all
      .filter((u) => !u.prefix)
      .filter((u) => !heKeys.has(u.key) || !enKeys.has(u.key))
      .map((u) => `${u.file}: ${u.key}${heKeys.has(u.key) ? ' (en.json)' : enKeys.has(u.key) ? ' (he.json)' : ''}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('no file wraps `t` in its own untyped helper (`(key: string) => t(key as MessageKey)`)', () => {
    const wrapper = /\(key: string[^)]*\)\s*=>\s*(?:t\(\s*)?(?:key|`[\w.]*\$\{key\}`) as MessageKey/;
    const offenders = sources(SRC)
      .filter((f) => wrapper.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });

  it('every key built at runtime starts like some key in both files', () => {
    const heList = [...heKeys];
    const enList = [...enKeys];
    const missing = all
      .filter((u) => u.prefix)
      .filter((u) => !heList.some((k) => k.startsWith(u.key)) || !enList.some((k) => k.startsWith(u.key)))
      .map((u) => `${u.file}: ${u.key}…`);
    expect([...new Set(missing)]).toEqual([]);
  });
});
