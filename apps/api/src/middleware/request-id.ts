// SPDX-License-Identifier: AGPL-3.0-only
import { createMiddleware } from 'hono/factory';
import { newId } from '@bines/shared';
import type { AppEnv } from '../types';

/** Every response carries X-Request-Id (06-API §1.1); an incoming one is kept if it looks sane. */
export const requestId = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : `req_${newId()}`;
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  });
