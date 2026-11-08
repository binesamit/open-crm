// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, type ErrorEnvelope } from '@bines/shared';
import type { AppEnv } from '../types';
import type { Logger } from '../lib/logger';

const envelope = (err: AppError, requestId: string): ErrorEnvelope => ({
  error: {
    code: err.code,
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
    request_id: requestId,
  },
});

export const errorHandler =
  (logger: Logger): ErrorHandler<AppEnv> =>
  (err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    if (err instanceof AppError) {
      const wait = err.details?.retry_after_ms;
      if (err.code === 'rate_limited' && typeof wait === 'number')
        c.header('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
      return c.json(envelope(err, requestId), err.status as ContentfulStatusCode);
    }
    logger.error({ err, requestId }, 'unhandled error');
    return c.json(envelope(new AppError('internal', 'Internal error'), requestId), 500);
  };

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json(envelope(new AppError('not_found', 'Route not found'), c.get('requestId') ?? 'unknown'), 404);
