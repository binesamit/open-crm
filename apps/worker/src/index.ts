// SPDX-License-Identifier: AGPL-3.0-only
import { parseCronItems, run } from 'graphile-worker';
import { mailTransport } from '@bines/server-mail';
import { captureError, closeMonitoring, initMonitoring } from './monitoring';
import { cronItems, taskList } from './tasks';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env file: rely on the real environment (Railway)
}

// GlitchTip (roadmap ס4): on only when SENTRY_DSN is set; reports crashes and jobs that failed for good.
initMonitoring(process.env, 'worker');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('worker: DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}

// Which mail transport the jobs will use (none = email off: notifications are logged, never sent).
const transport = mailTransport(process.env);
console.warn(
  transport === 'none'
    ? 'worker: email is off (no mail transport: set SMTP_HOST, RESEND_API_KEY or MAILPIT_URL)'
    : `worker: email transport = ${transport}`,
);

const runner = await run({
  connectionString,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
  noHandleSignals: false,
  pollInterval: 1000,
  taskList,
  parsedCronItems: parseCronItems(cronItems),
});

// Retries are normal; a job is reported once it has used up its attempts.
runner.events.on('job:failed', ({ job, error }) => {
  captureError(error, { task: job.task_identifier, jobId: String(job.id), attempts: String(job.attempts) });
});

await runner.promise;
await closeMonitoring();
