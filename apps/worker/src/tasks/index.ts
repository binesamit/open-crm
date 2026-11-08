// SPDX-License-Identifier: AGPL-3.0-only
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { CronItem, JobHelpers, Task, TaskList } from 'graphile-worker';
import { z } from 'zod';
import { channelAllowed, newId } from '@bines/shared';
import { assetsOfEntry, dueTrashEntries, purgeTrashEntry, type SqlClient } from '../repositories/trash.repo';
import { channelSettings } from '../repositories/notifications.repo';
import { forgottenTimers, notifyForgotten } from '../repositories/time.repo';
import { deleteAsset, orphanAssets, type StoredAsset, unusedAssets } from '../repositories/files.repo';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createMailer } from '@bines/server-mail';
import { dispatchNotification, type MailDeps, sendDigests } from '../notifications';
import { alertSlaBreaches } from '../support-sla';
import { dispatchPush, type PushDeps, vapidFrom, webPushSender } from '../push';
import { appUrlFrom } from '../public-address';
import { recordWorkerError } from '../repositories/errors.repo';

const pingPayload = z.object({ message: z.string().default('pong') });
const dispatchPayload = z.object({ id: z.string().min(1) });
/** What graphile-worker's cron adds to a job: the tick it stands for (also when backfilled). */
const cronPayload = z.object({ _cron: z.object({ ts: z.string().min(1) }).loose() }).loose();
/** The moment a cron job stands for — its scheduled tick, so a backfilled job runs as its own hour; else now. */
export const cronTickOf = (payload: unknown, fallback = new Date()): Date => {
  const at = cronPayload.safeParse(payload);
  const ts = at.success ? new Date(at.data._cron.ts) : fallback;
  return Number.isNaN(ts.getTime()) ? fallback : ts;
};

/** Mail transport from the worker's environment (same variables as the API), built once. */
let mailer: MailDeps['mailer'] | null = null;
/**
 * Mail transport + the app's public address: the owner console's setting, else WEB_ORIGIN (M11) — read per job, so a
 * new domain reaches every email link without redeploying the worker.
 */
const mail = async (db: SqlClient, logError: (msg: string) => void): Promise<MailDeps> => ({
  mailer: capturingMailer(
    db,
    (mailer ??= createMailer(process.env, {
      error: (obj, msg) => logError(`${msg} ${JSON.stringify(obj)}`),
    })),
  ),
  appUrl: await appUrlFrom(db),
});

/** `resend: 422 …` → `resend_422`; a plain reason stays. */
const mailCode = (err: unknown) => {
  const text = err instanceof Error ? err.message : String(err);
  const http = /^(\w+): (\d{3})\b/.exec(text);
  return http ? `${http[1]}_${http[2]}` : /^[a-z_]{3,60}$/.test(text) ? text : 'email_failed';
};

/**
 * Errors hub: a failed send is recorded (source `email`), then the job fails as before (and retries).
 * Costs: a sent email is counted (usage_meter `email_sent`, the platform's); a lost count fails nothing.
 */
const capturingMailer = (db: SqlClient, inner: MailDeps['mailer']): MailDeps['mailer'] => ({
  async send(message) {
    try {
      await inner.send(message);
    } catch (err) {
      await recordWorkerError(db, { source: 'email', code: mailCode(err), message: err });
      throw err;
    }
    await db
      .query(
        `insert into usage_meter (day, account_ref, metric, quantity) values ((now() at time zone 'utc')::date, '', 'email_sent', 1)
         on conflict (day, account_ref, metric) do update set quantity = usage_meter.quantity + 1`,
      )
      .catch(() => undefined);
  },
});

/**
 * Errors hub: a job that failed its last attempt is recorded (source `job`, the task's name — never its
 * payload); earlier attempts are retries. The error is rethrown, so graphile-worker and GlitchTip see it as before.
 */
export const capturingTasks = (tasks: TaskList): TaskList =>
  Object.fromEntries(
    Object.entries(tasks).map(([name, task]) => [
      name,
      (async (payload: unknown, helpers: JobHelpers) => {
        try {
          return await (task as Task)(payload, helpers);
        } catch (err) {
          const job = helpers?.job;
          if (helpers?.withPgClient && (!job || job.attempts >= job.max_attempts))
            await helpers
              .withPgClient((client) =>
                recordWorkerError(client as unknown as SqlClient, {
                  source: 'job',
                  code: err instanceof Error && err.name !== 'Error' ? err.name : 'job_failed',
                  message: err,
                  links: { job: name },
                }),
              )
              .catch(() => undefined);
          throw err;
        }
      }) as Task,
    ]),
  );

