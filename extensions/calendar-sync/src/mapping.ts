// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Item ↔ event, both ways, through the core calendar's own helpers (`readTimedSpan`, `timedCells`, `allDayCells`
 * in @bines/shared) — so an item sits in Google exactly where the board's calendar view shows it.
 *
 * A timeline's times and hour columns are wall-clock in the account's zone; a date column's own time is stored as
 * UTC. Events carry instants, so the zone is the bridge.
 */
import { createHash } from 'node:crypto';
import {
  addDays,
  allDayCells,
  DEFAULT_REGION,
  hmOf,
  localDateOf,
  localDateValue,
  localTimeOf,
  minutesOf,
  readTimedSpan,
  timedCells,
  zonedInstant,
  type CalendarTimeConfig,
  type IsoDate,
  type Region,
} from '@bines/shared';
import type { SyncConfig, TemplateVar } from './config';
import type { AttendeeAnswer, EventData, ProviderEvent, When } from './provider';

export type Cells = Record<string, { value: unknown; text?: string | null } | undefined>;
export type BinesItem = {
  id: string;
  board_id: string;
  name: string;
  parent_item_id?: string | null;
  /** The member who created it (null when unknown, e.g. their user was removed). */
  created_by?: string | null;
  updated_at: string;
  cells: Cells;
};

export const regionOf = (cfg: Pick<SyncConfig, 'timezone'>): Region => ({ ...DEFAULT_REGION, timezone: cfg.timezone });

export const timeConfigOf = (cfg: SyncConfig): CalendarTimeConfig => ({
  source: cfg.time_source,
  dateColumnId: cfg.date_column_id,
  startColumnId: cfg.start_column_id,
  endColumnId: cfg.end_column_id,
  defaultDuration: cfg.default_duration,
});

/** The instant of a wall-clock day + minutes (1440 = the next midnight). */
const instantAt = (day: IsoDate, minutes: number, r: Region) =>
  minutes >= 1440 ? zonedInstant(addDays(day, 1), '00:00', r) : zonedInstant(day, hmOf(minutes), r);

/** When an item happens, or null when it has no date. */
export const itemWhen = (cells: Cells, cfg: SyncConfig): When | null => {
  const r = regionOf(cfg);
  const span = readTimedSpan(cells, timeConfigOf(cfg), r);
  if (span)
    return {
      kind: 'timed',
      start: instantAt(span.day, span.start, r).toISOString(),
      end: instantAt(span.endDay, span.end, r).toISOString(),
    };
  const v = cells[cfg.date_column_id]?.value as
    { date?: IsoDate; time?: string; from?: IsoDate; to?: IsoDate } | null | undefined;
  if (!v) return null;
  if (v.from && v.to) return { kind: 'allday', from: v.from, to: v.to };
  if (v.date) {
    const local = localDateValue({ date: v.date, ...(v.time ? { time: v.time } : {}) }, r);
    return { kind: 'allday', from: local.date, to: local.date };
  }
  return null;
};

/** The cells that put an item at an event's time (`current` = the item's cells, for what a move keeps). */
export const whenCells = (when: When, cfg: SyncConfig, current: Cells = {}): Record<string, unknown> => {
  const r = regionOf(cfg);
  const tc = timeConfigOf(cfg);
  const cur = current as Parameters<typeof timedCells>[1];
  if (when.kind === 'timed') {
    const s = new Date(when.start);
    const e = new Date(when.end);
    const length = Math.max(1, Math.round((e.getTime() - s.getTime()) / 60_000));
    return timedCells(tc, cur, localDateOf(s, r), minutesOf(localTimeOf(s, r)), length, r);
  }
  if (cfg.time_source === 'timeline') return { [cfg.date_column_id]: { from: when.from, to: when.to } };
  return allDayCells(tc, cur, when.from);
};

/** A column whose template is exactly `{{var}}` (so its text can go back to the event). */
export const columnFor = (cfg: SyncConfig, v: TemplateVar) =>
  cfg.template.fields.find((f) => f.template.trim() === `{{${v}}}`)?.column_id ?? null;

