// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Postgres store (its own database, DATABASE_URL). Rows are kept as JSONB next to the keys they are looked up
 * by; the migrations below run on boot, each once, in order.
 */
import pg from 'pg';
import { withDefaults } from './config';
import type { ConnectionRow, InstallationRow, LinkRow, LogRow, Store, StreamRow } from './store';

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS cs_installations (id text PRIMARY KEY, data jsonb NOT NULL);
   CREATE TABLE IF NOT EXISTS cs_connections (
     id text PRIMARY KEY, installation_id text NOT NULL, user_id text NOT NULL, data jsonb NOT NULL,
     UNIQUE (installation_id, user_id));
   CREATE TABLE IF NOT EXISTS cs_streams (
     id text PRIMARY KEY, installation_id text NOT NULL, channel_id text, data jsonb NOT NULL);
   CREATE INDEX IF NOT EXISTS cs_streams_inst ON cs_streams (installation_id);
   CREATE INDEX IF NOT EXISTS cs_streams_channel ON cs_streams (channel_id);
   CREATE TABLE IF NOT EXISTS cs_links (
     id text PRIMARY KEY, installation_id text NOT NULL, item_id text NOT NULL, stream_id text NOT NULL,
     event_id text NOT NULL, master_id text, ical_uid text, data jsonb NOT NULL, UNIQUE (stream_id, event_id));
   CREATE INDEX IF NOT EXISTS cs_links_item ON cs_links (installation_id, item_id);
   CREATE INDEX IF NOT EXISTS cs_links_master ON cs_links (stream_id, master_id);
   CREATE INDEX IF NOT EXISTS cs_links_ical ON cs_links (installation_id, ical_uid);
   CREATE TABLE IF NOT EXISTS cs_log (
     id bigserial PRIMARY KEY, installation_id text NOT NULL, at timestamptz NOT NULL, level text NOT NULL,
     message text NOT NULL);
   CREATE INDEX IF NOT EXISTS cs_log_inst ON cs_log (installation_id, id DESC);`,
];

/** Its own database is created on first start when the server's user may (the compose setup's Postgres user can). */
const ensureDatabase = async (databaseUrl: string) => {
  const probe = new pg.Client({ connectionString: databaseUrl });
  try {
    await probe.connect();
    await probe.end();
    return;
  } catch (e) {
    await probe.end().catch(() => undefined);
    if ((e as { code?: string }).code !== '3D000') throw e; // anything but "database does not exist"
  }
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(name)) throw new Error(`calendar-sync: bad database name ${name}`);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    console.warn(`calendar-sync: created database ${name}`);
  } finally {
    await admin.end();
  }
};

export const pgStore = async (databaseUrl: string): Promise<Store> => {
  await ensureDatabase(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  await pool.query(
    'CREATE TABLE IF NOT EXISTS cs_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL)',
  );
  const done = new Set(
    (await pool.query<{ version: number }>('SELECT version FROM cs_migrations')).rows.map((r) => r.version),
  );
  for (const [i, sql] of MIGRATIONS.entries()) {
    if (done.has(i + 1)) continue;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO cs_migrations (version, applied_at) VALUES ($1, now())', [i + 1]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const rows = async <T>(sql: string, args: unknown[] = []) =>
    (await pool.query<{ data: T }>(sql, args)).rows.map((r) => r.data);
  const one = async <T>(sql: string, args: unknown[] = []) => (await rows<T>(sql, args))[0] ?? null;
  // A config saved by an older version gets the settings added since (as their defaults).
  const readInstallation = (r: InstallationRow | null) => (r ? { ...r, config: withDefaults(r.config) } : r);

  return {
    getInstallation: async (id) =>
      readInstallation(await one<InstallationRow>('SELECT data FROM cs_installations WHERE id = $1', [id])),
    listInstallations: async () =>
      (await rows<InstallationRow>('SELECT data FROM cs_installations')).map((r) => readInstallation(r)!),
    putInstallation: async (r) => {
      await pool.query(
        'INSERT INTO cs_installations (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
        [r.id, r],
      );
    },
    deleteInstallation: async (id) => {
      for (const t of ['cs_links', 'cs_streams', 'cs_connections', 'cs_log'])
        await pool.query(`DELETE FROM ${t} WHERE installation_id = $1`, [id]);
      await pool.query('DELETE FROM cs_installations WHERE id = $1', [id]);
    },
    listConnections: (i) => rows<ConnectionRow>('SELECT data FROM cs_connections WHERE installation_id = $1', [i]),
    getConnection: (i, u) =>
      one<ConnectionRow>('SELECT data FROM cs_connections WHERE installation_id = $1 AND user_id = $2', [i, u]),
    putConnection: async (r) => {
      await pool.query(
        `INSERT INTO cs_connections (id, installation_id, user_id, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [r.id, r.installation_id, r.user_id, r],
      );
    },
    deleteConnection: async (id) => {
      await pool.query('DELETE FROM cs_connections WHERE id = $1', [id]);
    },
    listStreams: (i) => rows<StreamRow>('SELECT data FROM cs_streams WHERE installation_id = $1', [i]),
    getStream: (id) => one<StreamRow>('SELECT data FROM cs_streams WHERE id = $1', [id]),
    streamByChannel: (c) => one<StreamRow>('SELECT data FROM cs_streams WHERE channel_id = $1', [c]),
    putStream: async (r) => {
      await pool.query(
        `INSERT INTO cs_streams (id, installation_id, channel_id, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, data = EXCLUDED.data`,
        [r.id, r.installation_id, r.channel?.id ?? null, r],
      );
    },
    deleteStream: async (id) => {
      await pool.query('DELETE FROM cs_links WHERE stream_id = $1', [id]);
      await pool.query('DELETE FROM cs_streams WHERE id = $1', [id]);
    },
    linksForItem: (i, item) =>
      rows<LinkRow>('SELECT data FROM cs_links WHERE installation_id = $1 AND item_id = $2', [i, item]),
    linkForEvent: (s, e) => one<LinkRow>('SELECT data FROM cs_links WHERE stream_id = $1 AND event_id = $2', [s, e]),
    linksForMaster: (s, m) =>
      rows<LinkRow>('SELECT data FROM cs_links WHERE stream_id = $1 AND master_id = $2', [s, m]),
    linkByIcal: (i, u) =>
      one<LinkRow>('SELECT data FROM cs_links WHERE installation_id = $1 AND ical_uid = $2 LIMIT 1', [i, u]),
    listLinks: (i) => rows<LinkRow>('SELECT data FROM cs_links WHERE installation_id = $1', [i]),
    putLink: async (r) => {
      await pool.query(
        `INSERT INTO cs_links (id, installation_id, item_id, stream_id, event_id, master_id, ical_uid, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET item_id = EXCLUDED.item_id, data = EXCLUDED.data`,
        [r.id, r.installation_id, r.item_id, r.stream_id, r.event_id, r.master_id, r.ical_uid, r],
      );
    },
    deleteLink: async (id) => {
      await pool.query('DELETE FROM cs_links WHERE id = $1', [id]);
    },
    addLog: async (r) => {
      await pool.query('INSERT INTO cs_log (installation_id, at, level, message) VALUES ($1, $2, $3, $4)', [
        r.installation_id,
        r.at,
        r.level,
        r.message.slice(0, 1000),
      ]);
      // Keep the last 200 lines per installation.
      await pool.query(
        `DELETE FROM cs_log WHERE installation_id = $1 AND id < (
           SELECT min(id) FROM (SELECT id FROM cs_log WHERE installation_id = $1 ORDER BY id DESC LIMIT 200) k)`,
        [r.installation_id],
      );
    },
    recentLog: async (i, n) =>
      (
        await pool.query<{ at: Date; level: LogRow['level']; message: string }>(
          'SELECT at, level, message FROM cs_log WHERE installation_id = $1 ORDER BY id DESC LIMIT $2',
          [i, n],
        )
      ).rows.map((r) => ({ installation_id: i, at: new Date(r.at).toISOString(), level: r.level, message: r.message })),
    close: () => pool.end(),
  };
};
