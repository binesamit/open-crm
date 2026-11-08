// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { memberImport } from '../src/sync';
import { ALL_IN, at, people, setup } from './fakes';

const ops = (calls: { op: string }[]) => calls.map((c) => c.op);

describe('Bines → Google', () => {
  it('an item with a member goes to that member’s calendar once, marked with the item id', async () => {
    const s = await setup();
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(ops(s.g.calls)).toEqual(['insert']);
    expect(s.g.calls[0]!.opts?.marks).toEqual({ binesItemId: item.id, binesInstallation: 'inst1' });
    // The webhook for the same state again (and the board reconcile): nothing new goes out.
    await s.engine.itemChanged(s.inst.id, item.id);
    await s.engine.syncAll(s.inst.id);
    expect(ops(s.g.calls)).toEqual(['insert']);
  });

  it('an item without one of the connected members, or without a date, has no event', async () => {
    const s = await setup();
    const a = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u2') } });
    const b = s.b.add({ cells: { people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, a.id);
    await s.engine.itemChanged(s.inst.id, b.id);
    expect(s.g.calls).toEqual([]);
  });

  it('a change on the board updates the event; the echo from Google is not applied back (loop protection)', async () => {
    const s = await setup();
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    s.tick();
    s.b.edit(item.id, { name: 'Moved', cells: { tl: at('2026-11-11', '12:00', '13:00').value } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(ops(s.g.calls)).toEqual(['insert', 'update']);
    expect(s.g.calls[1]!.data).toMatchObject({ title: 'Moved', when: { start: '2026-11-11T10:00:00.000Z' } });
    // Google reports our own two writes: nothing changes on the board.
    const before = s.b.writes.length;
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.writes.length).toBe(before);
  });

  it('switches: no create / no update / delete off = only unlink', async () => {
    const off = await setup({ directions: { to_google: { create: false } } });
    const i1 = off.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await off.engine.itemChanged(off.inst.id, i1.id);
    expect(off.g.calls).toEqual([]);

    const noUpd = await setup({ directions: { to_google: { update: false } } });
    const i2 = noUpd.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await noUpd.engine.itemChanged(noUpd.inst.id, i2.id);
    noUpd.b.edit(i2.id, { name: 'Changed' });
    await noUpd.engine.itemChanged(noUpd.inst.id, i2.id);
    expect(ops(noUpd.g.calls)).toEqual(['insert']);

    const noDel = await setup({ directions: { to_google: { delete: false } }, on_bines_delete: 'delete' });
    const i3 = noDel.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await noDel.engine.itemChanged(noDel.inst.id, i3.id);
    await noDel.engine.itemGone(noDel.inst.id, i3.id);
    expect(ops(noDel.g.calls)).toEqual(['insert']);
    expect(await noDel.store.linksForItem(noDel.inst.id, i3.id)).toEqual([]);
  });

  it.each([
    ['delete', ['insert', 'delete'], 'none'],
    ['cancel', ['insert', 'delete'], 'all'],
    ['unlink', ['insert'], undefined],
  ] as const)('item deleted on the board → %s', async (how, expected, sendUpdates) => {
    const s = await setup({ on_bines_delete: how });
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    s.b.deleted.add(item.id);
    await s.engine.itemChanged(s.inst.id, item.id); // the webhook: the item is gone (404)
    expect(ops(s.g.calls)).toEqual(expected);
    if (sendUpdates) expect(s.g.calls[1]!.opts?.sendUpdates).toBe(sendUpdates);
    expect(await s.store.linksForItem(s.inst.id, item.id)).toEqual([]);
  });

  it('a person removed from the item → their copy is released', async () => {
    const s = await setup({ on_bines_delete: 'delete' });
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    s.b.edit(item.id, { cells: { people: { persons_and_teams: [] } } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(ops(s.g.calls)).toEqual(['insert', 'delete']);
  });
});

describe('an item with nobody in it', () => {
  it('goes to the calendar of the member who created it (the default)', async () => {
    const s = await setup();
    const item = s.b.add({ created_by: 'u1', cells: { tl: at('2026-11-10') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls).toMatchObject([{ op: 'insert', calendarId: 'primary' }]);
    // Someone is put in it: their calendars, not the creator's (Ann is not in it any more).
    s.b.edit(item.id, { cells: { people: people('u2').value } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(await s.store.linksForItem(s.inst.id, item.id)).toEqual([]);
  });

  it('no_people: skip → no personal calendar; a creator who did not connect → none either', async () => {
    const skip = await setup({ no_people: 'skip' });
    const a = skip.b.add({ created_by: 'u1', cells: { tl: at('2026-11-10') } });
    await skip.engine.itemChanged(skip.inst.id, a.id);
    expect(skip.g.calls).toEqual([]);

    const s = await setup();
    const b = s.b.add({ created_by: 'u2', cells: { tl: at('2026-11-10') } });
    await s.engine.itemChanged(s.inst.id, b.id);
    expect(s.g.calls).toEqual([]);
  });

  it('the people column wins over the creator (people who did not connect: no calendar)', async () => {
    const s = await setup();
    const item = s.b.add({ created_by: 'u1', cells: { tl: at('2026-11-10'), people: people('u2') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls).toEqual([]);
  });

  it('an unknown creator: skipped and logged once (not again on every reconcile)', async () => {
    const s = await setup();
    const item = s.b.add({ created_by: null, cells: { tl: at('2026-11-10') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    await s.engine.syncAll(s.inst.id);
    expect(s.g.calls).toEqual([]);
    const log = (await s.store.recentLog(s.inst.id, 10)).filter((l) => l.message.includes(item.id));
    expect(log).toMatchObject([{ level: 'info' }]);
  });

  it('with the shared calendar too, the item still goes there', async () => {
    const s = await setup(
      { target: 'both', shared: { user_id: 'u1', calendar_id: 'team', calendar_name: 'Team' } },
      { shared: true },
    );
    const item = s.b.add({ created_by: 'u1', cells: { tl: at('2026-11-10') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls.map((c) => c.calendarId).sort()).toEqual(['primary', 'team']);
  });
});

describe('invitations', () => {
  it('the shared calendar invites the people (by email) and the guests; sendUpdates passes through; changes add / remove', async () => {
    const s = await setup(
      { attendees: { enabled: true, email_column_id: 'guests', send_updates: 'externalOnly' } },
      { shared: true },
    );
    const item = s.b.add({
      cells: { tl: at('2026-11-10'), people: people('u1', 'u2'), guests: { value: null, text: 'out@guest.test' } },
    });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls[0]).toMatchObject({ op: 'insert', calendarId: 'team', opts: { sendUpdates: 'externalOnly' } });
    expect(s.g.calls[0]!.data?.attendees).toEqual(['ann@x.test', 'bob@x.test', 'out@guest.test']);
    // Bob leaves the item.
    s.b.edit(item.id, { cells: { people: { persons_and_teams: [{ id: 'u1', kind: 'person' }] } } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls[1]).toMatchObject({ op: 'update', opts: { sendUpdates: 'externalOnly' } });
    expect(s.g.calls[1]!.data?.attendees).toEqual(['ann@x.test', 'out@guest.test']);
  });

  it('with invitations off, nobody is told (sendUpdates none) and no attendees are sent', async () => {
    const s = await setup();
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1', 'u2') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls[0]!.opts?.sendUpdates).toBe('none');
    expect(s.g.calls[0]!.data?.attendees).toBeNull();
  });

  it('a Meet link is created and written back to the {{meet_link}} column; reminders go with a new event', async () => {
    const s = await setup({
      create_meet: true,
      reminders: { enabled: true, popup_minutes: 15, email_minutes: 60 },
      template: { fields: [{ column_id: 'link', template: '{{meet_link}}' }] },
    });
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls[0]!.opts).toMatchObject({ meet: true, reminders: { popup: 15, email: 60 } });
    expect(s.b.items.get(item.id)!.cells.link?.text).toMatch(/^https:\/\/meet\.google\.com\//);
    // Writing the link back changes the item, but not what goes to the calendar: no second write.
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(ops(s.g.calls)).toEqual(['insert']);
  });
});

describe('Google → Bines', () => {
  it('a new event becomes an item through the template (owner in the people column) and is not pushed back', async () => {
    const s = await setup({
      template: { name: '📅 {{title}}', fields: [{ column_id: 'notes', template: '{{description}}' }] },
    });
    s.g.external(s.calId, {
      title: 'Dentist',
      description: 'Bring the form',
      when: { kind: 'timed', start: '2026-11-12T08:00:00Z', end: '2026-11-12T08:30:00Z' },
    });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const created = [...s.b.items.values()][0]!;
    expect(created.name).toBe('📅 Dentist');
    expect(created.cells.tl?.value).toEqual({
      from: '2026-11-12',
      to: '2026-11-12',
      from_time: '10:00',
      to_time: '10:30',
    });
    expect(created.cells.notes?.text).toBe('Bring the form');
    expect(created.cells.people?.value).toEqual({ persons_and_teams: [{ id: 'u1', kind: 'person' }] });
    // The item's webhook arrives: its own calendar has it already.
    await s.engine.itemChanged(s.inst.id, created.id);
    expect(s.g.calls).toEqual([]);
  });

  it('guests from outside the account stay out of the people column (the item is still made)', async () => {
    const s = await setup();
    s.g.external(s.calId, {
      title: 'Clinic',
      attendees: ['bob@x.test', 'patient@outside.test'],
      when: { kind: 'timed', start: '2026-11-12T08:00:00Z', end: '2026-11-12T08:30:00Z' },
    });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const created = [...s.b.items.values()][0]!;
    expect(created.cells.people?.value).toEqual({
      persons_and_teams: [
        { id: 'u1', kind: 'person' },
        { id: 'u2', kind: 'person' },
      ],
    });
  });

  it('an imported event read again after its link was lost (a reconnect) is not imported twice', async () => {
    const s = await setup();
    s.g.external(s.calId, {
      title: 'Dentist',
      when: { kind: 'timed', start: '2026-11-12T08:00:00Z', end: '2026-11-12T08:30:00Z' },
    });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const [created] = [...s.b.items.values()];
    for (const l of await s.store.linksForItem(s.inst.id, created!.id)) await s.store.deleteLink(l.id);
    const stream = (await s.store.getStream(s.stream.id))!;
    await s.store.putStream({ ...stream, sync_token: null }); // everything is read again
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.size).toBe(1);
    expect(await s.store.linksForItem(s.inst.id, created!.id)).toHaveLength(1);
  });

  it('a change in Google updates the item; the board’s echo does not go back (loop protection)', async () => {
    const s = await setup();
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    const evId = s.g.calls[0]!.eventId!;
    s.tick();
    s.g.external(s.calId, {
      id: evId,
      title: 'Renamed in Google',
      when: { kind: 'timed', start: '2026-11-10T12:00:00Z', end: '2026-11-10T13:00:00Z' },
    });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const after = s.b.items.get(item.id)!;
    expect(after.name).toBe('Renamed in Google');
    expect(after.cells.tl?.value).toMatchObject({ from_time: '14:00', to_time: '15:00' });
    await s.engine.itemChanged(s.inst.id, item.id); // the webhook of our own write
    expect(ops(s.g.calls)).toEqual(['insert']);
  });

  it('both changed: the later change wins', async () => {
    const s = await setup();
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    const evId = s.g.calls[0]!.eventId!;
    s.tick();
    s.g.external(s.calId, { id: evId, title: 'Google (older)' });
    s.tick();
    s.b.edit(item.id, { name: 'Board (newer)' }); // its webhook has not arrived yet
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.get(item.id)!.name).toBe('Board (newer)');
    expect(s.g.calls.at(-1)).toMatchObject({ op: 'update', data: { title: 'Board (newer)' } });
  });

  it('switches: no create, no update', async () => {
    const s = await setup({ directions: { to_bines: { create: false } } });
    s.g.external(s.calId, { title: 'X', when: { kind: 'allday', from: '2026-11-12', to: '2026-11-12' } });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.size).toBe(0);

    const u = await setup({ directions: { to_bines: { update: false } } });
    const item = u.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await u.engine.itemChanged(u.inst.id, item.id);
    u.tick();
    u.g.external(u.calId, { id: u.g.calls[0]!.eventId!, title: 'Changed in Google' });
    await u.engine.pullStream(u.inst.id, u.stream.id);
    expect(u.b.items.get(item.id)!.name).toBe('Meeting');
  });

  it.each([
    ['trash', 'delete'],
    ['archive', 'archive'],
    ['status', 'update'],
    ['unlink', null],
  ] as const)('event cancelled in Google → %s', async (how, write) => {
    const s = await setup({
      on_google_delete: how,
      ...(how === 'status' ? { delete_status: { column_id: 'st', label: 'Cancelled' } } : {}),
    });
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    s.g.external(s.calId, { id: s.g.calls[0]!.eventId!, status: 'cancelled' });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const last = s.b.writes.at(-1);
    if (write) expect(last).toMatchObject({ op: write, id: item.id });
    else expect(s.b.writes).toEqual([]);
    if (how === 'status') expect(s.b.items.get(item.id)!.cells.st?.text).toBe('Cancelled');
    expect(await s.store.linksForItem(s.inst.id, item.id)).toEqual([]);
  });

  it('delete switch off: a cancelled event only unlinks', async () => {
    const s = await setup({ on_google_delete: 'trash', directions: { to_bines: { delete: false } } });
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    s.g.external(s.calId, { id: s.g.calls[0]!.eventId!, status: 'cancelled' });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.deleted.size).toBe(0);
  });

  it('old events are not imported (past_days)', async () => {
    const s = await setup({ past_days: 7 });
    s.g.external(s.calId, {
      title: 'Old',
      when: { kind: 'timed', start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z' },
    });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.size).toBe(0);
  });
});

describe('recurring events', () => {
  const series = (s: Awaited<ReturnType<typeof setup>>) => {
    const master = s.g.external(s.calId, { title: 'Weekly', recurring: true });
    const inst = (day: string) => ({
      ...master,
      id: `${master.id}_${day}`,
      recurring: false,
      recurringEventId: master.id,
      when: { kind: 'timed' as const, start: `${day}T08:00:00Z`, end: `${day}T09:00:00Z` },
    });
    s.g.instances.set(master.id, [inst('2026-11-05'), inst('2026-11-12'), inst('2027-06-01')]);
    // A changed instance shows up in the change list too.
    s.g.external(s.calId, inst('2026-11-19'));
    return master;
  };

  it('off (the default): neither the series nor its instances become items', async () => {
    const s = await setup();
    series(s);
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.size).toBe(0);
  });

  it('on: the instances within N days only', async () => {
    const s = await setup({ recurring: { enabled: true, days: 30 } });
    series(s);
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const days = [...s.b.items.values()].map((i) => (i.cells.tl?.value as { from: string }).from).sort();
    expect(days).toEqual(['2026-11-05', '2026-11-12', '2026-11-19']);
  });
});

describe('answers (RSVP) back on the board', () => {
  it('the aggregate sets the label; each changed answer posts an update', async () => {
    const s = await setup(
      {
        attendees: { enabled: true },
        rsvp: {
          column_id: 'rsvp',
          labels: { accepted: 'Confirmed', declined: 'Declined', pending: 'Waiting' },
          comments: true,
        },
      },
      { shared: true },
    );
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1', 'u2') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    const evId = s.g.calls[0]!.eventId!;
    s.tick();
    s.g.answer(s.calId, evId, [
      { email: 'ann@x.test', status: 'accepted', organizer: false },
      { email: 'bob@x.test', status: 'needsAction', organizer: false },
    ]);
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.get(item.id)!.cells.rsvp?.text).toBe('Waiting');
    expect(s.b.updates.map((u) => u.body)).toEqual([expect.stringContaining('ann@x.test')]);
    s.tick();
    s.g.answer(s.calId, evId, [
      { email: 'ann@x.test', status: 'accepted', organizer: false },
      { email: 'bob@x.test', status: 'accepted', organizer: false },
    ]);
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.get(item.id)!.cells.rsvp?.text).toBe('Confirmed');
    expect(s.b.updates).toHaveLength(2);
    // Answers alone do not move anything back to the calendar.
    expect(ops(s.g.calls)).toEqual(['insert']);
  });
});

describe('what a member lets in from their own calendar', () => {
  const ev = (start: string, end: string) => ({ when: { kind: 'timed' as const, start, end } });

  it('nothing chosen yet: their own events stay out; the board’s meetings still go out and come back changed', async () => {
    const s = await setup({}, { prefs: null });
    s.g.external(s.calId, { title: 'Doctor', ...ev('2026-11-12T08:00:00Z', '2026-11-12T08:30:00Z') });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.size).toBe(0);

    const item = s.b.add({ name: 'Review', cells: { tl: at('2026-11-12'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    const id = s.g.calls.find((c) => c.op === 'insert')!.eventId!;
    s.tick();
    s.g.external(s.calId, { id, title: 'Review moved' });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.get(item.id)!.name).toBe('Review moved');
  });

  it('"new": only meetings made in the calendar after they chose it', async () => {
    const since = new Date(Date.parse('2026-11-03T08:00:00Z') + 30 * 60_000).toISOString();
    const s = await setup(
      {},
      { prefs: { calendar_id: 'primary', calendar_name: null, import: 'new', days: 30, since } },
    );
    s.g.external(s.calId, { title: 'Old one', ...ev('2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z') });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.size).toBe(0);
    s.tick(60 * 60_000);
    s.g.external(s.calId, { title: 'New one', ...ev('2026-11-13T08:00:00Z', '2026-11-13T09:00:00Z') });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect([...s.b.items.values()].map((i) => i.name)).toEqual(['New one']);
  });

  it('"existing": also what is already there, as far back as they chose (never past the admin’s limit)', async () => {
    const s = await setup(
      { past_days: 30 },
      { prefs: { calendar_id: 'primary', calendar_name: null, import: 'existing', days: 2, since: '' } },
    );
    s.g.external(s.calId, { title: 'Five days ago', ...ev('2026-10-29T08:00:00Z', '2026-10-29T09:00:00Z') });
    s.g.external(s.calId, { title: 'Yesterday', ...ev('2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z') });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect([...s.b.items.values()].map((i) => i.name)).toEqual(['Yesterday']);
  });

  it('the admin’s cap wins: a member who chose "existing" gets nothing when the admin allows none', async () => {
    const s = await setup({ member_import: 'none' });
    s.g.external(s.calId, { title: 'Doctor', ...ev('2026-11-12T08:00:00Z', '2026-11-12T08:30:00Z') });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.size).toBe(0);
    expect(memberImport('existing', { member_import: 'new' })).toBe('new');
    expect(memberImport(undefined, { member_import: 'existing' })).toBe('none');
  });

  it('the calendar they picked is the one synced', async () => {
    const s = await setup({}, { prefs: { ...ALL_IN, calendar_id: 'work', calendar_name: 'Work' } });
    expect(s.stream.calendar_id).toBe('work');
    const item = s.b.add({ name: 'Review', cells: { tl: at('2026-11-12'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    expect(s.g.calls.find((c) => c.op === 'insert')!.calendarId).toBe('work');
  });
});
