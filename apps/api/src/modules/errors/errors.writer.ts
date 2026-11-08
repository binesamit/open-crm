// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ErrorLinks,
  type ErrorSeverity,
  type ErrorSource,
  errorFingerprint,
  redactErrorMessage,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Logger } from '../../lib/logger';
import { type PendingError, writeErrorBatch } from './errors.repo';
import { loadErrorHubSettings } from './errors.settings';

/**
 * The errors hub's writer: `recordError` never waits and never throws — it redacts, fingerprints and
 * puts the error in an in-memory queue (one entry per fingerprint: a loop of 10 000 identical failures is one entry
 * with count 10 000). A timer flushes the queue every `writer.flush_seconds` in one batch (`writeErrorBatch`); past
 * `writer.max_queue` distinct entries new ones are dropped and counted (the next flush records how many). One queue
 * per database handle, so tests and processes never mix. Sources switched off in the settings are dropped at flush.
 */
export type ErrorInput = {
  source: ErrorSource;
  /** A short machine code (`http_500`, `no_recipients`, `TypeError`…). */
  code: string;
  /** Any text; it is redacted here (credentials, addresses, quoted values, numbers). */
  message?: unknown;
  accountId?: string | null;
  /** Default: the source's severity in the settings. */
  severity?: ErrorSeverity;
  links?: ErrorLinks;
  at?: Date;
  /** Occurrences this entry stands for (default 1). */
  count?: number;
  /**
   * An automation skip: kept only when its reason (`code`) is one of the settings' problem skips (decision 4) —
   * decided at flush, so recording stays synchronous.
   */
  skip?: boolean;
};

type Entry = Omit<PendingError, 'severity'> & { severity: ErrorSeverity | null; skip: boolean };

type Writer = {
  queue: Map<string, Entry>;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
  maxQueue: number;
  flushMs: number;
  dropped: number;
  droppedTotal: number;
  /** Distinct browser reports (`client`) queued now — at most CLIENT_QUEUE_SHARE of the queue (S-96). */
  clientQueued: number;
  logger?: Pick<Logger, 'warn'>;
};

const writers = new WeakMap<object, Writer>();

/** S-96: browser reports may fill at most this share of the queue, so a flood of them never crowds out server errors. */
export const CLIENT_QUEUE_SHARE = 0.25;

const writerOf = (db: Db): Writer => {
  let w = writers.get(db);
  if (!w) {
    w = {
      queue: new Map(),
      timer: null,
      flushing: null,
      maxQueue: 2000,
      flushMs: 3000,
      dropped: 0,
      droppedTotal: 0,
      clientQueued: 0,
    };
    writers.set(db, w);
  }
  return w;
};

/** Where flush failures are logged (the api sets its logger once; without one they are silent). */
export const setErrorWriterLogger = (db: Db, logger: Pick<Logger, 'warn'>) => {
  writerOf(db).logger = logger;
};

const HOUR = 3_600_000;
const cleanCode = (code: string) =>
  redactErrorMessage(code)
    .replace(/[^\w.:-]+/g, '_')
    .slice(0, 80) || 'error';

/** Redacts and fingerprints one error (exported for the tests and the worker's twin). */
export const toPending = (input: ErrorInput): Entry => {
  const at = input.at ?? new Date();
  // `redactErrorMessage` starts with `scrubSecrets` (lib/scrub.ts), then masks addresses, values and numbers.
  const message = redactErrorMessage(input.message ?? input.code);
  const code = cleanCode(input.code);
  const accountId = input.accountId ?? null;
  const links = Object.fromEntries(
    Object.entries(input.links ?? {})
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k, v]) => [k, String(v).slice(0, 200)]),
  );
  const count = Math.max(1, Math.floor(input.count ?? 1));
  return {
    fingerprint: errorFingerprint({ source: input.source, code, message, accountId, links }),
    accountId,
    source: input.source,
    code,
    severity: input.severity ?? null,
    message,
    links,
    count,
    firstAt: at,
    lastAt: at,
    hours: new Map([[Math.floor(at.getTime() / HOUR) * HOUR, count]]),
    skip: input.skip ?? false,
  };
};

