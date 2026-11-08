// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';

const HealthSchema = z
  .object({
    status: z.literal('ok'),
    version: z.string(),
    time: z.string().openapi({ example: '2026-10-01T08:00:00.000Z' }),
  })
  .openapi('Health');

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['system'],
  summary: 'Liveness probe (unscoped, unauthenticated)',
  responses: {
    200: { description: 'Service is up', content: { 'application/json': { schema: HealthSchema } } },
  },
});

export const healthRoutes = new OpenAPIHono<AppEnv>().openapi(healthRoute, (c) =>
  c.json({
    status: 'ok' as const,
    version: process.env.npm_package_version ?? '0.0.0',
    time: new Date().toISOString(),
  }),
);
