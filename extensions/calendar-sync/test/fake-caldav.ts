// SPDX-License-Identifier: AGPL-3.0-only
/**
 * An in-memory CalDAV server behind a `fetch`: Basic auth, discovery (well-known → principal → home → calendars),
 * PROPFIND (ctag, etags), REPORT (sync-collection, calendar-multiget with a simple DAILY expand), GET, PUT and DELETE
 * with If-Match / If-None-Match. Requests are recorded.
 */
import { caldavProvider } from '../src/caldav';
import type { CaldavAccount, ProviderAuth } from '../src/provider';
import { memoryStore, type ConnectionRow, type InstallationRow } from '../src/store';
import { createEngine } from '../src/sync';
import { ALL_IN, config, fakeBines } from './fakes';

export const DAV_ORIGIN = 'https://dav.test';
export const DAV_USER = 'ann@dav.test';
export const DAV_PASS = 'app-pass-1234';
export const WORK = '/dav/calendars/ann/work/';

type Res = { body: string; etag: string };
type Cal = { name: string; comps: string[]; events: Map<string, Res>; log: string[] };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ms = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${inner}</d:multistatus>`;
const ok = (href: string, props: string, missing = '') =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${
    missing ? `<d:propstat><d:prop>${missing}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : ''
  }</d:response>`;
const gone = (href: string) =>
  `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;

