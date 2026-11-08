// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CalDAV (RFC 4791) as a `CalendarProvider`, over `fetch` with Basic authentication (the member's user name and an
 * app password): any CalDAV server — iCloud, Fastmail, Nextcloud, Radicale, …
 *
 * - Discovery: the address (or its `/.well-known/caldav`) → current-user-principal → calendar-home-set → the
 *   calendars (PROPFIND). The member's own calendar (`primary`) is the server's schedule-default-calendar-URL, else
 *   the first writable calendar with events.
 * - Changes: the sync-collection REPORT (RFC 6578, a sync token) where the calendar has it; else the ctag (a
 *   calendar's change tag) and each event's etag, compared with the last read. Changed events are read with
 *   calendar-multiget. Our sync token says which way: `sync:<token>` or `etag:<ctag and etags, deflated>`.
 * - Writes: PUT (If-None-Match for a new event, If-Match with the etag just read for a change, so another writer's
 *   change is never overwritten) and DELETE (If-Match). An instance of a series is an override in its resource;
 *   deleting one adds an EXDATE.
 * - No push: the periodic pull reads every calendar (SYNC_INTERVAL_MINUTES).
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { randomId } from './crypto';
import {
  eventsOfResource,
  excludeInstanceIcal,
  cancelledEvent,
  instancesOfResource,
  newEventIcal,
  overrideOfResource,
  splitInstanceId,
  updateEventIcal,
  utcStamp,
} from './ical';
import {
  SyncTokenGone,
  type CalendarProvider,
  type CaldavAccount,
  type ProviderAuth,
  type ProviderCalendar,
  type ProviderEvent,
} from './provider';
import { CALDAV, CS, DAV, child, children, descendant, descendants, escapeXml, parseXml, type XmlEl } from './xml';

/** What went wrong, as a code the connect page shows (`caldav_<code>`). */
export type CaldavCode = 'bad_url' | 'auth' | 'unreachable' | 'not_caldav' | 'no_calendars' | 'http';

export class CaldavError extends Error {
  readonly status: number;
  readonly code: CaldavCode;
  constructor(code: CaldavCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type CaldavInput = { url: string; username: string; password: string };

/** Which addresses the server may be asked to reach (no plain http in production, no private hosts). */
export type UrlPolicy = { allowHttp?: boolean; allowPrivate?: boolean };

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[::1?\]|\[f[cd][0-9a-f:]*\]|\[fe80:[0-9a-f:]*\])$/i;

export const checkUrl = (raw: string, policy: UrlPolicy = {}): URL => {
  let u: URL;
  try {
    u = new URL(raw.trim().includes('://') ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new CaldavError('bad_url', 0, 'not an address');
  }
  if (u.protocol !== 'https:' && !(policy.allowHttp && u.protocol === 'http:'))
    throw new CaldavError('bad_url', 0, 'https only');
  if (u.username || u.password) throw new CaldavError('bad_url', 0, 'no credentials in the address');
  if (!policy.allowPrivate && PRIVATE_HOST.test(u.hostname)) throw new CaldavError('bad_url', 0, 'private address');
  u.hash = '';
  return u;
};

// -------------------------------------------------------------------------------------------------------------
// HTTP
// -------------------------------------------------------------------------------------------------------------

type Creds = Pick<CaldavAccount, 'username' | 'password'>;
type Req = { depth?: '0' | '1'; body?: string; headers?: Record<string, string>; contentType?: string };

const basic = (c: Creds) => `Basic ${Buffer.from(`${c.username}:${c.password}`, 'utf8').toString('base64')}`;

const PROPS_NS = `xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:cs="${CS}"`;
const propfind = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind ${PROPS_NS}><d:prop>${props}</d:prop></d:propfind>`;

type DavResponse = { href: string; status: number; props: Map<string, XmlEl>; ok: Set<string> };

/** A multistatus answer: each response's href (absolute), its status, and the props found (`ns|name`). */
const multistatus = (xml: string, base: string): DavResponse[] => {
  const root = parseXml(xml);
  return children(root, DAV, 'response').map((r) => {
    const href = new URL(child(r, DAV, 'href')?.text.trim() ?? '', base).toString();
    const statusOf = (el: XmlEl | undefined) => Number(/\s(\d{3})\s?/.exec(el?.text ?? '')?.[1] ?? 0);
    const props = new Map<string, XmlEl>();
    const ok = new Set<string>();
    for (const ps of children(r, DAV, 'propstat')) {
      const st = statusOf(child(ps, DAV, 'status'));
      for (const p of child(ps, DAV, 'prop')?.children ?? []) {
        const k = `${p.ns}|${p.name}`;
        if (st >= 200 && st < 300) {
          props.set(k, p);
          ok.add(k);
        }
      }
    }
    return { href, status: statusOf(child(r, DAV, 'status')) || 200, props, ok };
  });
};

const hrefIn = (el: XmlEl | undefined, base: string) => {
  const h = descendant(el, DAV, 'href')?.text.trim();
  return h ? new URL(h, base).toString() : null;
};

/** The path of an absolute URL (events are known by it). */
const pathOf = (url: string) => new URL(url).pathname;
const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

export const caldavProvider = (doFetch: typeof fetch = fetch, policy: UrlPolicy = {}) => {
  /** One request; redirects are followed by hand (the credentials only go to addresses the policy allows). */
  const send = async (creds: Creds, method: string, url: string, req: Req = {}): Promise<Response> => {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      checkUrl(target, policy);
      let res: Response;
      try {
        res = await doFetch(target, {
          method,
          redirect: 'manual',
          headers: {
            authorization: basic(creds),
            ...(req.depth ? { depth: req.depth } : {}),
            ...(req.body !== undefined ? { 'content-type': req.contentType ?? 'application/xml; charset=utf-8' } : {}),
            ...req.headers,
          },
          body: req.body,
        });
      } catch (e) {
        throw new CaldavError('unreachable', 0, `${method} ${new URL(target).host}: ${(e as Error).message}`);
      }
      const loc = res.headers.get('location');
      if ([301, 302, 307, 308].includes(res.status) && loc) {
        target = new URL(loc, target).toString();
        continue;
      }
      return res;
    }
    throw new CaldavError('unreachable', 0, 'too many redirects');
  };

  const fail = async (res: Response, what: string): Promise<never> => {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new CaldavError('auth', 401, `${what}: the server refused the user name or password`);
    throw new CaldavError(
      'http',
      res.status,
      `${what}: ${res.status}${body.includes('valid-sync-token') ? ' valid-sync-token' : ''}`,
    );
  };

  const dav = async (creds: Creds, method: string, url: string, req: Req, what: string) => {
    const res = await send(creds, method, url, req);
    if (res.status !== 207) return fail(res, what);
    return multistatus(await res.text(), url);
  };

  const account = (auth: ProviderAuth): CaldavAccount => {
    if (!auth.caldav) throw new Error('not a CalDAV connection');
    return auth.caldav;
  };
  const calUrl = (a: CaldavAccount, calendarId: string) => withSlash(calendarId === 'primary' ? a.primary : calendarId);
  const eventUrl = (calendar: string, path: string) => new URL(path, calendar).toString();

  // ---- calendars ------------------------------------------------------------------------------------------

  const listCalendarsAt = async (creds: Creds, home: string, primary: string | null): Promise<ProviderCalendar[]> => {
    const rs = await dav(
      creds,
      'PROPFIND',
      home,
      {
        depth: '1',
        body: propfind(
          '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/>',
        ),
      },
      'calendars',
    );
    const out: ProviderCalendar[] = [];
    for (const r of rs) {
      if (!child(r.props.get(`${DAV}|resourcetype`), CALDAV, 'calendar')) continue;
      const comps = r.props.get(`${CALDAV}|supported-calendar-component-set`);
      if (comps && !children(comps, CALDAV, 'comp').some((c) => (c.attrs.name ?? '').toUpperCase() === 'VEVENT'))
        continue;
      const privs = r.props.get(`${DAV}|current-user-privilege-set`);
      const writable =
        !privs || ['all', 'write', 'write-content', 'bind'].some((p) => descendants(privs, DAV, p).length > 0);
      const id = withSlash(r.href);
      out.push({
        id,
        name:
          r.props.get(`${DAV}|displayname`)?.text.trim() ||
          decodeURIComponent(pathOf(id).split('/').filter(Boolean).pop() ?? id),
        primary: id === primary,
        writable,
      });
    }
    return out;
  };

  /** Finds the account's calendars from the address the member typed. */
  const discover = async (input: CaldavInput): Promise<CaldavAccount & { calendars: ProviderCalendar[] }> => {
    const start = checkUrl(input.url, policy);
    const creds = { username: input.username, password: input.password };
    const wellKnown = new URL('/.well-known/caldav', start).toString();
    const candidates = start.pathname === '/' ? [wellKnown, start.toString()] : [start.toString(), wellKnown];
    let principal: string | null = null;
    let home: string | null = null;
    for (const url of candidates) {
      const res = await send(creds, 'PROPFIND', url, {
        depth: '0',
        body: propfind('<d:current-user-principal/><d:resourcetype/><c:calendar-home-set/>'),
      });
      if (res.status === 401) await fail(res, 'discovery');
      if (res.status !== 207) continue;
      let rs: DavResponse[];
      try {
        rs = multistatus(await res.text(), url);
      } catch {
        continue;
      }
      const r = rs[0];
      if (!r) continue;
      home = hrefIn(r.props.get(`${CALDAV}|calendar-home-set`), url);
      principal = hrefIn(r.props.get(`${DAV}|current-user-principal`), url);
      if (!principal && child(r.props.get(`${DAV}|resourcetype`), DAV, 'principal')) principal = url;
      if (principal || home) break;
    }
    if (!principal && !home) throw new CaldavError('not_caldav', 0, 'no CalDAV principal at this address');
    let email: string | null = null;
    let defaultCal: string | null = null;
    if (principal) {
      const [p] = await dav(
        creds,
        'PROPFIND',
        principal,
        {
          depth: '0',
          body: propfind('<c:calendar-home-set/><c:calendar-user-address-set/><c:schedule-default-calendar-URL/>'),
        },
        'principal',
      );
      home = hrefIn(p?.props.get(`${CALDAV}|calendar-home-set`), principal) ?? home;
      const addresses = descendants(p?.props.get(`${CALDAV}|calendar-user-address-set`), DAV, 'href').map((h) =>
        h.text.trim(),
      );
      const mail = addresses.find((a) => /^mailto:/i.test(a));
      email = mail ? mail.replace(/^mailto:/i, '').toLowerCase() : null;
      const d = hrefIn(p?.props.get(`${CALDAV}|schedule-default-calendar-URL`), principal);
      defaultCal = d ? withSlash(d) : null;
    }
    if (!home) throw new CaldavError('not_caldav', 0, 'no calendar home');
    const calendars = await listCalendarsAt(creds, withSlash(home), defaultCal);
    const writable = calendars.filter((c) => c.writable);
    const primary = writable.find((c) => c.id === defaultCal)?.id ?? writable[0]?.id;
    if (!primary) throw new CaldavError('no_calendars', 0, 'no calendar with events that may be written');
    return {
      home: withSlash(home),
      primary,
      email: email ?? (input.username.includes('@') ? input.username.toLowerCase() : null),
      username: input.username,
      password: input.password,
      calendars: calendars.map((c) => ({ ...c, primary: c.id === primary })),
    };
  };

  // ---- reading events -------------------------------------------------------------------------------------

  /** The calendar data of some events (calendar-multiget, in batches). */
  const multiget = async (creds: Creds, calendar: string, paths: string[], expand?: { start: string; end: string }) => {
    const out = new Map<string, { etag: string | null; body: string }>();
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const data = expand
        ? `<c:calendar-data><c:expand start="${utcStamp(expand.start)}" end="${utcStamp(expand.end)}"/></c:calendar-data>`
        : '<c:calendar-data/>';
      const rs = await dav(
        creds,
        'REPORT',
        calendar,
        {
          depth: '1',
          body: `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget ${PROPS_NS}><d:prop><d:getetag/>${data}</d:prop>${batch
            .map((p) => `<d:href>${escapeXml(p)}</d:href>`)
            .join('')}</c:calendar-multiget>`,
        },
        'multiget',
      );
      for (const r of rs) {
        const body = r.props.get(`${CALDAV}|calendar-data`)?.text;
        if (r.status === 200 && body)
          out.set(pathOf(r.href), { etag: r.props.get(`${DAV}|getetag`)?.text.trim() ?? null, body });
      }
    }
    return out;
  };

  const readEvents = async (a: CaldavAccount, calendar: string, paths: string[]) => {
    const got = await multiget(a, calendar, paths);
    const events: ProviderEvent[] = [];
    for (const p of paths) {
      const r = got.get(p);
      // Listed as changed, then gone (or not an event): nothing; a deleted one is reported by the caller.
      if (r) events.push(...eventsOfResource(r.body, p, a.email));
    }
    return events;
  };

  type EtagState = { c: string | null; m: Record<string, string> };
  const packEtags = (s: EtagState) => `etag:${deflateRawSync(Buffer.from(JSON.stringify(s))).toString('base64url')}`;
  const unpackEtags = (t: string): EtagState => {
    try {
      return JSON.parse(inflateRawSync(Buffer.from(t.slice(5), 'base64url')).toString('utf8')) as EtagState;
    } catch {
      throw new SyncTokenGone('bad etag state');
    }
  };

  /** The fallback: the ctag says whether anything changed; each event's etag says what. */
  const changesByEtag = async (a: CaldavAccount, calendar: string, prev: EtagState | null, ctag: string | null) => {
    if (prev && ctag && prev.c === ctag) return { events: [], nextSyncToken: packEtags(prev) };
    const rs = await dav(
      a,
      'PROPFIND',
      calendar,
      { depth: '1', body: propfind('<d:getetag/><d:resourcetype/>') },
      'etags',
    );
    const m: Record<string, string> = {};
    for (const r of rs) {
      if (withSlash(r.href) === calendar || child(r.props.get(`${DAV}|resourcetype`), DAV, 'collection')) continue;
      const etag = r.props.get(`${DAV}|getetag`)?.text.trim();
      if (etag) m[pathOf(r.href)] = etag;
    }
    const changed = Object.keys(m).filter((p) => !prev || prev.m[p] !== m[p]);
    const gone = prev ? Object.keys(prev.m).filter((p) => !(p in m)) : [];
    const events = [...(await readEvents(a, calendar, changed)), ...gone.map((p) => cancelledEvent(p))];
    return { events, nextSyncToken: packEtags({ c: ctag, m }) };
  };

  /** RFC 6578: what changed since the token (all of it from an empty one), in as many rounds as the server wants. */
  const changesBySync = async (a: CaldavAccount, calendar: string, token: string) => {
    const changed = new Set<string>();
    const gone = new Set<string>();
    let cur = token;
    for (let round = 0; round < 50; round++) {
      const res = await send(a, 'REPORT', calendar, {
        depth: '0',
        body: `<?xml version="1.0" encoding="utf-8"?><d:sync-collection ${PROPS_NS}><d:sync-token>${escapeXml(cur)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
      });
      if (res.status !== 207) {
        const body = await res.text().catch(() => '');
        if (
          token &&
          (res.status === 410 || ((res.status === 403 || res.status === 409) && body.includes('valid-sync-token')))
        )
          throw new SyncTokenGone('sync token expired');
        if (res.status === 401)
          throw new CaldavError('auth', 401, 'changes: the server refused the user name or password');
        throw new CaldavError('http', res.status, `changes: ${res.status}`);
      }
      const xml = await res.text();
      const rs = multistatus(xml, calendar);
      let more = false;
      for (const r of rs) {
        if (withSlash(r.href) === calendar) {
          if (r.status === 507) more = true;
          continue;
        }
        const p = pathOf(r.href);
        if (r.status === 404 || r.status === 410) {
          gone.add(p);
          changed.delete(p);
        } else {
          changed.add(p);
          gone.delete(p);
        }
      }
      const next = descendant(parseXml(xml), DAV, 'sync-token')?.text.trim();
      if (!next) throw new CaldavError('http', 207, 'changes: no sync token');
      const advanced = next !== cur;
      cur = next;
      if (!more || !advanced) break;
    }
    const events = [...(await readEvents(a, calendar, [...changed])), ...[...gone].map((p) => cancelledEvent(p))];
    return { events, nextSyncToken: `sync:${cur}` };
  };

  /** The calendar's own state: its ctag, and whether it has sync-collection (its sync-token). */
  const calendarState = async (a: CaldavAccount, calendar: string) => {
    const [r] = await dav(
      a,
      'PROPFIND',
      calendar,
      { depth: '0', body: propfind('<cs:getctag/><d:sync-token/><d:supported-report-set/>') },
      'calendar',
    );
    const reports = descendants(r?.props.get(`${DAV}|supported-report-set`), DAV, 'sync-collection').length > 0;
    return {
      ctag: r?.props.get(`${CS}|getctag`)?.text.trim() || null,
      sync: reports || !!r?.ok.has(`${DAV}|sync-token`),
    };
  };

  /** The resource of an event and its etag (null when it is gone). */
  const getResource = async (a: CaldavAccount, url: string) => {
    const res = await send(a, 'GET', url, { headers: { accept: 'text/calendar' } });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) return fail(res, 'read event');
    return { etag: res.headers.get('etag'), body: await res.text() };
  };

  const put = async (a: CaldavAccount, url: string, body: string, cond: Record<string, string>) =>
    send(a, 'PUT', url, { body, contentType: 'text/calendar; charset=utf-8', headers: cond });

  /** The event as the server now has it (servers may add or change properties). */
  const readBack = async (a: CaldavAccount, url: string, id: string) => {
    const r = await getResource(a, url);
    if (!r) throw new CaldavError('http', 404, 'the event is gone after writing it');
    const { href, key } = splitInstanceId(id);
    const ev = key ? overrideOfResource(r.body, href, key, a.email) : eventsOfResource(r.body, href, a.email)[0];
    if (!ev) throw new CaldavError('http', 0, 'no event in the resource');
    return ev;
  };

  /** Read, change, write with If-Match; when someone else wrote in between (412), once more. */
  const rewrite = async (a: CaldavAccount, url: string, change: (body: string) => string | null) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await getResource(a, url);
      if (!cur) throw new CaldavError('http', 404, 'the event is gone');
      const next = change(cur.body);
      if (next === null) throw new CaldavError('http', 0, 'the event could not be changed');
      const res = await put(a, url, next, cur.etag ? { 'if-match': cur.etag } : {});
      if (res.status === 412) continue;
      if (!res.ok) return fail(res, 'write event');
      return;
    }
    throw new CaldavError('http', 412, 'the event kept changing');
  };

  const provider: CalendarProvider & { discover: typeof discover } = {
    name: 'caldav',
    discover,
    listCalendars: async (auth) => {
      const a = account(auth);
      return listCalendarsAt(a, a.home, a.primary);
    },
    listChanges: async (auth, calendarId, syncToken) => {
      const a = account(auth);
      const calendar = calUrl(a, calendarId);
      if (syncToken?.startsWith('sync:')) return changesBySync(a, calendar, syncToken.slice(5));
      const state = await calendarState(a, calendar);
      if (syncToken?.startsWith('etag:')) return changesByEtag(a, calendar, unpackEtags(syncToken), state.ctag);
      if (syncToken) throw new SyncTokenGone('unknown token');
      if (state.sync)
        try {
          return await changesBySync(a, calendar, '');
        } catch (e) {
          // Advertised but refused: the etags.
          if (!(e instanceof CaldavError) || e.code === 'auth') throw e;
        }
      return changesByEtag(a, calendar, null, state.ctag);
    },
    listInstances: async (auth, calendarId, eventId, timeMin, timeMax) => {
      const a = account(auth);
      const calendar = calUrl(a, calendarId);
      const got = await multiget(a, calendar, [eventId], { start: timeMin, end: timeMax });
      const r = got.get(eventId);
      if (!r) return [];
      // A server that does not expand sends the series as is: no instances (the master's own changes still sync).
      return instancesOfResource(r.body, eventId, a.email) ?? [];
    },
    insertEvent: async (auth, calendarId, data, opts) => {
      const a = account(auth);
      const calendar = calUrl(a, calendarId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const uid = `${randomId()}@bines`;
        const url = eventUrl(calendar, `${uid.replace('@', '-')}.ics`);
        const res = await put(a, url, newEventIcal(uid, data, opts, a.email), { 'if-none-match': '*' });
        if (res.status === 412) continue;
        if (!res.ok) return fail(res, 'create event');
        return readBack(a, url, pathOf(url));
      }
      throw new CaldavError('http', 412, 'could not create the event');
    },
    updateEvent: async (auth, calendarId, eventId, data, opts) => {
      const a = account(auth);
      const { href, key } = splitInstanceId(eventId);
      const url = eventUrl(calUrl(a, calendarId), href);
      await rewrite(a, url, (body) => updateEventIcal(body, key, data, opts, a.email));
      return readBack(a, url, eventId);
    },
    deleteEvent: async (auth, calendarId, eventId) => {
      const a = account(auth);
      const { href, key } = splitInstanceId(eventId);
      const url = eventUrl(calUrl(a, calendarId), href);
      if (key) {
        // One instance: the series stays, without it.
        const cur = await getResource(a, url);
        if (!cur) return;
        await rewrite(a, url, (body) => excludeInstanceIcal(body, key));
        return;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = await getResource(a, url);
        if (!cur) return;
        const res = await send(a, 'DELETE', url, { headers: cur.etag ? { 'if-match': cur.etag } : {} });
        if (res.status === 412) continue;
        if (res.ok || res.status === 404 || res.status === 410) return;
        return fail(res, 'delete event');
      }
      throw new CaldavError('http', 412, 'the event kept changing');
    },
  };
  return provider;
};
export type CaldavProvider = ReturnType<typeof caldavProvider>;
