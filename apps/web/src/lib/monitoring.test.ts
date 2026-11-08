// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import { initMonitoring, reportError, scrubEvent } from './monitoring';

vi.mock('@sentry/react', async (importOriginal) => ({
  ...(await importOriginal<typeof Sentry>()),
  init: vi.fn(),
  captureException: vi.fn(),
}));

describe('web monitoring (GlitchTip)', () => {
  it('is a no-op without VITE_SENTRY_DSN', () => {
    expect(initMonitoring({ MODE: 'production' })).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    reportError(new Error('boom'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('starts with the built-in DSN, without tracing or PII', () => {
    expect(initMonitoring({ VITE_SENTRY_DSN: 'https://k@gt.example/3', VITE_SENTRY_RELEASE: 'abc' })).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://k@gt.example/3',
        release: 'abc',
        dataCollection: expect.objectContaining({ userInfo: false, httpBodies: [] }),
        tracesSampleRate: 0,
      }),
    );
  });

  it('scrubs query strings, emails and UI/console breadcrumbs', () => {
    const event = scrubEvent({
      request: { url: 'https://app.example/b/1?search=dana', headers: { cookie: 'x' } },
      exception: { values: [{ value: 'dana@example.com not found' }] },
      breadcrumbs: [{ category: 'console' }, { category: 'ui.input' }, { category: 'navigation', message: 'to /b/1' }],
    });
    expect(event.request).toEqual({ url: 'https://app.example/b/1' });
    expect(event.exception?.values?.[0]?.value).toBe('[email] not found');
    expect(event.breadcrumbs).toEqual([{ category: 'navigation', message: 'to /b/1', data: undefined }]);
  });

  it('reports each crash once, tagged with its area (round 12: route onCatch + error screen)', () => {
    initMonitoring({ VITE_SENTRY_DSN: 'https://k@gt.example/3' });
    const spy = vi.spyOn(Sentry, 'isInitialized').mockReturnValue(true);
    vi.mocked(Sentry.captureException).mockClear();
    const err = new Error('render crash');
    reportError(err, 'item');
    reportError(err, 'route');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { area: 'item' } });
    spy.mockRestore();
  });
});