/** A VCALENDAR with one VEVENT (lines given as they go in the file). */
export const ics = (...lines: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

/** A naive DAILY;COUNT=n expansion (enough for the tests). */
const expand = (body: string, start: string, end: string) => {
  const lines = body.split('\r\n');
  const ev = lines.slice(lines.indexOf('BEGIN:VEVENT') + 1, lines.indexOf('END:VEVENT'));
  const get = (n: string) => ev.find((l) => l.startsWith(`${n}:`))?.slice(n.length + 1);
  const rule = get('RRULE');
  const count = Number(/COUNT=(\d+)/.exec(rule ?? '')?.[1] ?? 0);
  if (!rule || !/FREQ=DAILY/.test(rule)) return body;
  const p = (s: string) => Date.parse(s.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
  const f = (t: number) => `${new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const s0 = p(get('DTSTART')!);
  const len = p(get('DTEND')!) - s0;
  const rest = ev.filter((l) => !/^(RRULE|DTSTART|DTEND|EXDATE)[:;]/.test(l));
  const ex = ev.filter((l) => l.startsWith('EXDATE')).map((l) => l.split(':')[1]);
  const out: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  for (let i = 0; i < count; i++) {
    const t = s0 + i * 86_400_000;
    if (t < p(start) || t >= p(end) || ex.includes(f(t))) continue;
    out.push('BEGIN:VEVENT', ...rest, `RECURRENCE-ID:${f(t)}`, `DTSTART:${f(t)}`, `DTEND:${f(t + len)}`, 'END:VEVENT');
  }
  out.push('END:VCALENDAR', '');
  return out.join('\r\n');
};

export const fakeCaldav = (opts: { syncCollection?: boolean } = {}) => {
  const sync = opts.syncCollection !== false;
  const cals = new Map<string, Cal>([
    [WORK, { name: 'Work', comps: ['VEVENT'], events: new Map(), log: [] }],
    ['/dav/calendars/ann/tasks/', { name: 'Tasks', comps: ['VTODO'], events: new Map(), log: [] }],
  ]);
  const requests: { method: string; path: string; body: string; headers: Record<string, string> }[] = [];
  let etagSeq = 0;
  let password = DAV_PASS;
  const calOf = (path: string) => cals.get(path.slice(0, path.lastIndexOf('/') + 1));

  const write = (path: string, body: string) => {
    const c = calOf(path)!;
    const r = { body, etag: `"e${++etagSeq}"` };
    c.events.set(path, r);
    c.log.push(path);
    return r;
  };
  const remove = (path: string) => {
    const c = calOf(path)!;
    c.events.delete(path);
    c.log.push(path);
  };

  const handler = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = typeof init.body === 'string' ? init.body : '';
    requests.push({ method, path: u.pathname, body, headers });
    if (u.origin !== DAV_ORIGIN) return new Response(null, { status: 404 });
    const want = `Basic ${Buffer.from(`${DAV_USER}:${password}`).toString('base64')}`;
    if (headers.authorization !== want) return new Response('no', { status: 401 });
    const path = u.pathname;
    const xml = (s: string) => new Response(ms(s), { status: 207, headers: { 'content-type': 'application/xml' } });
    const cal = cals.get(path);

    if (method === 'PROPFIND') {
      if (path === '/.well-known/caldav') return new Response(null, { status: 301, headers: { location: '/dav/' } });
      if (path === '/dav/')
        return xml(
          ok(path, '<d:current-user-principal><d:href>/dav/principals/ann/</d:href></d:current-user-principal>'),
        );
      if (path === '/dav/principals/ann/')
        return xml(
          ok(
            path,
            '<c:calendar-home-set><d:href>/dav/calendars/ann/</d:href></c:calendar-home-set>' +
              '<c:calendar-user-address-set><d:href>mailto:ann@dav.test</d:href><d:href>/dav/principals/ann/</d:href></c:calendar-user-address-set>',
            '<c:schedule-default-calendar-URL/>',
          ),
        );
      if (path === '/dav/calendars/ann/')
        return xml(
          ok(path, '<d:resourcetype><d:collection/></d:resourcetype>') +
            [...cals]
              .map(([p, c]) =>
                ok(
                  p,
                  `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${c.name}</d:displayname>` +
                    `<c:supported-calendar-component-set>${c.comps.map((x) => `<c:comp name="${x}"/>`).join('')}</c:supported-calendar-component-set>` +
                    '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>',
                ),
              )
              .join(''),
        );
      if (cal && headers.depth === '0')
        return xml(
          ok(
            path,
            `<cs:getctag>c${cal.log.length}</cs:getctag>` +
              (sync
                ? `<d:sync-token>${DAV_ORIGIN}/sync/${cal.log.length}</d:sync-token><d:supported-report-set><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set>`
                : ''),
            sync ? '' : '<d:sync-token/>',
          ),
        );
      if (cal)
        return xml(
          ok(path, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>') +
            [...cal.events].map(([p, r]) => ok(p, `<d:getetag>${r.etag}</d:getetag><d:resourcetype/>`)).join(''),
        );
      return new Response(null, { status: 404 });
    }

    if (method === 'REPORT' && cal) {
      if (body.includes('sync-collection')) {
        if (!sync) return new Response('<d:error xmlns:d="DAV:"><d:supported-report/></d:error>', { status: 403 });
        const token = /<d:sync-token>(.*?)<\/d:sync-token>/.exec(body)?.[1] ?? '';
        const m = /\/sync\/(\d+)$/.exec(token);
        if (token && (!m || Number(m[1]) > cal.log.length))
          return new Response('<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>', { status: 403 });
        const from = token ? Number(m![1]) : 0;
        const paths = token ? [...new Set(cal.log.slice(from))] : [...cal.events.keys()];
        return xml(
          paths
            .map((p) => (cal.events.has(p) ? ok(p, `<d:getetag>${cal.events.get(p)!.etag}</d:getetag>`) : gone(p)))
            .join('') + `<d:sync-token>${DAV_ORIGIN}/sync/${cal.log.length}</d:sync-token>`,
        );
      }
      if (body.includes('calendar-multiget')) {
        const hrefs = [...body.matchAll(/<d:href>(.*?)<\/d:href>/g)].map((x) => x[1]!);
        const ex = /<c:expand start="([^"]+)" end="([^"]+)"/.exec(body);
        return xml(
          hrefs
            .map((h) => {
              const r = cal.events.get(h);
              if (!r) return gone(h);
              const data = ex ? expand(r.body, ex[1]!, ex[2]!) : r.body;
              return ok(h, `<d:getetag>${r.etag}</d:getetag><c:calendar-data>${esc(data)}</c:calendar-data>`);
            })
            .join(''),
        );
      }
    }

    const c = calOf(path);
    if (c && method === 'GET') {
      const r = c.events.get(path);
      return r
        ? new Response(r.body, { status: 200, headers: { etag: r.etag, 'content-type': 'text/calendar' } })
        : new Response(null, { status: 404 });
    }
    if (c && method === 'PUT') {
      const cur = c.events.get(path);
      if (headers['if-none-match'] === '*' && cur) return new Response(null, { status: 412 });
      if (headers['if-match'] && headers['if-match'] !== cur?.etag) return new Response(null, { status: 412 });
      const r = write(path, body);
      return new Response(null, { status: cur ? 204 : 201, headers: { etag: r.etag } });
    }
    if (c && method === 'DELETE') {
      const cur = c.events.get(path);
      if (!cur) return new Response(null, { status: 404 });
      if (headers['if-match'] && headers['if-match'] !== cur.etag) return new Response(null, { status: 412 });
      remove(path);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };

  const doFetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
  return {
    fetch: doFetch,
    cals,
    requests,
    /** A change made by someone else (another calendar app). */
    put: (path: string, body: string) => write(path, body),
    remove,
    setPassword: (p: string) => (password = p),
    events: (cal = WORK) => cals.get(cal)!.events,
  };
};

/** An installation with Ann connected over CalDAV (her own calendar = Work) and the engine. */
export const setupCaldav = async (over: Record<string, unknown> = {}, davOpts: { syncCollection?: boolean } = {}) => {
  let clock = Date.parse('2026-11-03T08:00:00Z');
  const now = () => clock;
  const tick = (n = 60_000) => (clock += n);
  const dav = fakeCaldav(davOpts);
  const provider = caldavProvider(dav.fetch);
  const found = await provider.discover({ url: DAV_ORIGIN, username: DAV_USER, password: DAV_PASS });
  const { calendars: _c, ...account } = found;
  const store = memoryStore();
  const b = fakeBines(now);
  const inst: InstallationRow = {
    id: 'inst1',
    account_id: 'acc',
    status: 'active',
    credentials_enc: '',
    service_user_id: 'svc',
    config: config(over),
    google_client: null,
    hooks: null,
    last_sync_at: null,
    created_at: new Date(clock).toISOString(),
  };
  await store.putInstallation(inst);
  const conn: ConnectionRow = {
    id: 'c1',
    installation_id: inst.id,
    user_id: 'u1',
    user_name: 'Ann',
    user_email: 'ann@x.test',
    provider: 'caldav',
    account_email: account.email ?? DAV_USER,
    refresh_token_enc: '',
    prefs: ALL_IN,
    status: 'ok',
    error: null,
    created_at: new Date(clock).toISOString(),
  };
  await store.putConnection(conn);
  const engine = createEngine({
    store,
    providers: { caldav: provider },
    bines: () => b.api,
    authFor: async (): Promise<ProviderAuth> => ({ caldav: account as CaldavAccount }),
    now,
  });
  await engine.ensureStreams(inst.id);
  const stream = (await store.listStreams(inst.id))[0]!;
  return { dav, provider, account, store, b, engine, inst, stream, tick, now };
};
