// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The sync core: board items ↔ calendar events, through any `CalendarProvider`.
 *
 * - Bines → calendar: a board webhook (or the periodic reconcile) names an item; it goes to the calendars of the
 *   members in its people column (personal) and / or to the shared calendar, marked with the item's id
 *   (`binesItemId`) so it is never written twice. With invitations on, the members and the email column's guests are
 *   invited instead of getting copies of their own.
 * - Calendar → Bines: a push (or the periodic pull) reads the calendar's changes since its sync token; a changed
 *   event changes its item, a new one becomes an item through the admin's template, a cancelled one does what the
 *   admin chose (trash, archive, a status label, or only unlink).
 * - Every direction × create / update / delete is its own switch (config.directions).
 * - Loop protection: every link keeps a fingerprint of what was last synced on each side; a change equal to it is
 *   the echo of our own write and is dropped (a change from Google is never pushed back, and vice versa).
 * - Conflicts: when both sides changed since the last sync, the later change wins.
 * - Recurring events only when the admin turns them on: the series' instances within N days.
 * - The guests' answers (RSVP) can set a status label and / or post an update per changed answer.
 *
 * Every operation on one installation runs under its lock, one at a time (one server process).
 */
import type { BinesApi } from './bines';
import type { SyncConfig } from './config';
import { randomId } from './crypto';
import {
  aggregateRsvp,
  answerText,
  binesWins,
  changedAnswers,
  columnFor,
  hashEvent,
  itemToEvent,
  itemUpdateFromEvent,
  newItemFromEvent,
  peopleOf,
  providerEventData,
  rsvpLabel,
  type BinesItem,
} from './mapping';
import {
  SyncTokenGone,
  type CalendarProvider,
  type ProviderAuth,
  type ProviderEvent,
  type WriteOpts,
} from './provider';
import type { ConnectionRow, ImportMode, InstallationRow, LinkRow, Store, StreamRow } from './store';

export type EngineDeps = {
  store: Store;
  /** The calendar providers by name; each connection says which one it is (`ConnectionRow.provider`). */
  providers: Record<string, CalendarProvider>;
  bines: (inst: InstallationRow) => BinesApi;
  authFor: (inst: InstallationRow, conn: ConnectionRow) => Promise<ProviderAuth>;
  /** Where the provider sends push notifications (https only), or null: periodic pulls only. */
  pushAddress?: string | null;
  channelToken?: (channelId: string) => string;
  now?: () => number;
};

const DAY = 86_400_000;

/**
 * The key that finds another calendar's copy of the same meeting (an invitation): its iCalUID — which every instance
 * of a series shares, so an instance adds its own id (the same in every guest's calendar).
 */
const icalKey = (ev: ProviderEvent) =>
  ev.icalUid ? (ev.recurringEventId ? `${ev.icalUid}#${ev.id}` : ev.icalUid) : null;

const IMPORT_ORDER: ImportMode[] = ['none', 'new', 'existing'];
/** What a member lets in from their own calendar, capped at what the admin allows (none chosen yet = nothing). */
export const memberImport = (chosen: ImportMode | undefined, cfg: Pick<SyncConfig, 'member_import'>): ImportMode =>
  IMPORT_ORDER[Math.min(IMPORT_ORDER.indexOf(chosen ?? 'none'), IMPORT_ORDER.indexOf(cfg.member_import))]!;

