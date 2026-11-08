// SPDX-License-Identifier: AGPL-3.0-only
import { EventEmitter } from 'node:events';
import type { PGlite, Results, Transaction } from '@electric-sql/pglite';

/**
 * A node-postgres `Pool` look-alike over one embedded PGlite (standalone mode, docs/SELF-HOSTING.md). graphile-worker
 * (the job queue) and the worker's plain-SQL repositories expect a pg pool: `connect()` → a client with `query`,
 * `release` and `notification` events. PGlite is ONE connection, so:
 *
 * - a client's `BEGIN … COMMIT/ROLLBACK` runs as a PGlite transaction, which holds PGlite's exclusive lock — every
 *   other query (the app's drizzle handle included) waits until it ends, exactly as on a single Postgres session;
 * - `LISTEN` / `UNLISTEN` are bookkeeping per client; the one session listens and each client hears its channels;
 * - values are parsed like node-postgres does (int8 and numeric as strings), so code written for pg reads the same.
 *
 * Only what the queue and the repositories use is implemented (no cursors, COPY, prepared statement names).
 */

/** node-postgres parses these as strings (JS numbers would lose precision). */
const INT8 = 20;
const NUMERIC = 1700;
const asText = (v: string) => v;
const PG_PARSERS = { [INT8]: asText, [NUMERIC]: asText };

type QueryConfig = { text: string; values?: unknown[] };
export type PgLikeResult = { rows: Record<string, unknown>[]; rowCount: number; fields: { name: string }[] };
type Callback = (err: Error | null, res?: PgLikeResult) => void;

const toResult = (r: Results | undefined): PgLikeResult => ({
  rows: (r?.rows ?? []) as Record<string, unknown>[],
  // pg counts a SELECT's rows too; PGlite reports only rows written (0 for a SELECT).
  rowCount: r?.affectedRows || r?.rows.length || 0,
  fields: (r?.fields ?? []).map((f) => ({ name: f.name })),
});

/** The leading statement keyword(s) — comments and whitespace skipped. */
const head = (text: string) =>
  text
    .replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '')
    .slice(0, 40)
    .toLowerCase();

/** `LISTEN "a"; LISTEN b;` → [['listen','a'],['listen','b']], or null when the text is anything else. */
export const parseListen = (text: string): ['listen' | 'unlisten', string][] | null => {
  const parts = text
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: ['listen' | 'unlisten', string][] = [];
  for (const part of parts) {
    const m = /^(listen|unlisten)\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*|\*)$/i.exec(part);
    if (!m) return null;
    const raw = m[2]!;
    const channel = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
    out.push([m[1]!.toLowerCase() as 'listen' | 'unlisten', channel]);
  }
  return out;
};

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

type OpenTx = { tx: Transaction; end: (how: 'commit' | 'rollback') => Promise<void> };

export class PgliteClient extends EventEmitter {
  private open: OpenTx | null = null;
  readonly channels = new Set<string>();

  constructor(
    private readonly pg: PGlite,
    private readonly pool: PglitePool,
  ) {
    super();
  }

  /** pg's overloads: (text), (text, values), (config), and a trailing callback. */
  query(textOrConfig: string | QueryConfig, valuesOrCb?: unknown[] | Callback, cb?: Callback): Promise<PgLikeResult> {
    const config = typeof textOrConfig === 'string' ? { text: textOrConfig } : textOrConfig;
    const values = Array.isArray(valuesOrCb) ? valuesOrCb : config.values;
    const callback = typeof valuesOrCb === 'function' ? valuesOrCb : cb;
    const run = this.run(config.text, values);
    if (callback) {
      run.then(
        (r) => callback(null, r),
        (e: Error) => callback(e),
      );
    }
    return run;
  }

