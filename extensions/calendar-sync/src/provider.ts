// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The calendar provider interface. The sync core (sync.ts) only speaks this; Google (google.ts) and CalDAV
 * (caldav.ts) implement it. Each connection names its provider; the calendar id `primary` is the account's own
 * default calendar.
 */
import type { IsoDate } from '@bines/shared';

/** When an event happens: instants (ISO, UTC) for a timed event; days (inclusive) for an all-day one. */
export type When = { kind: 'timed'; start: string; end: string } | { kind: 'allday'; from: IsoDate; to: IsoDate };

/** What the sync writes to a calendar. */
export type EventData = {
  title: string;
  description: string | null;
  location: string | null;
  when: When;
  /** Invited guests' emails (lower case, sorted); null = the sync does not manage invitations. */
  attendees: string[] | null;
};

export type Rsvp = 'accepted' | 'declined' | 'tentative' | 'needsAction';
export type AttendeeAnswer = { email: string; status: Rsvp; organizer: boolean };

/** How a write goes out. */
export type WriteOpts = {
  marks: EventMarks;
  timezone: string;
  /** Who the provider tells about it (Google `sendUpdates`). */
  sendUpdates: 'all' | 'externalOnly' | 'none';
  /** On a new event: a video meeting link. */
  meet?: boolean;
  /** On a new event: reminders (minutes before). */
  reminders?: { popup: number | null; email: number | null } | null;
};

/** Marks the sync puts on the events it writes (Google: `extendedProperties.private`). */
export type EventMarks = { binesItemId: string; binesInstallation: string };

/** An event as the provider read it. */
export type ProviderEvent = {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** Last change (ISO). */
  updated: string | null;
  /** When it was made (ISO), when the provider says. */
  created: string | null;
  title: string;
  description: string | null;
  location: string | null;
  meetLink: string | null;
  organizerEmail: string | null;
  attendees: string[];
  /** Each guest's answer. */
  responses: AttendeeAnswer[];
  when: When | null;
  /** A recurring series' master (has rules). */
  recurring: boolean;
  /** An instance of a series: the master's id. */
  recurringEventId: string | null;
  icalUid: string | null;
  /** The calendar it was read from may change it (organizer, or guests may modify). */
  canEdit: boolean;
  marks: Partial<EventMarks>;
};

export type ProviderCalendar = { id: string; name: string; primary: boolean; writable: boolean };

/** A CalDAV account as discovery found it, with the member's credentials (stored encrypted). */
export type CaldavAccount = {
  /** The calendar home collection (absolute URL). */
  home: string;
  /** The calendar the member's own items go to (the stream's `primary`): absolute URL. */
  primary: string;
  /** The account's address (calendar-user-address-set), or null. */
  email: string | null;
  username: string;
  password: string;
};

/**
 * How a provider reaches one connected account: Google, an access token from the refresh token; CalDAV, the
 * account's server and credentials.
 */
export type ProviderAuth = { accessToken?: () => Promise<string>; caldav?: CaldavAccount };

export class SyncTokenGone extends Error {}

export type Channel = { id: string; token: string; address: string };
export type ChannelInfo = { resourceId: string; expiresAt: string };

export interface CalendarProvider {
  readonly name: string;
  listCalendars(auth: ProviderAuth): Promise<ProviderCalendar[]>;
  /** Changes since `syncToken` (everything when null). Throws `SyncTokenGone` when the token expired. */
  listChanges(
    auth: ProviderAuth,
    calendarId: string,
    syncToken: string | null,
  ): Promise<{ events: ProviderEvent[]; nextSyncToken: string | null }>;
  /** The instances of a recurring series inside a window. */
  listInstances(
    auth: ProviderAuth,
    calendarId: string,
    eventId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<ProviderEvent[]>;
  insertEvent(auth: ProviderAuth, calendarId: string, data: EventData, opts: WriteOpts): Promise<ProviderEvent>;
  /** Changes the event; attendees (when managed) are added / removed, the answers of those who stay are kept. */
  updateEvent(
    auth: ProviderAuth,
    calendarId: string,
    eventId: string,
    data: EventData,
    opts: WriteOpts,
  ): Promise<ProviderEvent>;
  deleteEvent(
    auth: ProviderAuth,
    calendarId: string,
    eventId: string,
    opts: Pick<WriteOpts, 'sendUpdates'>,
  ): Promise<void>;
  /**
   * Puts our marks on an event made elsewhere that became an item (nothing else changes, nobody is told): read again
   * after its link was lost (a member disconnected and connected again), it is known as that item's and not
   * imported twice. Providers without hidden fields leave it out.
   */
  markEvent?(auth: ProviderAuth, calendarId: string, eventId: string, marks: EventMarks): Promise<void>;
  /** Push notifications, when the provider has them. */
  watch?(auth: ProviderAuth, calendarId: string, channel: Channel): Promise<ChannelInfo>;
  stopWatch?(auth: ProviderAuth, channelId: string, resourceId: string): Promise<void>;
}