/** Queues an error; returns at once. Never throws. */
export const recordError = (db: Db, input: ErrorInput) => {
  try {
    const w = writerOf(db);
    const e = toPending(input);
    const had = w.queue.get(e.fingerprint);
    if (had) {
      had.count += e.count;
      if (e.lastAt > had.lastAt) {
        had.lastAt = e.lastAt;
        had.message = e.message;
        had.links = { ...had.links, ...e.links };
      }
      if (e.firstAt < had.firstAt) had.firstAt = e.firstAt;
      if (e.severity) had.severity = e.severity;
      for (const [h, n] of e.hours) had.hours.set(h, (had.hours.get(h) ?? 0) + n);
    } else if (
      w.queue.size >= w.maxQueue ||
      (e.source === 'client' && w.clientQueued >= Math.max(1, Math.floor(w.maxQueue * CLIENT_QUEUE_SHARE)))
    ) {
      w.dropped += e.count;
      w.droppedTotal += e.count;
    } else {
      w.queue.set(e.fingerprint, e);
      if (e.source === 'client') w.clientQueued++;
    }
    if (!w.timer) {
      w.timer = setTimeout(() => void flushErrors(db), w.flushMs);
      w.timer.unref?.();
    }
  } catch {
    // The hub must never break the path that failed.
  }
};

/** Writes what is queued now (the timer calls it; tests and shutdown call it directly). */
export const flushErrors = async (db: Db): Promise<void> => {
  const w = writerOf(db);
  if (w.timer) {
    clearTimeout(w.timer);
    w.timer = null;
  }
  if (w.flushing) await w.flushing;
  if (!w.queue.size && !w.dropped) {
    // Nothing to write: still pick up the queue size and interval the owner may have changed.
    try {
      const { writer } = await loadErrorHubSettings(db);
      w.maxQueue = writer.max_queue;
      w.flushMs = writer.flush_seconds * 1000;
    } catch {
      // keep the current limits
    }
    return;
  }
  const batch = [...w.queue.values()];
  const dropped = w.dropped;
  w.queue = new Map();
  w.clientQueued = 0;
  w.dropped = 0;
  w.flushing = (async () => {
    try {
      const settings = await loadErrorHubSettings(db);
      w.maxQueue = settings.writer.max_queue;
      w.flushMs = settings.writer.flush_seconds * 1000;
      const problems = new Set(settings.problem_skips);
      const rows: PendingError[] = batch
        .filter((e) => settings.sources[e.source].enabled && (!e.skip || problems.has(e.code)))
        .map(({ skip: _skip, ...e }) => ({ ...e, severity: e.severity ?? settings.sources[e.source].severity }));
      if (dropped) {
        const { skip: _skip, ...e } = toPending({
          source: 'job',
          code: 'error_writer_dropped',
          message: 'error_writer_dropped',
          count: dropped,
        });
        rows.push({ ...e, severity: 'warning' });
      }
      await writeErrorBatch(db, rows);
    } catch (err) {
      w.logger?.warn({ err: String(err), lost: batch.length }, 'errors hub: flush failed');
    }
  })();
  await w.flushing;
  w.flushing = null;
};

/** Writes one error now (scripts that exit right after, e.g. the importers). */
export const recordErrorNow = async (db: Db, input: ErrorInput) => {
  recordError(db, input);
  await flushErrors(db);
};

/** Errors dropped since the process started (the console shows it). */
export const droppedErrors = (db: Db) => writerOf(db).droppedTotal;

/** The code of an error object: its AppError code / name, else `error`. */
export const errorCodeOf = (err: unknown): string => {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; name?: unknown; message?: unknown };
    // An AppError's message is usually the precise reason (`ai_disabled`, `flow_platform_error`…).
    if (e.name === 'AppError' && typeof e.message === 'string' && /^[a-z][a-z0-9_]{2,79}$/.test(e.message))
      return e.message;
    if (typeof e.code === 'string' && e.code) return e.code;
    if (typeof e.name === 'string' && e.name && e.name !== 'Error') return e.name;
  }
  return 'error';
};
