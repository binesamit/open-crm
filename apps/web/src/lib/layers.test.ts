// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * one stacking scale (packages/ui/src/layers.css). Inside the page a component may use small numbers
 * (`z-1` … `z-40`); anything above that — the shell, panels, dialogs, popovers, toasts, tours — takes a named layer
 * (`z-shell`, `z-panel`, `z-modal`, `z-popover`, …), so the top bar can never again sit over an open surface.
 */
const ROOTS = ['../../../../apps/web/src', '../../../../packages/ui/src'].map((r) =>
  fileURLToPath(new URL(r, import.meta.url)),
);
const PAGE_MAX = 40;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });

const css = readFileSync(fileURLToPath(new URL('../../../../packages/ui/src/layers.css', import.meta.url)), 'utf8');
const value = (name: string) => Number(new RegExp(`--z-${name}: (\\d+);`).exec(css)?.[1]);

describe('the stacking scale', () => {
  it('no numbered layer above the page: shell, panels, dialogs and popovers use the named layers', () => {
    const found: string[] = [];
    for (const file of ROOTS.flatMap(files)) {
      if (file.endsWith('layers.css')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/(?<![\w-])z-\[(\d+)\]|(?<![\w-])z-(\d+)(?![\w-])|z-index:\s*(\d+)/g)) {
            const n = Number(m[1] ?? m[2] ?? m[3]);
            if (n > PAGE_MAX) found.push(`${file}:${i + 1} ${m[0]}`);
          }
        });
    }
    expect(found).toEqual([]);
  });

  it('the layers keep their order: page < shell < flyout < panel < modal < palette < popover < toast < tour', () => {
    const order = ['shell', 'flyout', 'panel', 'modal', 'palette', 'popover', 'toast', 'tour', 'tooltip', 'system'];
    const values = order.map(value);
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
    expect(values[0]).toBeGreaterThan(PAGE_MAX);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]!);
  });
});
