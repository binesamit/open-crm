// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What the server keeps. Secrets in these rows are already encrypted (`*_enc`, crypto.ts). Two implementations:
 * Postgres (store-pg.ts, production) and in memory (tests, a quick local run without a database).
 */
import type { SyncConfig } from './config';

export type InstallationRow = {
  id: string;
  account_id: string;
  status: string;
  /** ServerCredentials as JSON, encrypted. */
  credentials_enc: string;
  service_user_id: string | null;
  config: SyncConfig | null;
  /** The account's own Google OAuth client (overrides the server's default). */
  google_client: { client_id: string; secret_enc: string; hint: string } | null;
  /** The webhooks this server made on the board, and the secret that signs them. */
  hooks: { board_id: string; ids: string[]; secret_enc: string } | null;
  last_sync_at: string | null;
  created_at: string;
};

export type ConnectionRow = {
  id: string;
  installation_id: string;
  /** The Bines member (from /ext/introspect). */
  user_id: string;
  user_name: string;
  user_email: string;
  /** `google` or `caldav` (which provider the sync uses for this member's calendars). */
  provider: string;
  account_email: string;
  /** The provider's secret, encrypted: Google, the refresh token; CalDAV, the account as JSON (`CaldavAccount`). */
  refresh_token_enc: string;
  status: 'ok' | 'error';
  error: string | null;
  created_at: string;
  /** The member's own choices on "My calendar" (none yet = their main calendar, nothing imported). */
  prefs?: MemberPrefs | null;
};

export type ImportMode = 'none' | 'new' | 'existing';

/** Which of their calendars a member syncs, and what of it comes into the board. */
export type MemberPrefs = {
  calendar_id: string;
  calendar_name: string | null;
  import: ImportMode;
  /** `existing`: how many days back. */
  days: number;
  /** `new`: meetings made from this moment (ISO). */
  since: string;
};

/** One calendar the sync reads and writes, through one connection. */
export type StreamRow = {
  id: string;
  installation_id: string;
  connection_id: string;
  calendar_id: string;
  role: 'personal' | 'shared';
  sync_token: string | null;
  channel: { id: string; resource_id: string; expires_at: string } | null;
  last_sync_at: string | null;
  last_error: string | null;
  recurring_refreshed_at: string | null;
};

/** An item ↔ one event in one calendar. */
export type LinkRow = {
  id: string;
  installation_id: string;
  item_id: string;
  stream_id: string;
  event_id: string;
  master_id: string | null;
  ical_uid: string | null;
  /** An invitation this calendar may not change (its organizer's copy carries the changes). */
  readonly: boolean;
  attendees: string[];
  /** Fingerprints of what was last synced on each side (loop protection, mapping.hashEvent). */
  bines_hash: string | null;
  google_hash: string | null;
  /** The guests' last answers (email → status) and the label they last set (RSVP). */
  responses: Record<string, string>;
  rsvp_label: string | null;
  updated_at: string;
};

export type LogRow = { installation_id: string; at: string; level: 'info' | 'error'; message: string };

export interface Store {
  getInstallation(id: string): Promise<InstallationRow | null>;
  listInstallations(): Promise<InstallationRow[]>;
  putInstallation(row: InstallationRow): Promise<void>;
  /** With everything that belongs to it. */
  deleteInstallation(id: string): Promise<void>;

  listConnections(installationId: string): Promise<ConnectionRow[]>;
  getConnection(installationId: string, userId: string): Promise<ConnectionRow | null>;
  putConnection(row: ConnectionRow): Promise<void>;
  deleteConnection(id: string): Promise<void>;

  listStreams(installationId: string): Promise<StreamRow[]>;
  getStream(id: string): Promise<StreamRow | null>;
  streamByChannel(channelId: string): Promise<StreamRow | null>;
  putStream(row: StreamRow): Promise<void>;
  /** With its links. */
  deleteStream(id: string): Promise<void>;

  linksForItem(installationId: string, itemId: string): Promise<LinkRow[]>;
  linkForEvent(streamId: string, eventId: string): Promise<LinkRow | null>;
  linksForMaster(streamId: string, masterId: string): Promise<LinkRow[]>;
  linkByIcal(installationId: string, icalUid: string): Promise<LinkRow | null>;
  listLinks(installationId: string): Promise<LinkRow[]>;
  putLink(row: LinkRow): Promise<void>;
  deleteLink(id: string): Promise<void>;

  addLog(row: LogRow): Promise<void>;
  recentLog(installationId: string, limit: number): Promise<LogRow[]>;
  close(): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

export const memoryStore = (): Store => {
  const inst = new Map<string, InstallationRow>();
  const conns = new Map<string, ConnectionRow>();
  const streams = new Map<string, StreamRow>();
  const links = new Map<string, LinkRow>();
  let log: LogRow[] = [];
  const all = <T>(m: Map<string, T>, f: (r: T) => boolean) => [...m.values()].filter(f).map(clone);
  return {
    getInstallation: async (id) => clone(inst.get(id) ?? null),
    listInstallations: async () => [...inst.values()].map(clone),
    putInstallation: async (r) => void inst.set(r.id, clone(r)),
    deleteInstallation: async (id) => {
      inst.delete(id);
      for (const m of [conns, streams, links] as Map<string, { installation_id: string }>[])
        for (const [k, v] of m) if (v.installation_id === id) m.delete(k);
      log = log.filter((l) => l.installation_id !== id);
    },
    listConnections: async (i) => all(conns, (c) => c.installation_id === i),
    getConnection: async (i, u) => all(conns, (c) => c.installation_id === i && c.user_id === u)[0] ?? null,
    putConnection: async (r) => void conns.set(r.id, clone(r)),
    deleteConnection: async (id) => void conns.delete(id),
    listStreams: async (i) => all(streams, (s) => s.installation_id === i),
    getStream: async (id) => clone(streams.get(id) ?? null),
    streamByChannel: async (c) => all(streams, (s) => s.channel?.id === c)[0] ?? null,
    putStream: async (r) => void streams.set(r.id, clone(r)),
    deleteStream: async (id) => {
      streams.delete(id);
      for (const [k, v] of links) if (v.stream_id === id) links.delete(k);
    },
    linksForItem: async (i, item) => all(links, (l) => l.installation_id === i && l.item_id === item),
    linkForEvent: async (s, e) => all(links, (l) => l.stream_id === s && l.event_id === e)[0] ?? null,
    linksForMaster: async (s, m) => all(links, (l) => l.stream_id === s && l.master_id === m),
    linkByIcal: async (i, u) => all(links, (l) => l.installation_id === i && l.ical_uid === u)[0] ?? null,
    listLinks: async (i) => all(links, (l) => l.installation_id === i),
    putLink: async (r) => void links.set(r.id, clone(r)),
    deleteLink: async (id) => void links.delete(id),
    addLog: async (r) => {
      log.push(clone(r));
      if (log.length > 2000) log = log.slice(-1000);
    },
    recentLog: async (i, n) =>
      log
        .filter((l) => l.installation_id === i)
        .slice(-n)
        .reverse()
        .map(clone),
    close: async () => undefined,
  };
};
