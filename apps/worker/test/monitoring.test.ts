// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { captureError, closeMonitoring, initMonitoring, scrubEvent } from '../src/monitoring';

vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof Sentry>()),
  init: vi.fn(),
  captureException: vi.fn(),
}));

describe('worker monitoring (GlitchTip)', () => {
  it('is a no-op without SENTRY_DSN', async () => {
    expect(initMonitoring({ NODE_ENV: 'production' }, 'worker')).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    captureError(new Error('boom'), { task: 'trash.purge' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    await expect(closeMonitoring()).resolves.toBeUndefined();
  });

  it('scrubs emails and keeps only the user id', () => {
    const event = scrubEvent({
      message: 'mail to dana@example.com failed',
      user: { id: 'u1', email: 'dana@example.com' },
    });
    expect(event.message).toBe('mail to [email] failed');
    expect(event.user).toEqual({ id: 'u1' });
  });

  // Audit 2026-10-10 (duplication #1): the worker's copy used to mask emails only — a job error carrying a credential
  // reached GlitchTip as is. Now the worker uses the api's scrubbing (@bines/server-monitoring).
  it('masks credentials in a job error, like the api', () => {
    const event = scrubEvent({
      message: 'AI call failed with key sk-ant-api03-abcdefghijklmnop',
      exception: {
        values: [
          { type: 'Error', value: 'POST /v1 → 401, Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
          { type: 'Error', value: 'token bos_pat_0123456789abcdef rejected for ops@example.com' },
        ],
      },
      breadcrumbs: [{ category: 'http', message: 'retry with sk-proj-ABCDEFGHIJKLMNOPQRSTUV' }],
    });
    expect(event.message).toBe('AI call failed with key [secret]');
    expect(event.exception?.values?.[0]?.value).toBe('POST /v1 → 401, Authorization: Bearer [secret]');
    expect(event.exception?.values?.[1]?.value).toBe('token [secret] rejected for [email]');
    expect(event.breadcrumbs?.[0]?.message).toBe('retry with [secret]');
  });
});