export const createEngine = (deps: EngineDeps) => {
  const { store } = deps;
  const now = () => deps.now?.() ?? Date.now();
  const iso = () => new Date(now()).toISOString();
  const locks = new Map<string, Promise<unknown>>();

  /** One operation at a time per installation. */
  const withLock = <T>(installationId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(installationId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    locks.set(installationId, tail);
    void tail.then(() => {
      if (locks.get(installationId) === tail) locks.delete(installationId);
    });
    return run;
  };

  const log = (inst: InstallationRow, level: 'info' | 'error', message: string) =>
    store.addLog({ installation_id: inst.id, at: iso(), level, message });

  type Ctx = {
    inst: InstallationRow;
    cfg: SyncConfig;
    api: BinesApi;
    streams: StreamRow[];
    conns: Map<string, ConnectionRow>;
    auths: Map<string, ProviderAuth>;
    emails: Map<string, string> | null;
  };

  const ctxOf = async (installationId: string): Promise<Ctx | null> => {
    const inst = await store.getInstallation(installationId);
    if (!inst || inst.status !== 'active' || !inst.config) return null;
    const conns = new Map((await store.listConnections(inst.id)).map((c) => [c.id, c]));
    return {
      inst,
      cfg: inst.config,
      api: deps.bines(inst),
      streams: await store.listStreams(inst.id),
      conns,
      auths: new Map(),
      emails: null,
    };
  };

  /** The provider a connection is with (Google, CalDAV, ...). */
  const providerOf = (conn: Pick<ConnectionRow, 'provider'>): CalendarProvider => {
    const p = deps.providers[conn.provider];
    if (!p) throw new Error(`unknown provider: ${conn.provider}`);
    return p;
  };

  /** A stream's provider and its connection's auth (once per operation). */
  const via = async (ctx: Ctx, stream: StreamRow) => {
    const conn = ctx.conns.get(stream.connection_id);
    if (!conn) throw new Error('connection_gone');
    const p = providerOf(conn);
    let auth = ctx.auths.get(conn.id);
    if (!auth) {
      auth = await deps.authFor(ctx.inst, conn);
      ctx.auths.set(conn.id, auth);
    }
    return { p, auth };
  };

  /** Member id → email (for invitations), read once per operation; connected members are known already. */
  const emailsOf = async (ctx: Ctx) => {
    if (ctx.emails) return ctx.emails;
    const m = new Map<string, string>();
    for (const c of ctx.conns.values()) m.set(c.user_id, c.user_email);
    // Always read: the guests' emails also tell which of them are members (only they go in the people column).
    try {
      for (const u of await ctx.api.listMembers()) m.set(u.user_id, u.email);
    } catch (e) {
      await log(ctx.inst, 'error', `members: ${(e as Error).message}`);
    }
    ctx.emails = m;
    return m;
  };

  const eventOf = async (ctx: Ctx, item: BinesItem) => {
    if (item.board_id !== ctx.cfg.board_id || item.parent_item_id) return null;
    const emails = ctx.cfg.attendees.enabled ? await emailsOf(ctx) : null;
    return itemToEvent(item, ctx.cfg, (id) => emails?.get(id) ?? null);
  };

  const sendUpdates = (cfg: SyncConfig) => (cfg.attendees.enabled ? cfg.attendees.send_updates : 'none');

  const writeOpts = (ctx: Ctx, itemId: string, insert: boolean): WriteOpts => ({
    marks: { binesItemId: itemId, binesInstallation: ctx.inst.id },
    timezone: ctx.cfg.timezone,
    sendUpdates: sendUpdates(ctx.cfg),
    ...(insert && ctx.cfg.create_meet ? { meet: true } : {}),
    ...(insert && ctx.cfg.reminders.enabled
      ? { reminders: { popup: ctx.cfg.reminders.popup_minutes, email: ctx.cfg.reminders.email_minutes } }
      : {}),
  });

  /**
   * Whose personal calendars an item goes to: the members in its people column; with nobody there and
   * `no_people: 'creator'`, the member who created it (nobody when the creator is unknown).
   */
  const ownersOf = (ctx: Ctx, item: BinesItem): string[] => {
    const people = peopleOf(item, ctx.cfg);
    if (people.length || ctx.cfg.no_people !== 'creator') return people;
    return item.created_by ? [item.created_by] : [];
  };

  /** The calendars an item belongs in: the shared one first (it is the organizer), then its people's own. */
  const targetsOf = (ctx: Ctx, item: BinesItem): StreamRow[] => {
    const out: StreamRow[] = [];
    if (ctx.cfg.target !== 'personal') out.push(...ctx.streams.filter((s) => s.role === 'shared'));
    if (ctx.cfg.target !== 'shared') {
      const people = new Set(ownersOf(ctx, item));
      for (const s of ctx.streams)
        if (s.role === 'personal' && people.has(ctx.conns.get(s.connection_id)?.user_id ?? '')) out.push(s);
    }
    return out;
  };

  const newLink = (ctx: Ctx, p: Pick<LinkRow, 'item_id' | 'stream_id' | 'event_id'> & Partial<LinkRow>): LinkRow => ({
    id: randomId(),
    installation_id: ctx.inst.id,
    master_id: null,
    ical_uid: null,
    readonly: false,
    attendees: [],
    bines_hash: null,
    google_hash: null,
    responses: {},
    rsvp_label: null,
    updated_at: iso(),
    ...p,
  });

  // -----------------------------------------------------------------------------------------------------------
  // Bines → calendar
  // -----------------------------------------------------------------------------------------------------------

  /**
   * An event the board no longer wants (item deleted, no date, a person removed): as the admin chose — delete it,
   * cancel it (the guests are told), or only forget it. An invitation's copy is only forgotten.
   */
  const releaseLink = async (ctx: Ctx, l: LinkRow) => {
    const stream = ctx.streams.find((s) => s.id === l.stream_id);
    const how = ctx.cfg.directions.to_google.delete ? ctx.cfg.on_bines_delete : 'unlink';
    if (stream && !l.readonly && how !== 'unlink') {
      const { p, auth } = await via(ctx, stream);
      await p.deleteEvent(auth, stream.calendar_id, l.event_id, { sendUpdates: how === 'cancel' ? 'all' : 'none' });
    }
    await store.deleteLink(l.id);
  };

  /**
   * Puts an item in its calendars (creates, changes or releases its events, as the switches allow). `quiet`: the
   * periodic reconcile, which does not log again what a webhook already logged.
   */
  const pushItem = async (ctx: Ctx, item: BinesItem, quiet = false) => {
    const dir = ctx.cfg.directions.to_google;
    const data = await eventOf(ctx, item);
    const links = await store.linksForItem(ctx.inst.id, item.id);
    const byId = new Map(ctx.streams.map((s) => [s.id, s]));
    if (!data) {
      for (const l of links) await releaseLink(ctx, l);
      return;
    }
    const hash = hashEvent(data);
    const targets = targetsOf(ctx, item);
    if (
      !quiet &&
      !links.length &&
      ctx.cfg.target === 'personal' &&
      ctx.cfg.no_people === 'creator' &&
      !peopleOf(item, ctx.cfg).length &&
      !item.created_by
    )
      await log(ctx.inst, 'info', `item ${item.id}: nobody in it and its creator is unknown, so it is in no calendar`);
    const wanted = new Set(targets.map((s) => s.id));
    // Members invited to the event already have it (their own copy is linked when their calendar is read).
    const invited = new Set(links.flatMap((l) => l.attendees));
    for (const l of links) {
      const stream = byId.get(l.stream_id);
      if (!stream) {
        await store.deleteLink(l.id);
        continue;
      }
      if (l.readonly) continue;
      if (!wanted.has(l.stream_id)) {
        await releaseLink(ctx, l);
        continue;
      }
      if (l.bines_hash === hash || !dir.update) continue; // nothing new (or the echo of a calendar change)
      const { p, auth } = await via(ctx, stream);
      const ev = await p.updateEvent(auth, stream.calendar_id, l.event_id, data, writeOpts(ctx, item.id, false));
      for (const a of ev.attendees) invited.add(a);
      await store.putLink({
        ...l,
        attendees: ev.attendees,
        bines_hash: hash,
        google_hash: hashEvent(providerEventData(ev, ctx.cfg)),
        updated_at: iso(),
      });
    }
    if (!dir.create) return;
    const linked = new Set(links.map((l) => l.stream_id));
    for (const s of targets) {
      if (linked.has(s.id)) continue;
      const email = ctx.conns.get(s.connection_id)?.account_email.toLowerCase();
      if (s.role === 'personal' && email && invited.has(email)) continue;
      const { p, auth } = await via(ctx, s);
      const ev = await p.insertEvent(auth, s.calendar_id, data, writeOpts(ctx, item.id, true));
      for (const a of ev.attendees) invited.add(a);
      await store.putLink(
        newLink(ctx, {
          item_id: item.id,
          stream_id: s.id,
          event_id: ev.id,
          ical_uid: icalKey(ev),
          attendees: ev.attendees,
          responses: Object.fromEntries(ev.responses.map((r) => [r.email, r.status])),
          bines_hash: hash,
          google_hash: hashEvent(providerEventData(ev, ctx.cfg)),
        }),
      );
      // The new Meet link goes back to the item's `{{meet_link}}` column.
      const meetCol = columnFor(ctx.cfg, 'meet_link');
      if (ev.meetLink && meetCol && item.cells[meetCol]?.text !== ev.meetLink)
        await ctx.api.updateItem(item.id, { values: { [meetCol]: ev.meetLink } });
    }
  };

  /** A board item changed (webhook): fetch it and put it where it belongs. */
  const itemChanged = (installationId: string, itemId: string) =>
    withLock(installationId, async () => {
      const ctx = await ctxOf(installationId);
      if (!ctx) return;
      const item = await ctx.api.getItem(itemId);
      if (!item) return removeItem(ctx, itemId);
      await pushItem(ctx, item);
    });

  /** The item is gone (deleted, archived, moved away): its events are released. */
  const removeItem = async (ctx: Ctx, itemId: string) => {
    for (const l of await store.linksForItem(ctx.inst.id, itemId)) await releaseLink(ctx, l);
  };
  const itemGone = (installationId: string, itemId: string) =>
    withLock(installationId, async () => {
      const ctx = await ctxOf(installationId);
      if (ctx) await removeItem(ctx, itemId);
    });

  // -----------------------------------------------------------------------------------------------------------
  // Calendar → Bines
  // -----------------------------------------------------------------------------------------------------------

  /** The guests' answers: a status label from the aggregate, and an update per changed answer. */
  const applyAnswers = async (ctx: Ctx, link: LinkRow, ev: ProviderEvent): Promise<LinkRow> => {
    if (link.readonly) return link;
    const r = ctx.cfg.rsvp;
    const responses = Object.fromEntries(ev.responses.map((a) => [a.email, a.status]));
    let label = link.rsvp_label;
    if (r.column_id) {
      const next = rsvpLabel(ctx.cfg, aggregateRsvp(ev.responses));
      if (next && next !== link.rsvp_label) {
        await ctx.api.updateItem(link.item_id, { values: { [r.column_id]: next } });
        label = next;
      }
    }
    if (r.comments)
      for (const a of changedAnswers(link.responses, ev.responses))
        await ctx.api.postUpdate(link.item_id, answerText(a));
    const out = { ...link, responses, rsvp_label: label };
    await store.putLink(out);
    return out;
  };

  /** One event of one calendar (not a series' master). */
  const applyEvent = async (ctx: Ctx, stream: StreamRow, ev: ProviderEvent) => {
    const dir = ctx.cfg.directions.to_bines;
    let link = await store.linkForEvent(stream.id, ev.id);
    if (ev.status === 'cancelled') {
      if (link) return cancelLink(ctx, link);
      // A whole series cancelled: its instances.
      for (const l of await store.linksForMaster(stream.id, ev.id)) await cancelLink(ctx, l);
      return;
    }
    const data = providerEventData(ev, ctx.cfg);
    if (!data) return;
    const ghash = hashEvent(data);
    if (!link) {
      // Our own event whose link was lost (e.g. a restored database), or another calendar's copy of a meeting
      // we already have (an invitation: same iCalUID): link it.
      const own = ev.marks.binesInstallation === ctx.inst.id ? ev.marks.binesItemId : undefined;
      const key = icalKey(ev);
      const sibling = !own && key ? await store.linkByIcal(ctx.inst.id, key) : null;
      const itemId = own ?? sibling?.item_id;
      if (!itemId) return importEvent(ctx, stream, ev, ghash);
      const item = await ctx.api.getItem(itemId);
      if (!item) return;
      link = newLink(ctx, {
        item_id: item.id,
        stream_id: stream.id,
        event_id: ev.id,
        master_id: ev.recurringEventId,
        ical_uid: icalKey(ev),
        readonly: !ev.canEdit,
        attendees: ev.attendees,
        responses: Object.fromEntries(ev.responses.map((a) => [a.email, a.status])),
        bines_hash: hashEvent(await eventOf(ctx, item)),
        google_hash: sibling ? ghash : null,
      });
      await store.putLink(link);
      if (sibling) return;
    }
    // Linked before imported events were marked (or marked by another installation): marked now, once.
    if (ev.marks.binesInstallation !== ctx.inst.id && !link.readonly)
      await markAsItem(ctx, stream, ev.id, link.item_id);
    link = await applyAnswers(ctx, link, ev);
    if (link.google_hash === ghash) return; // the echo of our own write
    const item = await ctx.api.getItem(link.item_id);
    if (!item) return store.deleteLink(link.id);
    const ihash = hashEvent(await eventOf(ctx, item));
    if (ihash !== link.bines_hash && binesWins(item.updated_at, ev.updated) && ctx.cfg.directions.to_google.update) {
      // Both sides changed since the last sync and the board's change is newer: it wins.
      await store.putLink({ ...link, google_hash: ghash });
      return pushItem(ctx, item);
    }
    if (!dir.update) return;
    const patch = itemUpdateFromEvent(ev, ctx.cfg, item);
    if (!patch) return;
    const updated = await ctx.api.updateItem(item.id, patch);
    await store.putLink({
      ...link,
      readonly: !ev.canEdit,
      attendees: ev.attendees,
      google_hash: ghash,
      bines_hash: hashEvent(await eventOf(ctx, updated)),
      updated_at: iso(),
    });
    // The item's other calendars follow.
    await pushItem(ctx, updated);
  };

  /** Our hidden marks on an event that is an item's (see `markEvent`); a failure is only logged. */
  const markAsItem = async (ctx: Ctx, stream: StreamRow, eventId: string, itemId: string) => {
    const { p, auth } = await via(ctx, stream);
    if (!p.markEvent) return;
    await p
      .markEvent(auth, stream.calendar_id, eventId, { binesItemId: itemId, binesInstallation: ctx.inst.id })
      .catch((e: Error) => log(ctx.inst, 'error', `mark ${eventId}: ${e.message}`));
  };

  /** A new event (not ours) → an item through the admin's template. */
  const importEvent = async (ctx: Ctx, stream: StreamRow, ev: ProviderEvent, ghash: string) => {
    if (!ctx.cfg.directions.to_bines.create || !ev.when) return;
    const end = ev.when.kind === 'timed' ? Date.parse(ev.when.end) : Date.parse(`${ev.when.to}T23:59:59Z`);
    const conn = ctx.conns.get(stream.connection_id);
    let days = ctx.cfg.past_days;
    // A member's own calendar: only what they let in (the shared calendar is the admin's).
    if (stream.role === 'personal') {
      const mode = memberImport(conn?.prefs?.import, ctx.cfg);
      if (mode === 'none') return;
      if (mode === 'new') {
        const made = ev.created ?? ev.updated;
        if (!made || made < (conn?.prefs?.since ?? '')) return;
      } else days = Math.min(days, conn?.prefs?.days ?? days);
    }
    if (end < now() - days * DAY) return;
    const members = new Set([...(await emailsOf(ctx)).values()].map((e) => e.toLowerCase()));
    const write = newItemFromEvent(ev, ctx.cfg, {
      ownerEmail: stream.role === 'personal' ? (conn?.user_email ?? conn?.account_email) : null,
      isMember: (email) => members.has(email.toLowerCase()),
    });
    if (!write) return;
    const item = await ctx.api.createItem(ctx.cfg.board_id, write);
    const link = newLink(ctx, {
      item_id: item.id,
      stream_id: stream.id,
      event_id: ev.id,
      master_id: ev.recurringEventId,
      ical_uid: icalKey(ev),
      readonly: !ev.canEdit,
      attendees: ev.attendees,
      google_hash: ghash,
      bines_hash: hashEvent(await eventOf(ctx, item)),
    });
    await store.putLink(link);
    // Marked as this item's: should the link be lost (a reconnect), the event is linked again, not imported twice.
    if (!link.readonly) await markAsItem(ctx, stream, ev.id, item.id);
    await applyAnswers(ctx, link, ev);
    await pushItem(ctx, item);
  };

  /**
   * An event was cancelled in the calendar: as the admin chose — the item to the trash (soft delete), archived, a
   * status label, or only unlink. An invitation's copy is only forgotten.
   */
  const cancelLink = async (ctx: Ctx, l: LinkRow) => {
    await store.deleteLink(l.id);
    const how = ctx.cfg.directions.to_bines.delete ? ctx.cfg.on_google_delete : 'unlink';
    if (l.readonly || how === 'unlink') return;
    if (how === 'status') {
      const s = ctx.cfg.delete_status;
      if (s) await ctx.api.updateItem(l.item_id, { values: { [s.column_id]: s.label } });
      return;
    }
    if (how === 'archive') await ctx.api.archiveItem(l.item_id);
    else await ctx.api.deleteItem(l.item_id);
    // The item is gone: its events in the other calendars are released as the admin chose for that direction.
    for (const other of await store.linksForItem(ctx.inst.id, l.item_id)) await releaseLink(ctx, other);
  };

  const recurringWindow = (cfg: SyncConfig) => ({
    min: new Date(now() - DAY).toISOString(),
    max: new Date(now() + cfg.recurring.days * DAY).toISOString(),
  });

  const applySeries = async (ctx: Ctx, stream: StreamRow, masterId: string) => {
    const w = recurringWindow(ctx.cfg);
    const { p, auth } = await via(ctx, stream);
    for (const i of await p.listInstances(auth, stream.calendar_id, masterId, w.min, w.max))
      await applyEvent(ctx, stream, { ...i, recurringEventId: i.recurringEventId ?? masterId });
  };

  /** What a calendar's change means here (recurring events only when the admin turned them on). */
  const applyChange = async (ctx: Ctx, stream: StreamRow, ev: ProviderEvent) => {
    const rec = ctx.cfg.recurring;
    if (ev.recurring) {
      if (ev.status === 'cancelled') return applyEvent(ctx, stream, ev);
      if (!rec.enabled) return;
      return applySeries(ctx, stream, ev.id);
    }
    if (ev.recurringEventId) {
      if (!rec.enabled) return;
      const start = ev.when?.kind === 'timed' ? ev.when.start : ev.when ? `${ev.when.from}T00:00:00Z` : null;
      const linked = await store.linkForEvent(stream.id, ev.id);
      if (!linked && ev.status !== 'cancelled' && start && Date.parse(start) > now() + rec.days * DAY) return;
    }
    return applyEvent(ctx, stream, ev);
  };

  /** Reads one calendar's changes since its sync token (all of it the first time). */
  const pullStreamIn = async (ctx: Ctx, stream: StreamRow) => {
    const { p, auth } = await via(ctx, stream);
    let res;
    try {
      res = await p.listChanges(auth, stream.calendar_id, stream.sync_token);
    } catch (e) {
      if (!(e instanceof SyncTokenGone)) throw e;
      res = await p.listChanges(auth, stream.calendar_id, null);
    }
    for (const ev of res.events) {
      try {
        await applyChange(ctx, stream, ev);
      } catch (e) {
        await log(ctx.inst, 'error', `event ${ev.id}: ${(e as Error).message}`);
      }
    }
    // A rolling window: once a day the series we know get their new instances.
    let refreshed = stream.recurring_refreshed_at;
    if (ctx.cfg.recurring.enabled && (!refreshed || Date.parse(refreshed) < now() - DAY)) {
      const masters = new Set(
        (await store.listLinks(ctx.inst.id))
          .filter((l) => l.stream_id === stream.id && l.master_id)
          .map((l) => l.master_id!),
      );
      for (const m of masters) await applySeries(ctx, stream, m);
      refreshed = iso();
    }
    const fresh = (await store.getStream(stream.id)) ?? stream;
    await store.putStream({
      ...fresh,
      sync_token: res.nextSyncToken ?? stream.sync_token,
      last_sync_at: iso(),
      last_error: null,
      recurring_refreshed_at: refreshed,
    });
  };

  const pullStream = (installationId: string, streamId: string) =>
    withLock(installationId, async () => {
      const ctx = await ctxOf(installationId);
      const stream = ctx?.streams.find((s) => s.id === streamId);
      if (!ctx || !stream) return;
      try {
        await pullStreamIn(ctx, stream);
      } catch (e) {
        await store.putStream({ ...stream, last_error: (e as Error).message });
        await log(ctx.inst, 'error', `calendar ${stream.calendar_id}: ${(e as Error).message}`);
      }
    });

  // -----------------------------------------------------------------------------------------------------------
  // Streams, push channels, full sync
  // -----------------------------------------------------------------------------------------------------------

  /** The calendars the configuration asks for: each connected member's own, and / or the shared one. */
  const ensureStreamsIn = async (inst: InstallationRow) => {
    const cfg = inst.config;
    const conns = await store.listConnections(inst.id);
    const want: Omit<StreamRow, 'id'>[] = [];
    const blank = {
      sync_token: null,
      channel: null,
      last_sync_at: null,
      last_error: null,
      recurring_refreshed_at: null,
    };
    if (cfg && cfg.target !== 'shared')
      for (const c of conns)
        want.push({
          installation_id: inst.id,
          connection_id: c.id,
          calendar_id: c.prefs?.calendar_id ?? 'primary',
          role: 'personal',
          ...blank,
        });
    if (cfg && cfg.target !== 'personal' && cfg.shared) {
      const c = conns.find((x) => x.user_id === cfg.shared!.user_id);
      if (c)
        want.push({
          installation_id: inst.id,
          connection_id: c.id,
          calendar_id: cfg.shared.calendar_id,
          role: 'shared',
          ...blank,
        });
    }
    const key = (s: Pick<StreamRow, 'connection_id' | 'calendar_id' | 'role'>) =>
      `${s.connection_id}|${s.calendar_id}|${s.role}`;
    const have = await store.listStreams(inst.id);
    const wantKeys = new Set(want.map(key));
    for (const s of have)
      if (!wantKeys.has(key(s))) {
        await stopChannel(inst, s, conns);
        await store.deleteStream(s.id);
      }
    const haveKeys = new Set(have.map(key));
    for (const w of want) if (!haveKeys.has(key(w))) await store.putStream({ id: randomId(), ...w });
  };
  const ensureStreams = (installationId: string) =>
    withLock(installationId, async () => {
      const inst = await store.getInstallation(installationId);
      if (inst) await ensureStreamsIn(inst);
    });

  const stopChannel = async (inst: InstallationRow, s: StreamRow, conns?: ConnectionRow[]) => {
    if (!s.channel) return;
    const conn = (conns ?? (await store.listConnections(inst.id))).find((c) => c.id === s.connection_id);
    const p = conn ? deps.providers[conn.provider] : undefined;
    if (!conn || !p?.stopWatch) return;
    try {
      await p.stopWatch(await deps.authFor(inst, conn), s.channel.id, s.channel.resource_id);
    } catch {
      /* best effort: it expires anyway */
    }
  };

  /**
   * Opens a push channel for each calendar whose provider has push, and renews it a day before it ends. The others
   * (CalDAV) are read by the periodic pull only (`syncAll`, every SYNC_INTERVAL_MINUTES).
   */
  const renewWatchesIn = async (ctx: Ctx) => {
    if (!deps.pushAddress || !deps.channelToken) return;
    for (const s of ctx.streams) {
      const conn = ctx.conns.get(s.connection_id);
      const watch = conn ? deps.providers[conn.provider]?.watch : undefined;
      if (!watch) continue;
      if (s.channel && Date.parse(s.channel.expires_at) > now() + DAY) continue;
      try {
        const { auth } = await via(ctx, s);
        const id = randomId();
        const info = await watch(auth, s.calendar_id, {
          id,
          token: deps.channelToken(id),
          address: deps.pushAddress,
        });
        await stopChannel(ctx.inst, s, [...ctx.conns.values()]);
        const fresh = (await store.getStream(s.id)) ?? s;
        await store.putStream({ ...fresh, channel: { id, resource_id: info.resourceId, expires_at: info.expiresAt } });
      } catch (e) {
        await log(ctx.inst, 'error', `push channel ${s.calendar_id}: ${(e as Error).message}`);
      }
    }
  };

  /** Everything, both ways: the calendars' changes, then every board item (hash-guarded, so cheap when in sync). */
  const syncAll = (installationId: string, opts: { items?: boolean } = {}) =>
    withLock(installationId, async () => {
      const inst = await store.getInstallation(installationId);
      if (!inst || inst.status !== 'active' || !inst.config) return;
      await ensureStreamsIn(inst);
      const ctx = (await ctxOf(installationId))!;
      await renewWatchesIn(ctx);
      ctx.streams = await store.listStreams(inst.id);
      for (const s of ctx.streams) {
        try {
          await pullStreamIn(ctx, s);
        } catch (e) {
          await store.putStream({ ...((await store.getStream(s.id)) ?? s), last_error: (e as Error).message });
          await log(inst, 'error', `calendar ${s.calendar_id}: ${(e as Error).message}`);
        }
      }
      if (opts.items !== false) {
        try {
          const items = await ctx.api.listItems(ctx.cfg.board_id);
          const onBoard = new Set(items.map((i) => i.id));
          for (const item of items) {
            try {
              await pushItem(ctx, item, true);
            } catch (e) {
              await log(inst, 'error', `item ${item.id}: ${(e as Error).message}`);
            }
          }
          const gone = new Set(
            (await store.listLinks(inst.id)).filter((l) => !onBoard.has(l.item_id)).map((l) => l.item_id),
          );
          for (const id of gone) await removeItem(ctx, id);
        } catch (e) {
          await log(inst, 'error', `board: ${(e as Error).message}`);
        }
      }
      await store.putInstallation({ ...((await store.getInstallation(inst.id)) ?? inst), last_sync_at: iso() });
    });

  /** A member disconnected: stop reading their calendars (the events already there stay). */
  const disconnect = (installationId: string, connectionId: string) =>
    withLock(installationId, async () => {
      const inst = await store.getInstallation(installationId);
      if (!inst) return;
      for (const s of await store.listStreams(inst.id))
        if (s.connection_id === connectionId) {
          await stopChannel(inst, s);
          await store.deleteStream(s.id);
        }
      await store.deleteConnection(connectionId);
    });

  /** Uninstalled: close every push channel (the rows go with the installation). */
  const shutdown = async (installationId: string) => {
    const inst = await store.getInstallation(installationId);
    if (!inst) return;
    const conns = await store.listConnections(inst.id);
    for (const s of await store.listStreams(inst.id)) await stopChannel(inst, s, conns);
  };

  return { withLock, itemChanged, itemGone, pullStream, ensureStreams, syncAll, disconnect, shutdown, log };
};
export type Engine = ReturnType<typeof createEngine>;