  private async run(text: string, values: unknown[] | undefined): Promise<PgLikeResult> {
    const verb = head(text);
    if (/^(begin|start\s+transaction)\b/.test(verb)) {
      if (!this.open) this.open = await this.begin();
      return toResult(undefined);
    }
    if (/^(commit|end)\b/.test(verb) && this.open) return this.finish('commit');
    if (/^rollback\b/.test(verb) && !/\bto\b/.test(verb) && this.open) return this.finish('rollback');

    const listen = parseListen(text);
    if (listen) {
      for (const [op, channel] of listen) {
        if (op === 'listen') {
          // The one session listens for everyone; never UNLISTENed (another client may still want it).
          if (!this.pool.listening.has(channel)) {
            await (this.open?.tx ?? this.pg).exec(`LISTEN ${quoteIdent(channel)}`);
            this.pool.listening.add(channel);
          }
          this.channels.add(channel);
        } else if (channel === '*') this.channels.clear();
        else this.channels.delete(channel);
      }
      return toResult(undefined);
    }

    const target = this.open?.tx ?? this.pg;
    if (values && values.length) return toResult(await target.query(text, values, { parsers: PG_PARSERS }));
    // No parameters: the simple protocol, which (like pg) takes several statements in one text.
    const all = await target.exec(text, { parsers: PG_PARSERS });
    return toResult(all[all.length - 1]);
  }

  /** Opens a PGlite transaction and keeps it open until COMMIT / ROLLBACK (or release) ends it. */
  private begin(): Promise<OpenTx> {
    return new Promise<OpenTx>((resolveOpen, rejectOpen) => {
      let decide!: (how: 'commit' | 'rollback') => void;
      const decided = new Promise<'commit' | 'rollback'>((r) => (decide = r));
      let opened = false;
      const done = this.pg
        .transaction(async (tx) => {
          opened = true;
          resolveOpen({
            tx,
            end: async (how) => {
              decide(how);
              await done;
            },
          });
          if ((await decided) === 'rollback') await tx.rollback();
        })
        .catch((err: unknown) => {
          if (!opened) rejectOpen(err);
          else throw err;
        });
    });
  }

  private async finish(how: 'commit' | 'rollback'): Promise<PgLikeResult> {
    const open = this.open!;
    this.open = null;
    if (how === 'rollback') await open.end('rollback').catch(() => undefined);
    else await open.end('commit');
    return toResult(undefined);
  }

  /** Back to the pool: an unfinished transaction is rolled back, so it never holds the database. */
  async release(): Promise<void> {
    if (this.open) await this.finish('rollback');
    this.channels.clear();
    this.pool.clients.delete(this);
  }

  /** pg's helper (some callers build identifiers with it). */
  escapeIdentifier(name: string) {
    return quoteIdent(name);
  }
}

export class PglitePool extends EventEmitter {
  readonly clients = new Set<PgliteClient>();
  readonly listening = new Set<string>();
  private readonly stopNotifications: () => void;
  private ended = false;

  constructor(private readonly pg: PGlite) {
    super();
    this.stopNotifications = pg.onNotification((channel, payload) => {
      for (const client of this.clients)
        if (client.channels.has(channel)) client.emit('notification', { channel, payload, processId: 0 });
    });
  }

  connect(): Promise<PgliteClient>;
  connect(cb: (err: Error | null, client?: PgliteClient, release?: () => void) => void): void;
  connect(cb?: (err: Error | null, client?: PgliteClient, release?: () => void) => void): Promise<PgliteClient> | void {
    if (this.ended) {
      const err = new Error('pool ended');
      if (cb) return void cb(err);
      return Promise.reject(err);
    }
    const client = new PgliteClient(this.pg, this);
    this.clients.add(client);
    this.emit('connect', client);
    if (cb) return void cb(null, client, () => void client.release());
    return Promise.resolve(client);
  }

  /** A one-off query on a short-lived client (pg's `pool.query`). */
  async query(textOrConfig: string | QueryConfig, values?: unknown[]): Promise<PgLikeResult> {
    const client = await this.connect();
    try {
      return await client.query(textOrConfig, values);
    } finally {
      await client.release();
    }
  }

  /** Ends the pool only: the PGlite instance is closed by its owner. */
  async end(): Promise<void> {
    this.ended = true;
    this.stopNotifications();
    for (const client of [...this.clients]) await client.release();
  }

  get totalCount() {
    return this.clients.size;
  }
}
