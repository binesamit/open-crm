// SPDX-License-Identifier: AGPL-3.0-only
/** Test doubles: a calendar provider and the Bines API, both in memory, recording what they were asked. */
import type { BinesApi, BoardInfo, HookInfo } from '../src/bines';
import { syncConfigSchema, type SyncConfig } from '../src/config';
import type { BinesItem, ItemWrite } from '../src/mapping';
import type { AttendeeAnswer, CalendarProvider, EventData, ProviderEvent, WriteOpts } from '../src/provider';
import { memoryStore, type ConnectionRow, type InstallationRow, type MemberPrefs } from '../src/store';
import { createEngine } from '../src/sync';

export const BOARD = 'b1';
/** A member who lets everything in from their main calendar (most tests read imports). */
export const ALL_IN: MemberPrefs = {
  calendar_id: 'primary',
  calendar_name: null,
  import: 'existing',
  days: 365,
  since: '2000-01-01T00:00:00.000Z',
};
export const config = (over: Record<string, unknown> = {}): SyncConfig =>
  syncConfigSchema.parse({
    board_id: BOARD,
    time_source: 'timeline',
    date_column_id: 'tl',
    people_column_id: 'people',
    timezone: 'Asia/Jerusalem',
    ...over,
  });

let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

export type Call = { op: string; calendarId: string; eventId?: string; data?: EventData; opts?: Partial<WriteOpts> };

export const fakeProvider = (now: () => number) => {
  const cals = new Map<string, Map<string, ProviderEvent>>();
  const changes = new Map<string, string[]>(); // calendar → event ids in change order
  const calls: Call[] = [];
  const instances = new Map<string, ProviderEvent[]>(); // master id → instances
  const cal = (id: string) => {
    if (!cals.has(id)) cals.set(id, new Map());
    if (!changes.has(id)) changes.set(id, []);
    return cals.get(id)!;
  };
  const touch = (calendarId: string, id: string) => changes.get(calendarId)!.push(id);
  const fromData = (id: string, d: EventData, opts: WriteOpts, prev?: ProviderEvent): ProviderEvent => ({
    id,
    status: 'confirmed',
    updated: new Date(now()).toISOString(),
    created: prev?.created ?? new Date(now()).toISOString(),
    title: d.title,
    description: d.description ?? prev?.description ?? null,
    location: d.location ?? prev?.location ?? null,
    meetLink: prev?.meetLink ?? (opts.meet ? `https://meet.google.com/${id}` : null),
    organizerEmail: prev?.organizerEmail ?? 'owner@x.test',
    attendees: d.attendees ?? prev?.attendees ?? [],
    responses: (d.attendees ?? prev?.attendees ?? []).map(
      (e) =>
        prev?.responses.find((r) => r.email === e) ?? { email: e, status: 'needsAction' as const, organizer: false },
    ),
    when: d.when,
    recurring: false,
    recurringEventId: null,
    icalUid: prev?.icalUid ?? `${id}@ical`,
    canEdit: true,
    marks: { ...opts.marks },
  });
  const provider: CalendarProvider = {
    name: 'fake',
    listCalendars: async () => [{ id: 'primary', name: 'Me', primary: true, writable: true }],
    listChanges: async (_a, calendarId, syncToken) => {
      const c = cal(calendarId);
      const log = changes.get(calendarId)!;
      const from = syncToken ? Number(syncToken) : 0;
      const ids = [...new Set(syncToken ? log.slice(from) : [...c.keys()])];
      return {
        events: ids.map((id) => structuredClone(c.get(id)!)).filter(Boolean),
        nextSyncToken: String(log.length),
      };
    },
    listInstances: async (_a, _c, eventId, timeMin, timeMax) =>
      (instances.get(eventId) ?? []).filter(
        (i) => i.when?.kind === 'timed' && i.when.start >= timeMin && i.when.start <= timeMax,
      ),
    insertEvent: async (_a, calendarId, data, opts) => {
      const id = nextId('ev');
      const ev = fromData(id, data, opts);
      cal(calendarId).set(id, ev);
      touch(calendarId, id);
      calls.push({ op: 'insert', calendarId, eventId: id, data, opts });
      return structuredClone(ev);
    },
    updateEvent: async (_a, calendarId, eventId, data, opts) => {
      const c = cal(calendarId);
      const ev = fromData(eventId, data, opts, c.get(eventId));
      c.set(eventId, ev);
      touch(calendarId, eventId);
      calls.push({ op: 'update', calendarId, eventId, data, opts });
      return structuredClone(ev);
    },
    markEvent: async (_a, calendarId, eventId, marks) => {
      const c = cal(calendarId);
      const ev = c.get(eventId);
      if (ev) c.set(eventId, { ...ev, marks: { ...marks } }); // hidden: no change to read, nothing in `calls`
    },
    deleteEvent: async (_a, calendarId, eventId, opts) => {
      const c = cal(calendarId);
      const ev = c.get(eventId);
      if (ev) c.set(eventId, { ...ev, status: 'cancelled', updated: new Date(now()).toISOString() });
      touch(calendarId, eventId);
      calls.push({ op: 'delete', calendarId, eventId, opts });
    },
  };
  /** A change made by a person in the calendar (not through the sync). */
  const external = (calendarId: string, ev: Partial<ProviderEvent> & { id?: string }) => {
    const c = cal(calendarId);
    const id = ev.id ?? nextId('gx');
    const prev = c.get(id);
    const next: ProviderEvent = {
      id,
      status: 'confirmed',
      updated: new Date(now()).toISOString(),
      created: prev?.created ?? new Date(now()).toISOString(),
      title: '',
      description: null,
      location: null,
      meetLink: null,
      organizerEmail: 'someone@x.test',
      attendees: [],
      responses: [],
      when: null,
      recurring: false,
      recurringEventId: null,
      icalUid: `${id}@ical`,
      canEdit: true,
      marks: {},
      ...prev,
      ...ev,
    };
    c.set(id, next);
    touch(calendarId, id);
    return next;
  };
  const answer = (calendarId: string, id: string, responses: AttendeeAnswer[]) =>
    external(calendarId, { id, responses, updated: new Date(now()).toISOString() });
  return { provider, calls, cals, external, answer, instances, cal };
};

