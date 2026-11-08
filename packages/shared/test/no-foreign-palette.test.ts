// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOREIGN_PALETTE } from './foreign-palette';

/**
 * CI colour guard (D-PAL): no hex of the palette another work-management tool ships appears in our source — the app,
 * the API, the shared package, templates, packs, extensions, integrations and docs. The only exceptions are the
 * known-input tables that map imported / old data to our keys: `LEGACY_LABEL_HEX` in colors.ts and migration 0080.
 * Tests and E2E specs may hold the hex values they feed in as old data; they are not scanned.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCAN = ['apps', 'packages', 'seed', 'extensions', 'integrations', 'docs', 'design-guide', 'scripts', 'perf'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '__snapshots__', 'fixtures']);
const EXT = /\.(ts|tsx|js|mjs|cjs|css|json|sql|md|html|svg|ya?ml)$/;
const IS_TEST = /\.(test|spec)\.[a-z]+$/;
/** Files that may hold the foreign hex values, and where in them. */
const KNOWN_INPUT: Record<string, (text: string, at: number) => boolean> = {
  'packages/shared/src/colors.ts': (text, at) => {
    const start = text.indexOf('export const LEGACY_LABEL_HEX');
    return start >= 0 && at > start && at < text.indexOf('\n};', start);
  },
  'apps/api/drizzle/0080_own_palette.sql': () => true,
};

const walk = (dir: string, out: string[]) => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name) && !IS_TEST.test(name) && st.size < 3_000_000) out.push(p);
  }
};

const files = (() => {
  const out: string[] = [];
  for (const d of SCAN) walk(join(ROOT, d), out);
  return out;
})();

const FOREIGN = new RegExp(`#(${FOREIGN_PALETTE.map((h) => h.slice(1)).join('|')})(?![0-9a-f])`, 'gi');

describe('CI colour guard', () => {
  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith(`colors.ts`))).toBe(true);
  });

  it('no imported palette hex in our source, outside the known-input tables', () => {
    const hits: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split(sep).join('/');
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(FOREIGN)) {
        if (KNOWN_INPUT[rel]?.(text, m.index)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${rel}:${line} ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('catches one (the guard itself works)', () => {
    expect('color: #FDAB3D;'.match(FOREIGN)).toEqual(['#FDAB3D']);
    expect('#fdab3dff'.match(FOREIGN)).toBeNull();
  });
});
