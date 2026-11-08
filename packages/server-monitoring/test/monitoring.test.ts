// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { captureError, closeMonitoring, initMonitoring, scrubEvent } from '../src';

vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof Sentry>()),
  init: vi.fn(),
  captureException: vi.fn(),
}));

/** The one monitoring module of the api and the worker (audit 2026-10-10, duplication #1). */
describe('server monitoring', () => {
  it('is a no-op without SENTRY_DSN', async () => {
    expect(initMonitoring({ NODE_ENV: 'production' }, 'worker')).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    captureError(new Error('boom'), { task: 'x' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    await expect(closeMonitoring()).resolves.toBeUndefined();
  });

  it('starts with the scrubber as beforeSend when SENTRY_DSN is set', () => {
    expect(initMonitoring({ SENTRY_DSN: 'https://k@example.test/1', NODE_ENV: 'production' }, 'api')).toBe(true);
    const options = vi.mocked(Sentry.init).mock.calls[0]![0]!;
    expect(options.tracesSampleRate).toBe(0);
    expect(options.initialScope).toEqual({ tags: { service: 'api' } });
    const sent = options.beforeSend!({ type: undefined, message: 'key sk-ant-api03-abcdefghijklmnop' }, {});
    expect((sent as Sentry.ErrorEvent).message).toBe('key [secret]');
  });

  it('masks credentials and emails; keeps only the user id, the URL path and no extras', () => {
    const event = scrubEvent({
      message: 'Bearer abcdefghijklmnopqrstuvwxyz for dana@example.com',
      user: { id: 'u1', email: 'dana@example.com', ip_address: '10.0.0.1' },
      request: { method: 'GET', url: 'https://x.test/a?token=abc', headers: { cookie: 'c', 'user-agent': 'UA' } },
      exception: { values: [{ type: 'Error', value: 'bos_svc_abcdef123456 refused' }] },
      breadcrumbs: [
        { category: 'console', message: 'secret sk-ant-api03-abcdefghij' },
        { category: 'http', message: 'ok', data: { url: 'https://x.test/b?q=1' } },
      ],
      extra: { body: 'x' },
    });
    expect(event.message).toBe('Bearer [secret] for [email]');
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.request).toEqual({ method: 'GET', url: 'https://x.test/a', headers: { 'user-agent': 'UA' } });
    expect(event.exception?.values?.[0]?.value).toBe('[secret] refused');
    expect(event.breadcrumbs).toEqual([{ category: 'http', message: 'ok', data: { url: 'https://x.test/b' } }]);
    expect(event.extra).toBeUndefined();
  });
});