const cellText = (cells: Cells, id: string | null) => {
  if (!id) return null;
  const c = cells[id];
  const t = c?.text ?? (typeof c?.value === 'string' ? c.value : null);
  return t && t.trim() ? t : null;
};

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** The emails in an email / text cell (`{email}`, or text with several separated by commas). */
export const cellEmails = (cells: Cells, id: string | null): string[] => {
  if (!id) return [];
  const c = cells[id];
  const v = c?.value as { email?: unknown } | string | null | undefined;
  const raw = [
    typeof v === 'object' && typeof v?.email === 'string' ? v.email : '',
    typeof v === 'string' ? v : '',
    c?.text ?? '',
  ]
    .join(',')
    .split(/[,;\s]+/);
  return raw.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e));
};

/** Who an item invites: its people's emails and the email column's guests (sorted, once each). */
export const itemAttendees = (item: BinesItem, cfg: SyncConfig, emailOf: (userId: string) => string | null) => {
  const people = peopleOf(item, cfg)
    .map(emailOf)
    .filter((e): e is string => !!e)
    .map((e) => e.toLowerCase());
  return [...new Set([...people, ...cellEmails(item.cells, cfg.attendees.email_column_id)])].sort();
};

/** What an item puts in a calendar (null = no date: it has no event). */
export const itemToEvent = (
  item: BinesItem,
  cfg: SyncConfig,
  emailOf: (userId: string) => string | null = () => null,
): EventData | null => {
  const when = itemWhen(item.cells, cfg);
  if (!when) return null;
  return {
    title: item.name,
    description: cellText(item.cells, columnFor(cfg, 'description')),
    location: cellText(item.cells, columnFor(cfg, 'location')),
    when,
    attendees: cfg.attendees.enabled ? itemAttendees(item, cfg, emailOf) : null,
  };
};

/** The same projection of an event the provider read (only the fields that also go back). */
export const providerEventData = (ev: ProviderEvent, cfg: SyncConfig): EventData | null =>
  ev.when
    ? {
        title: ev.title,
        description: columnFor(cfg, 'description') ? ev.description : null,
        location: columnFor(cfg, 'location') ? ev.location : null,
        when: ev.when,
        attendees: cfg.attendees.enabled ? [...ev.attendees].sort() : null,
      }
    : null;

const normWhen = (w: When): When =>
  w.kind === 'timed'
    ? { kind: 'timed', start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() }
    : w;

/** A stable fingerprint of what was synced (loop protection: a change equal to it is an echo). */
export const hashEvent = (d: EventData | null): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        d
          ? [
              d.title.trim(),
              (d.description ?? '').trim(),
              (d.location ?? '').trim(),
              normWhen(d.when),
              d.attendees ? [...d.attendees].sort() : null,
            ]
          : ['<none>'],
      ),
    )
    .digest('hex')
    .slice(0, 32);

// -------------------------------------------------------------------------------------------------------------
// Templates (Google → Bines)
// -------------------------------------------------------------------------------------------------------------

/** `{{title}}`, `{{ description }}` … → the event's values (unknown variables → empty). */
export const renderTemplate = (tpl: string, vars: Partial<Record<string, string | null>>): string =>
  tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '').trim();

export const templateVars = (ev: ProviderEvent, calendarName = ''): Record<TemplateVar, string> => ({
  title: ev.title,
  description: ev.description ?? '',
  location: ev.location ?? '',
  meet_link: ev.meetLink ?? '',
  organizer: ev.organizerEmail ?? '',
  attendees: ev.attendees.join(', '),
  calendar: calendarName,
});

export type ItemWrite = {
  name?: string;
  group_id?: string;
  cells: Record<string, unknown>;
  values: Record<string, string>;
};

