// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { caldavProvider, type CaldavError } from '../src/caldav';
import { DAV_ORIGIN, DAV_PASS, DAV_USER, WORK, fakeCaldav, ics, setupCaldav } from './fake-caldav';
import { at, people } from './fakes';

const lunch = (summary = 'Lunch', start = '20261110T120000', end = '20261110T130000') =>
  ics(
    'UID:lunch-1',
    `SUMMARY:${summary}`,
    `DTSTART;TZID=Asia/Jerusalem:${start}`,
    `DTEND;TZID=Asia/Jerusalem:${end}`,
    'DTSTAMP:20261101T000000Z',
  );
const multigets = (dav: ReturnType<typeof fakeCaldav>) => dav.requests.filter((r) => r.body.includes('multiget'));
const unfold = (s: string) => s.replace(/\r\n[ \t]/g, '');

describe('CalDAV discovery', () => {
  it('well-known → principal → home → the calendars with events; the own calendar is the first writable one', async () => {
    const dav = fakeCaldav();
    const found = await caldavProvider(dav.fetch).discover({
      url: DAV_ORIGIN,
      username: DAV_USER,
      password: DAV_PASS,
    });
    expect(dav.requests[0]!.path).toBe('/.well-known/caldav');
    expect(found).toMatchObject({
      home: `${DAV_ORIGIN}/dav/calendars/ann/`,
      primary: `${DAV_ORIGIN}${WORK}`,
      email: 'ann@dav.test',
      username: DAV_USER,
    });
    // The tasks list (VTODO only) is not a calendar for events.
    expect(found.calendars).toEqual([{ id: `${DAV_ORIGIN}${WORK}`, name: 'Work', primary: true, writable: true }]);
  });

  it('a refused password is an auth error; an address that is not CalDAV, or not https, says so', async () => {
    const dav = fakeCaldav();
    const p = caldavProvider(dav.fetch);
    const codeOf = (url: string, password = DAV_PASS) =>
      p.discover({ url, username: DAV_USER, password }).then(
        () => 'ok',
        (e: CaldavError) => e.code,
      );
    expect(await codeOf(DAV_ORIGIN, 'nope')).toBe('auth');
    expect(await codeOf('https://other.test/dav/')).toBe('not_caldav');
    expect(await codeOf('http://dav.test/')).toBe('bad_url');
    expect(await codeOf('https://10.0.0.5/')).toBe('bad_url');
    expect(await codeOf(`${DAV_ORIGIN}/dav/`)).toBe('ok'); // a principal-capable address directly
  });
});