export const fakeBines = (now: () => number) => {
  /** What the token endpoint says the credentials belong to (tests change it to forge an `installed` call). */
  const grant = { installation_id: 'inst2', account_id: 'acc2' };
  const items = new Map<string, BinesItem>();
  const deleted = new Set<string>();
  const archived = new Set<string>();
  const updates: { itemId: string; body: string }[] = [];
  const writes: { op: string; id: string; body: unknown }[] = [];
  const members = [
    { user_id: 'u1', email: 'ann@x.test', name: 'Ann' },
    { user_id: 'u2', email: 'bob@x.test', name: 'Bob' },
  ];
  const apply = (item: BinesItem, body: Partial<ItemWrite>) => {
    if (body.name) item.name = body.name;
    for (const [k, v] of Object.entries(body.cells ?? {})) item.cells[k] = { value: v, text: null };
    for (const [k, v] of Object.entries(body.values ?? {})) {
      if (k === 'people') {
        // As Bines does: an email that is no member's refuses the whole write.
        const found = v.split(',').map((e) => {
          const m = members.find((x) => x.email === e.trim());
          if (!m) throw new Error(`No member "${e.trim()}" for "people"`);
          return m;
        });
        if (found.length)
          item.cells[k] = {
            value: { persons_and_teams: found.map((m) => ({ id: m.user_id, kind: 'person' })) },
            text: null,
          };
      } else item.cells[k] = { value: v, text: v };
    }
    item.updated_at = new Date(now()).toISOString();
  };
  const api: BinesApi = {
    me: async () => ({ id: 'svc' }),
    grant: async () => grant,
    introspect: async () => ({ active: false }),
    listBoards: async () => [{ id: BOARD, name: 'Meetings' }],
    getBoard: async (): Promise<BoardInfo> => ({ id: BOARD, name: 'Meetings', columns: [], groups: [] }),
    getItem: async (id) =>
      items.has(id) && !deleted.has(id) && !archived.has(id) ? structuredClone(items.get(id)!) : null,
    listItems: async () => [...items.values()].filter((i) => !deleted.has(i.id)).map((i) => structuredClone(i)),
    createItem: async (boardId, body) => {
      const item: BinesItem = { id: nextId('it'), board_id: boardId, name: '', updated_at: '', cells: {} };
      apply(item, body);
      items.set(item.id, item);
      writes.push({ op: 'create', id: item.id, body });
      return structuredClone(item);
    },
    updateItem: async (id, body) => {
      const item = items.get(id)!;
      apply(item, body);
      writes.push({ op: 'update', id, body });
      return structuredClone(item);
    },
    deleteItem: async (id) => {
      deleted.add(id);
      writes.push({ op: 'delete', id, body: null });
    },
    archiveItem: async (id) => {
      archived.add(id);
      writes.push({ op: 'archive', id, body: null });
    },
    postUpdate: async (itemId, body) => void updates.push({ itemId, body }),
    listMembers: async () => members,
    createWebhook: async (): Promise<HookInfo> => ({ id: nextId('wh'), event: 'x', url: 'x', is_active: true }),
    listWebhooks: async () => [],
    deleteWebhook: async () => undefined,
  };
  /** A person changes an item on the board. */
  const edit = (id: string, body: Partial<ItemWrite>) => {
    const item = items.get(id)!;
    apply(item, body);
  };
  const add = (over: Partial<BinesItem> & { cells: BinesItem['cells'] }) => {
    const item: BinesItem = {
      id: nextId('it'),
      board_id: BOARD,
      name: 'Meeting',
      updated_at: new Date(now()).toISOString(),
      ...over,
    };
    items.set(item.id, item);
    return item;
  };
  return { api, items, deleted, archived, updates, writes, edit, add, members, grant };
};

