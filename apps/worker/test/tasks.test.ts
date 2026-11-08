// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { parseCronItems, type JobHelpers } from 'graphile-worker';
import { taskList } from '../src/tasks';

describe('system.ping', () => {
  it('validates its payload and logs', async () => {
    const info = vi.fn();
    const helpers = { logger: { info } } as unknown as JobHelpers;
    await taskList['system.ping']!({ message: 'hi' }, helpers);
    expect(info).toHaveBeenCalledWith('system.ping: hi');
  });

  it('rejects a malformed payload', async () => {
    const helpers = { logger: { info: vi.fn() } } as unknown as JobHelpers;
    await expect(taskList['system.ping']!({ message: 42 }, helpers)).rejects.toThrow();
  });
});

describe('trash.purge', () => {
  it('is scheduled hourly (graphile-worker accepts the schedule) and rejects a malformed payload', async () => {
    const { cronItems } = await import('../src/tasks');
    const parsed = parseCronItems(cronItems);
    expect(parsed.map((c) => c.task)).toEqual([
      'trash.purge',
      'time.forgotten',
      'notifications.digest',
      'files.purge',
      'support.sla',
    ]);
    for (const c of parsed) expect(taskList[c.task]).toBeDefined();
    const helpers = { logger: { info: vi.fn(), error: vi.fn() } } as unknown as JobHelpers;
    await expect(taskList['trash.purge']!({ limit: -1 }, helpers)).rejects.toThrow();
  });
});

describe('notifications.digest (audit 2026-10-10 worker #19)', () => {
  it('runs as the cron tick it stands for, and a missed hour is backfilled', async () => {
    const { cronItems, cronTickOf } = await import('../src/tasks');
    expect(cronTickOf({ _cron: { ts: '2026-10-10T05:00:00.000Z', backfilled: true } }).toISOString()).toBe(
      '2026-10-10T05:00:00.000Z',
    );
    const fallback = new Date('2026-10-10T07:30:00.000Z');
    expect(cronTickOf({}, fallback)).toBe(fallback);
    expect(cronTickOf({ _cron: { ts: 'not a date' } }, fallback)).toBe(fallback);
    const digest = parseCronItems(cronItems).find((c) => c.task === 'notifications.digest')!;
    expect(digest.options.backfillPeriod).toBe(24 * 60 * 60 * 1000);
  });
});
