// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two places decide that a stored file is unused and may be deleted: the API's `ROOT_UNUSED` (files.repo.ts — a
 * file trashed / replaced in the app) and the worker's `UNUSED` (the background sweep). They drifted once (the
 * worker missed the interactive documents' files, so their images and signed copies could be swept): every
 * `not exists (select 1 from <table> …)` and the columns it reads must be the same in both.
 */
const read = (path: string) => readFileSync(join(__dirname, '..', '..', '..', path), 'utf8');

/** The `not exists` clauses of one SQL text: table → the alias's columns it reads (sorted, joined). */
const clauses = (sqlText: string) => {
  const out = new Map<string, string>();
  const re = /not exists \(select 1 from (\w+) (\w+)([\s\S]*?)\)(?=\s*(?:and not exists|$|`))/g;
  for (const m of sqlText.matchAll(re)) {
    const [, table, alias, rest] = m;
    const cols = [...new Set([...rest!.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))].map((c) => c[1]!))].sort();
    const key = `${table}`;
    out.set(key, [...(out.get(key)?.split(',').filter(Boolean) ?? []), ...cols].sort().join(','));
  }
  return out;
};

const between = (text: string, start: string) => {
  const i = text.indexOf(start);
  expect(i, `${start} not found`).toBeGreaterThanOrEqual(0);
  const from = text.indexOf('`', i);
  const to = text.indexOf('`', from + 1);
  return text.slice(from + 1, to);
};

describe('the unused-file rules of the API and the worker', () => {
  it('check the same tables and columns', () => {
    const api = clauses(between(read('apps/api/src/modules/files/files.repo.ts'), 'const ROOT_UNUSED = sql'));
    const worker = clauses(between(read('apps/worker/src/repositories/files.repo.ts'), 'const UNUSED ='));
    expect(api.size).toBeGreaterThan(10);
    expect(Object.fromEntries(worker)).toEqual(Object.fromEntries(api));
  });
});