/** Web Push (PWA): the real sender, the app's public address and the VAPID pair (environment, else the API's). */
const push = async (db: SqlClient): Promise<PushDeps> => ({
  sender: webPushSender,
  appUrl: await appUrlFrom(db),
  vapid: vapidFrom(db, process.env),
});

const purgePayload = z.object({ limit: z.number().int().positive().max(10_000).default(1000) }).loose();

/** Removes each file from storage first, then its row — a failed delete keeps the row for the next sweep. */
const removeFiles = async (
  db: SqlClient,
  files: StoredAsset[],
  remove: (key: string) => Promise<void>,
  log: (msg: string) => void,
) => {
  let removed = 0;
  for (const asset of files) {
    try {
      await remove(asset.storage_key);
      await deleteAsset(db, asset.id);
      removed++;
    } catch (err) {
      log(`files.purge: ${asset.id} failed: ${(err as Error).message}`);
    }
  }
  return removed;
};

/**
 * One purge pass: every due entry, each in its own transaction; a failing one is logged and retried next run.
 * With storage (`remove`), the files the purged rows held leave the bucket right away when nothing else uses
 * them (owner fix6-server 2b) — an update, reply, item, group, column or board taken out of trash for good.
 */
export const purgeTrash = async (
  db: SqlClient,
  limit: number,
  log: (msg: string) => void,
  remove?: (key: string) => Promise<void>,
) => {
  let purged = 0;
  for (const entry of await dueTrashEntries(db, limit)) {
    try {
      const held = remove ? await assetsOfEntry(db, entry) : [];
      await purgeTrashEntry(db, entry);
      purged++;
      if (remove && held.length) await removeFiles(db, await unusedAssets(db, [...new Set(held)]), remove, log);
    } catch (err) {
      log(`trash.purge: ${entry.object_type} ${entry.object_id} failed: ${(err as Error).message}`);
    }
  }
  return purged;
};

/**
 * Uploads unused this many hours leave storage: never attached (a draft thrown away, a closed tab) or left
 * over by anything else. Removing a file from a cell or an update deletes it at once (the API).
 */
export const FILE_GRACE_HOURS = 24;

/** One pass over orphaned files (storage first, then the row). Returns how many went. */
export const purgeOrphanFiles = async (
  db: SqlClient,
  remove: (key: string) => Promise<void>,
  limit: number,
  log: (msg: string) => void,
) => removeFiles(db, await orphanAssets(db, limit, FILE_GRACE_HOURS), remove, log);

/**
 * Standalone mode's local disk (FILES_DIR, apps/api/src/lib/disk-storage.ts): the object and its `.meta.json`.
 * Keys never leave the folder (the same rule as the API's `localFilePath`).
 */
export const localFileRemover =
  (root: string) =>
  async (key: string): Promise<void> => {
    const base = resolve(root);
    const parts = key.split('/');
    if (!key || key.includes('\0') || key.includes('\\') || parts.some((p) => !p || p === '.' || p === '..'))
      throw new Error('invalid_storage_key');
    const full = resolve(base, ...parts);
    if (!full.startsWith(base + sep)) throw new Error('invalid_storage_key');
    await rm(full, { force: true });
    await rm(`${full}.meta.json`, { force: true });
  };

/**
 * The S3 bucket (R2 in production, MinIO locally) from the same variables as the API; else the local disk when
 * FILES_DIR is set (standalone mode); null when neither.
 */
let storage: ((key: string) => Promise<void>) | null | undefined;
const storageRemover = () => {
  if (storage !== undefined) return storage;
  const env = process.env;
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    return (storage = env.FILES_DIR ? localFileRemover(env.FILES_DIR) : null);
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION ?? 'auto',
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  // S3 deletes are idempotent: a missing key is not an error.
  return (storage = async (key) => {
    await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  });
};

/** Flags timers running past the limit, once each (the bell shows them with M4). */
export const flagForgottenTimers = async (db: SqlClient) => {
  const timers = await forgottenTimers(db);
  for (const timer of timers) {
    const rows = await channelSettings(db, timer.account_id, timer.user_id, 'in_app');
    const bell = channelAllowed(rows, 'in_app', 'time.forgotten', [timer.board_id, timer.top_board_id]);
    await notifyForgotten(db, newId(), timer, bell);
  }
  return timers.length;
};

/**
 * Task registry (01-ARCHITECTURE §5). Every task validates its payload with zod (CLAUDE.md rule 8).
 * Real tasks (automations.evaluate, webhooks.deliver, account.purge …) arrive with their modules.
 */