describe('CalDAV → board', () => {
  it('the first read imports the calendar (TZID times); the next reads only what changed (sync-collection)', async () => {
    const s = await setupCaldav();
    s.dav.put(`${WORK}lunch.ics`, lunch());
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const [item] = [...s.b.items.values()];
    expect(item).toMatchObject({ name: 'Lunch' });
    expect(item!.cells.tl!.value).toMatchObject({ from: '2026-11-10', from_time: '12:00', to_time: '13:00' });
    expect((await s.store.getStream(s.stream.id))!.sync_token).toMatch(/^sync:/);

    // Someone moves it in their calendar app and adds another.
    s.tick();
    s.dav.put(`${WORK}lunch.ics`, lunch('Lunch moved', '20261111T140000', '20261111T150000'));
    s.dav.put(
      `${WORK}call.ics`,
      ics('UID:call-1', 'SUMMARY:Call', 'DTSTART;VALUE=DATE:20261112', 'DTEND;VALUE=DATE:20261113'),
    );
    const before = multigets(s.dav).length;
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.get(item!.id)).toMatchObject({ name: 'Lunch moved' });
    expect(s.b.items.get(item!.id)!.cells.tl!.value).toMatchObject({ from: '2026-11-11', from_time: '14:00' });
    const call = [...s.b.items.values()].find((i) => i.name === 'Call')!;
    expect(call.cells.tl!.value).toMatchObject({ from: '2026-11-12', to: '2026-11-12' });
    expect(multigets(s.dav).length).toBe(before + 1);

    // Nothing new: no event is read again.
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(multigets(s.dav).length).toBe(before + 1);
  });

  it('an event deleted in the calendar → as the admin chose (trash)', async () => {
    const s = await setupCaldav({ on_google_delete: 'trash' });
    s.dav.put(`${WORK}lunch.ics`, lunch());
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const [item] = [...s.b.items.values()];
    s.dav.remove(`${WORK}lunch.ics`);
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.deleted.has(item!.id)).toBe(true);
  });

  it('without sync-collection: the ctag says whether to look, the etags say what changed', async () => {
    const s = await setupCaldav({ on_google_delete: 'trash' }, { syncCollection: false });
    s.dav.put(`${WORK}lunch.ics`, lunch());
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const [item] = [...s.b.items.values()];
    expect(item).toMatchObject({ name: 'Lunch' });
    expect((await s.store.getStream(s.stream.id))!.sync_token).toMatch(/^etag:/);

    const listings = () => s.dav.requests.filter((r) => r.method === 'PROPFIND' && r.headers.depth === '1').length;
    const n = listings();
    await s.engine.pullStream(s.inst.id, s.stream.id); // same ctag: nothing listed
    expect(listings()).toBe(n);

    s.tick();
    s.dav.put(`${WORK}lunch.ics`, lunch('Renamed'));
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.items.get(item!.id)).toMatchObject({ name: 'Renamed' });

    s.dav.remove(`${WORK}lunch.ics`);
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.deleted.has(item!.id)).toBe(true);
  });

  it('an expired sync token: read everything again, no error', async () => {
    const s = await setupCaldav();
    s.dav.put(`${WORK}lunch.ics`, lunch());
    await s.engine.pullStream(s.inst.id, s.stream.id);
    await s.store.putStream({ ...(await s.store.getStream(s.stream.id))!, sync_token: `sync:${DAV_ORIGIN}/sync/999` });
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const st = (await s.store.getStream(s.stream.id))!;
    expect(st.last_error).toBeNull();
    expect(st.sync_token).toBe(`sync:${DAV_ORIGIN}/sync/1`);
    expect(s.b.items.size).toBe(1); // linked, not imported twice
  });

  it('a recurring series (when turned on): its instances become items; an excluded date cancels its item', async () => {
    const s = await setupCaldav({ recurring: { enabled: true, days: 30 }, on_google_delete: 'trash' });
    const series = (...extra: string[]) =>
      ics(
        'UID:standup',
        'SUMMARY:Standup',
        'DTSTART:20261104T070000Z',
        'DTEND:20261104T071500Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        ...extra,
      );
    s.dav.put(`${WORK}standup.ics`, series());
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const items = [...s.b.items.values()];
    expect(items.map((i) => i.name)).toEqual(['Standup', 'Standup', 'Standup']);
    const links = await s.store.listLinks(s.inst.id);
    expect(links.every((l) => l.master_id === '/dav/calendars/ann/work/standup.ics')).toBe(true);
    expect(links.map((l) => l.event_id.split('#')[1]).sort()).toEqual([
      '20261104T070000Z',
      '20261105T070000Z',
      '20261106T070000Z',
    ]);

    s.tick();
    s.dav.put(`${WORK}standup.ics`, series('EXDATE:20261105T070000Z'));
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const gone = links.find((l) => l.event_id.endsWith('20261105T070000Z'))!;
    expect(s.b.deleted.has(gone.item_id)).toBe(true);
    expect(s.b.deleted.size).toBe(1);
  });

  it('a refused password later (changed on the server): the calendar shows the error, nothing breaks', async () => {
    const s = await setupCaldav();
    s.dav.setPassword('changed-elsewhere');
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const st = (await s.store.getStream(s.stream.id))!;
    expect(st.last_error).toMatch(/refused/);
    expect((await s.store.recentLog(s.inst.id, 5))[0]).toMatchObject({ level: 'error' });
  });
});

