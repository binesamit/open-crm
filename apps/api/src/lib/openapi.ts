// SPDX-License-Identifier: AGPL-3.0-only
import { z } from '@hono/zod-openapi';
import type { ZodType } from 'zod';

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
      request_id: z.string(),
    }),
  })
  .openapi('Error');

export const json = <T extends ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

export const jsonBody = <T extends ZodType>(schema: T) => ({
  body: { required: true, content: { 'application/json': { schema } } },
});

export const errors = (...statuses: (400 | 401 | 403 | 404 | 409 | 413 | 422 | 423 | 429)[]) =>
  Object.fromEntries(statuses.map((s) => [s, json(errorSchema, 'Error')])) as Record<number, ReturnType<typeof json>>;

/**
 * The error responses every account-scoped route can give (06 §1.1): bad input, no session, no right, not found,
 * a conflict, a validation error, a locked account / column. Spread it into `responses`; a route that also rate
 * limits or takes a body over the size limit adds `...errors(429)` / `...errors(413)`.
 */
export const COMMON_ERRORS = errors(400, 401, 403, 404, 409, 422, 423);

export const okSchema = z.object({ ok: z.literal(true) }).openapi('Ok');

export const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });

/** Header documenting account scoping on every scoped route (D12). */
export const accountHeader = z.object({
  // Required with a session (checked by requireAccount); an API token carries its own account (06 §1.2).
  'x-account-id': z
    .string()
    .optional()
    .openapi({
      param: { name: 'x-account-id', in: 'header' },
      description:
        'Account id (D12) — required with a session; optional with an API token (it is bound to one account)',
    }),
});
