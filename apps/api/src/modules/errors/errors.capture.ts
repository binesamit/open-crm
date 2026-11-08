// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import type { Mailer } from '@bines/server-mail';
import type { ErrorHandler } from 'hono';
import type { JobHelpers, Task, TaskList } from 'graphile-worker';
import type { Db } from '../../db/client';
import type { SmsSender } from '../../lib/sms';
import type { AppEnv } from '../../types';
import { errorCodeOf, recordError } from './errors.writer';

/**
 * Sources that are wrappers rather than one call site: every email and SMS the api sends, every
 * background job of the api's runner, and every unexpected server error (the "code" source, with the request id
 * GlitchTip has too). Each wrapper records and then behaves exactly as before (rethrows / answers the same).
 */

const mailCode = (err: unknown) => {
  const text = err instanceof Error ? err.message : String(err);
  const http = /^(\w+): (\d{3})\b/.exec(text);
  return http ? `${http[1]}_${http[2]}` : /^[a-z_]{3,60}$/.test(text) ? text : errorCodeOf(err);
};

/** The api's mailer, recording each failed send (source `email`). */
export const capturingMailer = (db: Db, inner: Mailer): Mailer =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'send') return Reflect.get(target, prop, receiver);
      return async (message: Parameters<Mailer['send']>[0]) => {
        try {
          return await target.send(message);
        } catch (err) {
          recordError(db, { source: 'email', code: mailCode(err), message: err });
          throw err;
        }
      };
    },
  });

/** The api's SMS sender, recording each failed send (source `sms`). */
export const capturingSms = (db: Db, inner: SmsSender): SmsSender =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop !== 'send') return Reflect.get(target, prop, receiver);
      return async (message: Parameters<SmsSender['send']>[0]) => {
        try {
          return await target.send(message);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          const code = /^sms: (\w+)/.exec(text)?.[1] ?? (/^[a-z_]{3,60}$/.test(text) ? text : errorCodeOf(err));
          recordError(db, { source: 'sms', code, message: err });
          throw err;
        }
      };
    },
  });

/**
 * Background jobs: a job that failed its last attempt is recorded (source `job`, the task's name); earlier attempts
 * are retries, not failures yet. The job's payload is never recorded (it may carry anything).
 */
export const capturingTasks = (db: Db, tasks: TaskList): TaskList =>
  Object.fromEntries(
    Object.entries(tasks).map(([name, task]) => [
      name,
      (async (payload: unknown, helpers: JobHelpers) => {
        try {
          return await (task as Task)(payload, helpers);
        } catch (err) {
          const job = helpers?.job;
          if (!job || job.attempts >= job.max_attempts)
            recordError(db, { source: 'job', code: errorCodeOf(err), message: err, links: { job: name } });
          throw err;
        }
      }) as Task,
    ]),
  );

/**
 * Unexpected server errors (500s that are not an AppError): recorded with the request id (the "Open in GlitchTip"
 * search) and the account of the request when there is one. The answer is the inner handler's.
 */
export const recordingErrorHandler =
  (db: Db, handler: ErrorHandler<AppEnv>): ErrorHandler<AppEnv> =>
  async (err, c) => {
    const res = await handler(err, c);
    if (res.status >= 500 && !(err instanceof AppError)) {
      let accountId: string | null = null;
      try {
        accountId = c.get('account')?.accountId ?? null;
      } catch {
        accountId = null;
      }
      const path = c.req.routePath && c.req.routePath !== '*' ? c.req.routePath : c.req.path;
      recordError(db, {
        source: 'code',
        code: errorCodeOf(err),
        message: err,
        accountId,
        links: { request_id: c.get('requestId') ?? '', page: `${c.req.method} ${path}`.slice(0, 200) },
      });
    }
    return res;
  };