describe('board → CalDAV', () => {
  it('an item goes to the member’s calendar as an event (PUT If-None-Match), marked; its echo changes nothing', async () => {
    const s = await setupCaldav();
    await s.engine.pullStream(s.inst.id, s.stream.id);
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    const [path, res] = [...s.dav.events()][0]!;
    expect(res!.body).toContain('SUMMARY:Meeting');
    expect(res!.body).toContain(`X-BINES-ITEM-ID:${item.id}`);
    expect(res!.body).toContain('X-BINES-INSTALLATION:inst1');
    expect(res!.body).toContain('DTSTART:20261110T080000Z'); // 10:00 in Jerusalem
    const put = s.dav.requests.find((r) => r.method === 'PUT')!;
    expect(put.headers['if-none-match']).toBe('*');
    const link = (await s.store.linksForItem(s.inst.id, item.id))[0]!;
    expect(link.event_id).toBe(path);

    const writes = s.b.writes.length;
    await s.engine.pullStream(s.inst.id, s.stream.id);
    expect(s.b.writes.length).toBe(writes);

    // A change on the board: written over the etag just read.
    s.tick();
    s.b.edit(item.id, { name: 'Moved', cells: { tl: at('2026-11-11', '12:00', '13:00').value } });
    const etag = s.dav.events().get(path!)!.etag;
    await s.engine.itemChanged(s.inst.id, item.id);
    const puts = s.dav.requests.filter((r) => r.method === 'PUT');
    expect(puts[1]!.headers['if-match']).toBe(etag);
    expect(s.dav.events().get(path!)!.body).toContain('SUMMARY:Moved');
    expect(s.dav.events().get(path!)!.body).toContain('DTSTART:20261111T100000Z');
  });

  it('an item deleted on the board → the event is deleted (DELETE If-Match)', async () => {
    const s = await setupCaldav({ on_bines_delete: 'delete' });
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    const [, res] = [...s.dav.events()][0]!;
    await s.engine.itemGone(s.inst.id, item.id);
    expect(s.dav.events().size).toBe(0);
    expect(s.dav.requests.find((r) => r.method === 'DELETE')!.headers['if-match']).toBe(res!.etag);
    expect(await s.store.linksForItem(s.inst.id, item.id)).toEqual([]);
  });

  it('invitations: attendees with SCHEDULE-AGENT=CLIENT when nobody is to be told; answers kept on update', async () => {
    const s = await setupCaldav({ attendees: { enabled: true, send_updates: 'none' } });
    const item = s.b.add({ cells: { tl: at('2026-11-10'), people: people('u1', 'u2') } });
    await s.engine.itemChanged(s.inst.id, item.id);
    const [path, res] = [...s.dav.events()][0]!;
    const body = unfold(res!.body);
    expect(body).toContain('ORGANIZER:mailto:ann@dav.test');
    expect(body).toMatch(/ATTENDEE;[^\r\n]*SCHEDULE-AGENT=CLIENT[^\r\n]*:mailto:bob@x\.test/);
    // Bob accepts in his calendar (the server writes his answer into the organizer's copy).
    s.dav.put(
      path!,
      body.replace(/(ATTENDEE;[^\r\n]*)PARTSTAT=NEEDS-ACTION([^\r\n]*:mailto:bob)/, '$1PARTSTAT=ACCEPTED$2'),
    );
    s.tick();
    s.b.edit(item.id, { name: 'Renamed' });
    await s.engine.itemChanged(s.inst.id, item.id);
    const after = unfold(s.dav.events().get(path!)!.body);
    expect(after).toContain('SUMMARY:Renamed');
    expect(after).toMatch(/PARTSTAT=ACCEPTED[^\r\n]*:mailto:bob@x\.test/);
  });
});
