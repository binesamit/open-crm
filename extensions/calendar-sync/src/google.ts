// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Google Calendar as a `CalendarProvider`, over Google's REST endpoints with `fetch` (no SDK), and Google OAuth
 * (authorization code, offline access) for each member's own account.
 */
import { addDays, type IsoDate } from '@bines/shared';
import {
  SyncTokenGone,
  type CalendarProvider,
  type EventData,
  type ProviderAuth,
  type ProviderEvent,
  type Rsvp,
  type When,
  type WriteOpts,
} from './provider';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const API = 'https://www.googleapis.com/calendar/v3';

export type GoogleClient = { client_id: string; client_secret: string };

export class GoogleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The consent screen's address for one member (the state ties the answer to them). */
export const authorizeUrl = (client: GoogleClient, redirectUri: string, state: string, loginHint?: string) => {
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${AUTH_URL}?${q.toString()}`;
};

type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

const tokenCall = async (doFetch: typeof fetch, body: Record<string, string>) => {
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenAnswer;
  if (!res.ok || !data.access_token) throw new GoogleError(res.status, `token: ${data.error ?? res.status}`);
  return data;
};

export const exchangeCode = async (client: GoogleClient, redirectUri: string, code: string, doFetch = fetch) => {
  const t = await tokenCall(doFetch, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    client_secret: client.client_secret,
  });
  const info = await doFetch(USERINFO_URL, { headers: { authorization: `Bearer ${t.access_token}` } });
  const me = (await info.json().catch(() => ({}))) as { email?: string };
  return {
    accessToken: t.access_token!,
    refreshToken: t.refresh_token ?? null,
    expiresIn: t.expires_in ?? 3600,
    email: me.email ?? '',
  };
};

export const revokeToken = async (token: string, doFetch = fetch) => {
  await doFetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
};

/** Access tokens from a refresh token, cached until a minute before they expire. */
export const googleAuth = (client: GoogleClient, refreshToken: string, doFetch = fetch): ProviderAuth => {
  let cur: { token: string; until: number } | null = null;
  return {
    accessToken: async () => {
      if (cur && cur.until > Date.now()) return cur.token;
      const t = await tokenCall(doFetch, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
        client_secret: client.client_secret,
      });
      cur = { token: t.access_token!, until: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000 };
      return cur.token;
    },
  };
};

// -------------------------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------------------------

type GAttendee = {
  email?: string;
  resource?: boolean;
  organizer?: boolean;
  self?: boolean;
  responseStatus?: string;
};
type GTime = { date?: string; dateTime?: string; timeZone?: string };
export type GEvent = {
  id: string;
  status?: string;
  updated?: string;
  created?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  organizer?: { email?: string; self?: boolean };
  attendees?: GAttendee[];
  start?: GTime;
  end?: GTime;
  recurrence?: string[];
  recurringEventId?: string;
  iCalUID?: string;
  guestsCanModify?: boolean;
  extendedProperties?: { private?: Record<string, string> };
};

const whenOf = (s?: GTime, e?: GTime): When | null => {
  if (s?.dateTime && e?.dateTime)
    return { kind: 'timed', start: new Date(s.dateTime).toISOString(), end: new Date(e.dateTime).toISOString() };
  if (s?.date) {
    // Google's all-day end is exclusive.
    const to = e?.date && e.date > s.date ? addDays(e.date as IsoDate, -1) : s.date;
    return { kind: 'allday', from: s.date as IsoDate, to: to as IsoDate };
  }
  return null;
};

const RSVPS: Rsvp[] = ['accepted', 'declined', 'tentative', 'needsAction'];
const guests = (g: GEvent) => (g.attendees ?? []).filter((a) => a.email && !a.resource);

export const fromGoogle = (g: GEvent): ProviderEvent => ({
  id: g.id,
  status: g.status === 'cancelled' ? 'cancelled' : g.status === 'tentative' ? 'tentative' : 'confirmed',
  updated: g.updated ?? null,
  created: g.created ?? null,
  title: g.summary ?? '',
  description: g.description ?? null,
  location: g.location ?? null,
  meetLink: g.hangoutLink ?? g.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? null,
  organizerEmail: g.organizer?.email ?? null,
  attendees: guests(g)
    .map((a) => a.email!.toLowerCase())
    .sort(),
  responses: guests(g).map((a) => ({
    email: a.email!.toLowerCase(),
    status: (RSVPS.includes(a.responseStatus as Rsvp) ? a.responseStatus : 'needsAction') as Rsvp,
    organizer: !!a.organizer,
  })),
  when: whenOf(g.start, g.end),
  recurring: !!g.recurrence?.length,
  recurringEventId: g.recurringEventId ?? null,
  icalUid: g.iCalUID ?? null,
  canEdit: g.organizer?.self !== false || g.guestsCanModify === true,
  marks: {
    ...(g.extendedProperties?.private?.binesItemId ? { binesItemId: g.extendedProperties.private.binesItemId } : {}),
    ...(g.extendedProperties?.private?.binesInstallation
      ? { binesInstallation: g.extendedProperties.private.binesInstallation }
      : {}),
  },
});

/** The attendee list to send: the wanted emails, each keeping what Google knows of it (its answer). */
export const mergeAttendees = (wanted: string[], current: GAttendee[] = []): GAttendee[] => {
  const known = new Map(current.filter((a) => a.email).map((a) => [a.email!.toLowerCase(), a]));
  // Rooms and other resources the calendar added stay.
  return [...wanted.map((e) => known.get(e) ?? { email: e }), ...current.filter((a) => a.resource)];
};

export const toGoogle = (d: EventData, opts: Pick<WriteOpts, 'marks' | 'timezone'>): Record<string, unknown> => ({
  summary: d.title,
  ...(d.description !== null ? { description: d.description } : {}),
  ...(d.location !== null ? { location: d.location } : {}),
  start: d.when.kind === 'timed' ? { dateTime: d.when.start, timeZone: opts.timezone } : { date: d.when.from },
  end: d.when.kind === 'timed' ? { dateTime: d.when.end, timeZone: opts.timezone } : { date: addDays(d.when.to, 1) },
  ...(d.attendees ? { attendees: d.attendees.map((email) => ({ email })) } : {}),
  extendedProperties: {
    private: { binesItemId: opts.marks.binesItemId, binesInstallation: opts.marks.binesInstallation },
  },
});

/** A new event's extras: a Meet link (needs `conferenceDataVersion=1`) and reminders. */
export const insertExtras = (opts: WriteOpts, requestId: string): Record<string, unknown> => ({
  ...(opts.meet
    ? { conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
    : {}),
  ...(opts.reminders
    ? {
        reminders: {
          useDefault: false,
          overrides: [
            ...(opts.reminders.popup !== null ? [{ method: 'popup', minutes: opts.reminders.popup }] : []),
            ...(opts.reminders.email !== null ? [{ method: 'email', minutes: opts.reminders.email }] : []),
          ],
        },
      }
    : {}),
});

const bearer = (auth: ProviderAuth) => {
  if (!auth.accessToken) throw new Error('not a Google connection');
  return auth.accessToken();
};

export const googleProvider = (doFetch: typeof fetch = fetch): CalendarProvider => {
  const call = async <T>(auth: ProviderAuth, method: string, url: string, body?: unknown): Promise<T> => {
    const res = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await bearer(auth)}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* not JSON */
      }
      throw new GoogleError(res.status, `google ${method} ${new URL(url).pathname}: ${msg}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const cal = (id: string) => `${API}/calendars/${encodeURIComponent(id)}`;

  return {
    name: 'google',
    listCalendars: async (auth) => {
      const out: { id: string; name: string; primary: boolean; writable: boolean }[] = [];
      let page: string | undefined;
      do {
        const q = new URLSearchParams({
          minAccessRole: 'reader',
          maxResults: '250',
          ...(page ? { pageToken: page } : {}),
        });
        const r = await call<{
          items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[];
          nextPageToken?: string;
        }>(auth, 'GET', `${API}/users/me/calendarList?${q.toString()}`);
        for (const c of r.items ?? [])
          out.push({
            id: c.id,
            name: c.summaryOverride ?? c.summary ?? c.id,
            primary: !!c.primary,
            writable: c.accessRole === 'owner' || c.accessRole === 'writer',
          });
        page = r.nextPageToken;
      } while (page);
      return out;
    },
    listChanges: async (auth, calendarId, syncToken) => {
      const events: ProviderEvent[] = [];
      let page: string | undefined;
      let next: string | null = null;
      do {
        const q = new URLSearchParams({
          maxResults: '250',
          showDeleted: 'true',
          singleEvents: 'false',
          ...(syncToken ? { syncToken } : {}),
          ...(page ? { pageToken: page } : {}),
        });
        let r: { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string };
        try {
          r = await call(auth, 'GET', `${cal(calendarId)}/events?${q.toString()}`);
        } catch (e) {
          if (e instanceof GoogleError && e.status === 410) throw new SyncTokenGone('sync token expired');
          throw e;
        }
        events.push(...(r.items ?? []).map(fromGoogle));
        page = r.nextPageToken;
        next = r.nextSyncToken ?? next;
      } while (page);
      return { events, nextSyncToken: next };
    },
    listInstances: async (auth, calendarId, eventId, timeMin, timeMax) => {
      const out: ProviderEvent[] = [];
      let page: string | undefined;
      do {
        const q = new URLSearchParams({
          timeMin,
          timeMax,
          showDeleted: 'true',
          maxResults: '250',
          ...(page ? { pageToken: page } : {}),
        });
        const r = await call<{ items?: GEvent[]; nextPageToken?: string }>(
          auth,
          'GET',
          `${cal(calendarId)}/events/${encodeURIComponent(eventId)}/instances?${q.toString()}`,
        );
        out.push(...(r.items ?? []).map(fromGoogle));
        page = r.nextPageToken;
      } while (page);
      return out;
    },
    insertEvent: async (auth, calendarId, data, opts) => {
      const q = new URLSearchParams({
        sendUpdates: opts.sendUpdates,
        ...(opts.meet ? { conferenceDataVersion: '1' } : {}),
      });
      return fromGoogle(
        await call<GEvent>(auth, 'POST', `${cal(calendarId)}/events?${q.toString()}`, {
          ...toGoogle(data, opts),
          ...insertExtras(opts, `${opts.marks.binesItemId}-${Date.now()}`),
        }),
      );
    },
    updateEvent: async (auth, calendarId, eventId, data, opts) => {
      const url = `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`;
      const body = toGoogle(data, opts);
      if (data.attendees) {
        const current = await call<GEvent>(auth, 'GET', url);
        body.attendees = mergeAttendees(data.attendees, current.attendees);
      }
      return fromGoogle(await call<GEvent>(auth, 'PATCH', `${url}?sendUpdates=${opts.sendUpdates}`, body));
    },
    deleteEvent: async (auth, calendarId, eventId, opts) => {
      try {
        await call(
          auth,
          'DELETE',
          `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${opts.sendUpdates}`,
        );
      } catch (e) {
        if (e instanceof GoogleError && (e.status === 404 || e.status === 410)) return;
        throw e;
      }
    },
    markEvent: async (auth, calendarId, eventId, marks) => {
      await call(auth, 'PATCH', `${cal(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
        extendedProperties: { private: { binesItemId: marks.binesItemId, binesInstallation: marks.binesInstallation } },
      });
    },
    watch: async (auth, calendarId, channel) => {
      const r = await call<{ resourceId: string; expiration?: string }>(
        auth,
        'POST',
        `${cal(calendarId)}/events/watch`,
        {
          id: channel.id,
          type: 'web_hook',
          address: channel.address,
          token: channel.token,
          params: { ttl: String(7 * 24 * 3600) },
        },
      );
      return {
        resourceId: r.resourceId,
        expiresAt: new Date(r.expiration ? Number(r.expiration) : Date.now() + 7 * 86_400_000).toISOString(),
      };
    },
    stopWatch: async (auth, channelId, resourceId) => {
      await call(auth, 'POST', `${API}/channels/stop`, { id: channelId, resourceId }).catch(() => undefined);
    },
  };
};
