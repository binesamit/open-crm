// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The automation-dispatch trigger (migration 0024, per statement) only queues activity rows of the types it lists.
 * Every activity type that a webhook or an automation trigger listens to must be in that list — otherwise those
 * events are silently dropped in production. This test reads the latest trigger SQL and the types the code uses.
 */
const root = join(__dirname, '..', '..', '..');
const drizzle = join(root, 'apps', 'api', 'drizzle');

const triggerTypes = (): Set<string> => {
  const file = readdirSync(drizzle)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .find((f) => readFileSync(join(drizzle, f), 'utf8').includes('bines_enqueue_automation_dispatch_rows'));
  if (!file) throw new Error('dispatch trigger migration not found');
  const sql = readFileSync(join(drizzle, file), 'utf8');
  const list = /n\."type" IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
  return new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
};

const typesIn = (path: string, pattern: RegExp): string[] =>
  [...readFileSync(join(root, path), 'utf8').matchAll(pattern)].map((m) => m[1]!);

/**
 * Types the trigger does not list because the service that records them queues `automation.dispatch` itself, in the
 * same transaction — each with the file that does it.
 */
const SELF_DISPATCHED: Record<string, string> = {
  'file.added': 'apps/api/src/modules/files/files.service.ts',
};

describe('automation dispatch trigger', () => {
  it('lists every activity type that webhooks and automation triggers listen to', () => {
    const listed = triggerTypes();
    expect(listed.size).toBeGreaterThan(10);
    const webhook = typesIn('packages/shared/src/api/webhooks.ts', /case '([a-z_]+\.[a-z_.]+)'/g);
    const automations = readdirSync(join(root, 'apps', 'api', 'src', 'modules', 'automations'))
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => typesIn(`apps/api/src/modules/automations/${f}`, /(?:case |type === )'([a-z_]+\.[a-z_.]+)'/g));
    const missing = [...new Set([...webhook, ...automations])].filter((t) => !listed.has(t) && !SELF_DISPATCHED[t]);
    expect(missing).toEqual([]);
  });

  it('a self-dispatched type really queues its own dispatch', () => {
    for (const [type, path] of Object.entries(SELF_DISPATCHED)) {
      const src = readFileSync(join(root, path), 'utf8');
      expect(src, `${path} records ${type}`).toContain(`type: '${type}'`);
      expect(src, `${path} queues automation.dispatch`).toContain("enqueueJob(tx, 'automation.dispatch'");
    }
  });
});