/** A new item from an event: the template's name and fields, the time, the people (by email; members only). */
export const newItemFromEvent = (
  ev: ProviderEvent,
  cfg: SyncConfig,
  opts: { ownerEmail?: string | null; calendarName?: string; isMember?: (email: string) => boolean } = {},
): ItemWrite | null => {
  if (!ev.when) return null;
  const vars = templateVars(ev, opts.calendarName);
  const values: Record<string, string> = {};
  for (const f of cfg.template.fields) {
    const v = renderTemplate(f.template, vars);
    if (v) values[f.column_id] = v;
  }
  if (cfg.people_column_id) {
    // Only the account's members: a guest from outside has no place in a people column (Bines refuses the item).
    const member = opts.isMember ?? (() => true);
    const emails = [...new Set([opts.ownerEmail, ...ev.attendees].filter((e): e is string => !!e && member(e)))];
    if (emails.length) values[cfg.people_column_id] = emails.join(', ');
  }
  return {
    name: renderTemplate(cfg.template.name, vars) || ev.title || '(ללא כותרת)',
    ...(cfg.template.group_id ? { group_id: cfg.template.group_id } : {}),
    cells: whenCells(ev.when, cfg),
    values,
  };
};

/** The change an event makes to its item (name, fields, time; the people stay as the board has them). */
export const itemUpdateFromEvent = (ev: ProviderEvent, cfg: SyncConfig, item: BinesItem): ItemWrite | null => {
  if (!ev.when) return null;
  const vars = templateVars(ev);
  const values: Record<string, string> = {};
  for (const f of cfg.template.fields) {
    const v = renderTemplate(f.template, vars);
    if (v) values[f.column_id] = v;
  }
  const name = renderTemplate(cfg.template.name, vars) || ev.title;
  return { ...(name ? { name } : {}), cells: whenCells(ev.when, cfg, item.cells), values };
};

/** The members an item names in the people column (persons only). */
export const peopleOf = (item: BinesItem, cfg: SyncConfig): string[] => {
  if (!cfg.people_column_id) return [];
  const v = item.cells[cfg.people_column_id]?.value as
    { persons_and_teams?: { id: string; kind: string }[] } | null | undefined;
  return (v?.persons_and_teams ?? []).filter((p) => p.kind === 'person').map((p) => p.id);
};

/** Last updated wins: does the board's change beat the calendar's? */
export const binesWins = (itemUpdatedAt: string, eventUpdated: string | null) =>
  !eventUpdated || Date.parse(itemUpdatedAt) > Date.parse(eventUpdated);

// -------------------------------------------------------------------------------------------------------------
// Answers (RSVP)
// -------------------------------------------------------------------------------------------------------------

export type Aggregate = 'accepted' | 'declined' | 'tentative' | 'pending';

/** The guests' answers as one: any declined → declined; all accepted → accepted; any tentative → tentative; else pending. */
export const aggregateRsvp = (answers: AttendeeAnswer[]): Aggregate | null => {
  const guests = answers.filter((a) => !a.organizer);
  if (!guests.length) return null;
  if (guests.some((a) => a.status === 'declined')) return 'declined';
  if (guests.every((a) => a.status === 'accepted')) return 'accepted';
  if (guests.some((a) => a.status === 'tentative')) return 'tentative';
  return 'pending';
};

/** The label the admin set for an aggregate answer ('' = none: leave the column). Tentative falls back to pending. */
export const rsvpLabel = (cfg: SyncConfig, agg: Aggregate | null): string => {
  if (!agg) return '';
  const l = cfg.rsvp.labels;
  return agg === 'tentative' ? l.tentative || l.pending : l[agg];
};

const ANSWER_TEXT: Record<string, { he: string; en: string }> = {
  accepted: { he: 'אישר/ה הגעה', en: 'accepted' },
  declined: { he: 'דחה/תה', en: 'declined' },
  tentative: { he: 'אולי', en: 'maybe' },
  needsAction: { he: 'עדיין לא ענה/תה', en: 'has not answered yet' },
};

/** The answers that changed since last time (organizer excluded). */
export const changedAnswers = (prev: Record<string, string>, answers: AttendeeAnswer[]) =>
  answers.filter((a) => !a.organizer && prev[a.email] !== undefined && prev[a.email] !== a.status);

/** An update's text for one changed answer. */
export const answerText = (a: AttendeeAnswer, locale: 'he' | 'en' = 'he') =>
  `📅 ${a.email} — ${ANSWER_TEXT[a.status]?.[locale] ?? a.status}`;
