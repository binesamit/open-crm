// SPDX-License-Identifier: AGPL-3.0-only
import pino from 'pino';
import type { Env } from '../env';
import { scrubSecrets } from './scrub';

/** Fields that hold credentials wherever they appear (one level deep, like pino's `*.x`). */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  // AI connection keys and their sealed form (D26, AI-RT7); headers of outbound calls.
  '*.apiKey',
  '*.api_key',
  '*.keyEnc',
  '*.key_enc',
  '*.authorization',
  '*.headers.authorization',
  '*.headers["x-api-key"]',
];

/** An error as logged: pino's standard shape, with any credential in its message or stack masked (AI-RT7). */
const errSerializer = (err: Error) => {
  const out = pino.stdSerializers.err(err);
  if (typeof out.message === 'string') out.message = scrubSecrets(out.message);
  if (typeof out.stack === 'string') out.stack = scrubSecrets(out.stack);
  return out;
};

const options = (env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, pretty: boolean): pino.LoggerOptions => ({
  level: env.LOG_LEVEL,
  redact: REDACT,
  serializers: { err: errSerializer },
  ...(pretty && env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});

// Never log secrets or tokens (CLAUDE.md rule 10): redact the usual suspects at the logger level.
export const createLogger = (env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, destination?: pino.DestinationStream) =>
  destination ? pino(options(env, false), destination) : pino(options(env, true));

export type Logger = ReturnType<typeof createLogger>;