export const taskList: TaskList = capturingTasks({
  'system.ping': async (payload, helpers) => {
    const { message } = pingPayload.parse(payload ?? {});
    helpers.logger.info(`system.ping: ${message}`);
  },
  /** Hourly (crontab in index.ts): removes what passed its 30 days in trash, or was deleted permanently. */
  'trash.purge': async (payload, helpers) => {
    const { limit } = purgePayload.parse(payload ?? {});
    const remove = storageRemover() ?? undefined;
    const purged = await helpers.withPgClient((client) =>
      purgeTrash(client as unknown as SqlClient, limit, (m) => helpers.logger.error(m), remove),
    );
    if (purged) helpers.logger.info(`trash.purge: ${purged} purged`);
  },
  /** Hourly: uploads nothing used for 24 hours leave R2 and the database (never-attached drafts, leftovers). */
  'files.purge': async (payload, helpers) => {
    const { limit } = purgePayload.parse(payload ?? {});
    const remove = storageRemover();
    if (!remove) {
      helpers.logger.info('files.purge: no S3 storage configured — skipped');
      return;
    }
    const n = await helpers.withPgClient((client) =>
      purgeOrphanFiles(client as unknown as SqlClient, remove, limit, (m) => helpers.logger.error(m)),
    );
    if (n) helpers.logger.info(`files.purge: ${n} removed`);
  },
  /** Hourly: "forgot your timer?" for timers running over 12 hours (03 §3.3). */
  'time.forgotten': async (_payload, helpers) => {
    const n = await helpers.withPgClient((client) => flagForgottenTimers(client as unknown as SqlClient));
    if (n) helpers.logger.info(`time.forgotten: ${n} flagged`);
  },
  /**
   * Enqueued by the notifications trigger (migration 0010), a minute after the notification: one email unless
   * it was read meanwhile or the settings say otherwise. A throw (mail provider down) retries, up to 5 times.
   */
  'notifications.dispatch': async (payload, helpers) => {
    const { id } = dispatchPayload.parse(payload);
    const result = await helpers.withPgClient(async (client) => {
      const db = client as unknown as SqlClient;
      return dispatchNotification(db, await mail(db, (m) => helpers.logger.error(m)), id);
    });
    if (result === 'sent') helpers.logger.info(`notifications.dispatch: ${id} emailed`);
  },
  /** Every 5 minutes: support tickets whose SLA deadline passed are announced to staff once. */
  'support.sla': async (_payload, helpers) => {
    const n = await helpers.withPgClient(async (client) => {
      const db = client as unknown as SqlClient;
      return alertSlaBreaches(db, await mail(db, (m) => helpers.logger.error(m)));
    });
    if (n) helpers.logger.info(`support.sla: ${n} alerts sent`);
  },
  /**
   * Enqueued by the push trigger (migration 0061_r19pwa) at once, for users with a registered phone: one message to each
   * of their phones unless the settings, quiet hours or the read state say otherwise (PWA פ4).
   */
  'notifications.push': async (payload, helpers) => {
    const { id } = dispatchPayload.parse(payload);
    const result = await helpers.withPgClient(async (client) => {
      const db = client as unknown as SqlClient;
      return dispatchPush(db, await push(db), id);
    });
    if (result === 'sent') helpers.logger.info(`notifications.push: ${id} pushed`);
  },
  /**
   * Hourly: the daily digest for users who chose it, at 08:00 their time (08 §12.3). The hour is the cron's
   * scheduled time, not the clock: a tick the worker missed (down, restarting) is backfilled by graphile-worker
   * (`backfillPeriod` below) and still sends that hour's digests (audit 2026-10-10 worker #19).
   */
  'notifications.digest': async (payload, helpers) => {
    const now = cronTickOf(payload);
    const n = await helpers.withPgClient(async (client) => {
      const db = client as unknown as SqlClient;
      return sendDigests(db, await mail(db, (m) => helpers.logger.error(m)), now);
    });
    if (n) helpers.logger.info(`notifications.digest: ${n} sent`);
  },
});

/**
 * Recurring jobs. Cron items, not a crontab string: the crontab syntax rejects dotted task names (`trash.purge`).
 * `match` = minute hour day-of-month month day-of-week.
 */
export const cronItems: CronItem[] = [
  { task: 'trash.purge', match: '0 * * * *', identifier: 'trash.purge' },
  { task: 'time.forgotten', match: '30 * * * *', identifier: 'time.forgotten' },
  // A missed hour is run late (up to a day back) with its own timestamp, so no one's digest day is skipped.
  {
    task: 'notifications.digest',
    match: '0 * * * *',
    identifier: 'notifications.digest',
    options: { backfillPeriod: 24 * 60 * 60 * 1000 },
  },
  { task: 'files.purge', match: '15 * * * *', identifier: 'files.purge' },
  { task: 'support.sla', match: '*/5 * * * *', identifier: 'support.sla' },
];