/** An installation with Ann connected (personal calendar 'primary' of ann@x.test) and the engine. */
export const setup = async (
  over: Record<string, unknown> = {},
  opts: { shared?: boolean; prefs?: MemberPrefs | null } = {},
) => {
  let clock = Date.parse('2026-11-03T08:00:00Z');
  const now = () => clock;
  const tick = (ms = 60_000) => (clock += ms);
  const store = memoryStore();
  const g = fakeProvider(now);
  const b = fakeBines(now);
  const inst: InstallationRow = {
    id: 'inst1',
    account_id: 'acc',
    status: 'active',
    credentials_enc: '',
    service_user_id: 'svc',
    config: config(
      opts.shared
        ? { target: 'shared', shared: { user_id: 'u1', calendar_id: 'team', calendar_name: 'Team' }, ...over }
        : over,
    ),
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
    provider: 'fake',
    account_email: 'ann@x.test',
    refresh_token_enc: '',
    status: 'ok',
    error: null,
    created_at: new Date(clock).toISOString(),
    prefs: opts.prefs === undefined ? ALL_IN : opts.prefs,
  };
  await store.putConnection(conn);
  const engine = createEngine({
    store,
    providers: { fake: g.provider },
    bines: () => b.api,
    authFor: async () => ({ accessToken: async () => 'tok' }),
    now,
  });
  await engine.ensureStreams(inst.id);
  const stream = (await store.listStreams(inst.id))[0]!;
  // The first read of the calendar (empty) sets the sync token.
  await engine.pullStream(inst.id, stream.id);
  return { store, g, b, engine, inst, stream, tick, now, calId: stream.calendar_id };
};

/** A timeline cell: a day from 10:00 to 11:00 (wall-clock). */
export const at = (day: string, from = '10:00', to = '11:00') => ({
  value: { from: day, to: day, from_time: from, to_time: to },
  text: null,
});
export const people = (...ids: string[]) => ({
  value: { persons_and_teams: ids.map((id) => ({ id, kind: 'person' })) },
  text: null,
});
