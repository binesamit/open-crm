// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { Hono } from 'hono';
import { AppError } from '@bines/shared';
import {
  captureError,
  closeMonitoring,
  initMonitoring,
  reportingErrorHandler,
  scrubEvent,
} from '../src/lib/monitoring';
import { errorHandler } from '../src/middleware/error';
import { monitoringOrigin, spaCsp } from '../src/middleware/security-headers';
import type { AppEnv } from '../src/types';
import type { Logger } from '../src/lib/logger';

vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof Sentry>()),
  init: vi.fn(),
  captureException: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe('monitoring (GlitchTip)', () => {
  it('is a no-op without SENTRY_DSN', async () => {
    expect(initMonitoring({ NODE_ENV: 'production' }, 'api')).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    expect(Sentry.isInitialized()).toBe(false);
    captureError(new Error('boom'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    await expect(closeMonitoring()).resolves.toBeUndefined();
  });

  it('starts with the DSN, the Railway release and environment, and no tracing or PII', () => {
    const on = initMonitoring(
      {
        SENTRY_DSN: 'https://k@gt.example/1',
        RAILWAY_GIT_COMMIT_SHA: 'abc123',
        RAILWAY_ENVIRONMENT_NAME: 'staging',
        NODE_ENV: 'production',
      },
      'api',
    );
    expect(on).toBe(true);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://k@gt.example/1',
        release: 'abc123',
        environment: 'staging',
        dataCollection: expect.objectContaining({ userInfo: false, httpBodies: [] }),
        tracesSampleRate: 0,
      }),
    );
  });

  it('keeps 5xx answers unchanged when off', async () => {
    const logger = { error: vi.fn() } as unknown as Logger;
    const app = new Hono<AppEnv>();
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.get('/nope', () => {
      throw new AppError('not_found', 'Nope');
    });
    app.onError(reportingErrorHandler(errorHandler(logger)));
    expect((await app.request('/boom')).status).toBe(500);
    expect((await app.request('/nope')).status).toBe(404);
  });

  it('scrubs personal data from events', () => {
    const event = scrubEvent({
      message: 'failed for dana@example.com',
      request: {
        method: 'POST',
        url: 'https://app.example/api/v1/items?token=abc',
        data: '{"password":"x"}',
        cookies: { session: 'secret' },
        headers: { authorization: 'Bearer x', cookie: 'a=b', 'user-agent': 'UA' },
        query_string: 'token=abc',
      },
      user: { id: 'u1', email: 'dana@example.com', ip_address: '1.2.3.4' },
      exception: { values: [{ type: 'Error', value: 'no user dana@example.com' }] },
      breadcrumbs: [
        { category: 'console', message: 'dana@example.com' },
        { category: 'http', data: { url: 'https://x.example/a?q=secret' } },
      ],
      extra: { body: 'x' },
    });
    expect(event.request).toEqual({
      method: 'POST',
      url: 'https://app.example/api/v1/items',
      headers: { 'user-agent': 'UA' },
    });
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.message).toBe('failed for [email]');
    expect(event.exception?.values?.[0]?.value).toBe('no user [email]');
    expect(event.breadcrumbs).toEqual([{ category: 'http', data: { url: 'https://x.example/a' } }]);
    expect(event.extra).toBeUndefined();
  });
});

describe('CSP and the monitoring origin', () => {
  const base = { S3_ENDPOINT: undefined, NODE_ENV: 'production' as const };
  const connectSrc = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src'));

  it('adds the DSN origin to connect-src when set', () => {
    const csp = spaCsp({ ...base, VITE_SENTRY_DSN: 'https://abc123@glitchtip.example.com/3' });
    expect(connectSrc(csp)).toBe("connect-src 'self' https://glitchtip.example.com");
  });

  it('falls back to the api DSN and ignores a malformed one', () => {
    expect(monitoringOrigin({ SENTRY_DSN: 'https://k@gt.example:8443/1' })).toBe('https://gt.example:8443');
    expect(monitoringOrigin({ VITE_SENTRY_DSN: 'not a url' })).toBeUndefined();
  });

  it('leaves connect-src as before without a DSN', () => {
    expect(connectSrc(spaCsp(base))).toBe("connect-src 'self'");
  });
});
