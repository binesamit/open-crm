// SPDX-License-Identifier: AGPL-3.0-only
import { strToU8, unzipSync, zipSync } from 'fflate';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { helpRouteOf, helpVideoEmbedUrl, toursToOffer, type MyTour } from '@bines/shared';
import { isWebVtt, sniffVideo } from '../src/modules/help/help.assets';
import { formatChapterTime, parseChapter, parseStepLine } from '../src/modules/help/help.import';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Practical guides and guided tours: a guide's video / captions / still / steps as
 * help files (checked by content, each kind in its place), published with the article and shown to readers; tours
 * written in the owner console (writers write, publishers publish, a step's element picked on screen), a member's
 * tours and progress, the person's and the account's switches, "show me in the app", and both in the package
 * import / export.
 */
let t: TestContext;
let owner: string;
let agent: string;
let lead: string;
let admin: string;
let bob: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const png = (w: number, h: number, seed = 0) => {
  const img = new PNG({ width: w, height: h });
  img.data.fill(seed);
  return new Uint8Array(PNG.sync.write(img));
};
/** The first bytes of an MP4 file (an `ftyp` box), padded — enough for the sniffer. */
const mp4 = (seed = 0) => {
  const b = new Uint8Array(64).fill(seed);
  b.set([0, 0, 0, 24], 0);
  b.set(strToU8('ftypisom'), 4);
  return b;
};
const vtt = (text = 'שלום') => strToU8(`WEBVTT\n\n00:00.000 --> 00:02.000\n${text}\n`);

const send = (cookie: string, path: string, files: { name: string; bytes: Uint8Array }[], field = 'files') => {
  const form = new FormData();
  for (const f of files) form.append(field, new File([f.bytes as Uint8Array<ArrayBuffer>], f.name));
  return t.app.request(`/api/v1${path}`, { method: 'POST', headers: { origin: WEB_ORIGIN, cookie }, body: form });
};
const upload = async (name: string, bytes: Uint8Array, cookie = agent) => {
  const res = await send(cookie, '/platform/support/help/assets', [{ name, bytes }], 'file');
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json;
};
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const con = (cookie: string) => t.api(cookie);
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  await mk('Helpers', 'helpers', 'agent@support.test');
  admin = await join('admin@acme.test');
  agent = await join('agent@support.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test', 'lead@support.test'], role: 'member' });
  bob = await join('bob@acme.test');
  lead = await join('lead@support.test');
  await con(owner).post('/platform/support/staff', { email: 'agent@support.test', role: 'agent' });
  await con(owner).post('/platform/support/staff', { email: 'lead@support.test', role: 'lead' });
});
afterAll(() => t.close());

describe('helpers', () => {
  it('sniffs videos and captions by content', () => {
    expect(sniffVideo(mp4())).toBe('video/mp4');
    const webm = new Uint8Array(40);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    webm.set(strToU8('webm'), 20);
    expect(sniffVideo(webm)).toBe('video/webm');
    expect(sniffVideo(png(2, 2))).toBeNull();
    expect(isWebVtt(vtt())).toBe(true);
    expect(isWebVtt(strToU8('﻿WEBVTT\n'))).toBe(true);
    expect(isWebVtt(strToU8('WEBVTTX'))).toBe(false);
  });

  it('embeds only YouTube / Vimeo addresses', () => {
    expect(helpVideoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
    );
    expect(helpVideoEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toContain('/embed/dQw4w9WgXcQ');
    expect(helpVideoEmbedUrl('https://vimeo.com/123456789')).toBe('https://player.vimeo.com/video/123456789');
    expect(helpVideoEmbedUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(helpVideoEmbedUrl('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(helpVideoEmbedUrl('javascript:alert(1)')).toBeNull();
  });

  it('reads chapters and steps of a package', () => {
    expect(parseChapter('1:05 פותחים הגדרות')).toEqual({ at: 65, title: 'פותחים הגדרות' });
    expect(parseChapter('1:02:03 Long')).toEqual({ at: 3723, title: 'Long' });
    expect(parseChapter('90 Ninety')).toEqual({ at: 90, title: 'Ninety' });
    expect(parseChapter('no time')).toBeNull();
    expect(formatChapterTime(65)).toBe('1:05');
    expect(formatChapterTime(3723)).toBe('1:02:03');
    expect(parseStepLine('Open settings | images/a.png | 0.42,0.31')).toEqual({
      text: 'Open settings',
      image: 'images/a.png',
      marker: { x: 0.42, y: 0.31 },
    });
    expect(parseStepLine('Just text')).toEqual({ text: 'Just text', image: null, marker: null });
  });

  it('knows an item card’s screen and the tours list’s', () => {
    expect(helpRouteOf('/a/acme/b/B1/i/I1')).toBe('item');
    expect(helpRouteOf('/a/acme/b/B1')).toBe('board');
    expect(helpRouteOf('/a/acme/tours')).toBe('support');
  });

  it('offers a screen its tours in order, never one done or set to the menu', () => {
    const tour = (id: string, extra: Partial<MyTour>): MyTour => ({
      id,
      title: id,
      route: 'board',
      start: 'offer',
      position: 0,
      steps: [],
      state: null,
      guide_slug: null,
      ...extra,
    });
    const out = toursToOffer(
      [
        tour('b', { position: 2 }),
        tour('a', { position: 1 }),
        tour('done', { state: 'done' }),
        tour('menu', { start: 'menu' }),
        tour('home', { route: 'home' }),
      ],
      'board',
    );
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('practical guides', () => {
  let video: Json;
  let poster: Json;
  let shot: Json;
  let captions: Json;
  let guideId: string;

  it('stores videos and captions (checked by content), serves captions as text', async () => {
    video = await upload('demo.mp4', mp4(1));
    expect(video.content_type).toBe('video/mp4');
    captions = await upload('demo.he.vtt', vtt('שלום עולם'));
    expect(captions.content_type).toBe('text/vtt');
    poster = await upload('poster.png', png(4, 3, 9));
    shot = await upload('shot.png', png(5, 3, 11));
    const bad = await send(
      agent,
      '/platform/support/help/assets',
      [{ name: 'x.mp4', bytes: strToU8('not a video') }],
      'file',
    );
    expect(bad.status).toBe(422);
    expect((await body(bad)).error.message).toBe('help_file_type');
    const cap = await t.app.request(`/api/v1/help/assets/${captions.id}`);
    expect(cap.status).toBe(200);
    expect(cap.headers.get('content-type')).toContain('text/vtt');
    expect(await cap.text()).toContain('שלום עולם');
    const vid = await t.app.request(`/api/v1/help/assets/${video.id}`, { redirect: 'manual' });
    expect(vid.status).toBe(302);
  });

  it('a video is never an image of the rich text', async () => {
    const res = await con(agent).post('/platform/support/help/articles', {
      title: 'Not an image',
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: video.id, alt: 'x' } }] },
    });
    expect(JSON.stringify((await body(res)).content)).not.toContain(video.id);
  });

  it('keeps each file of a guide only in its own place', async () => {
    const res = await con(agent).post('/platform/support/help/articles', {
      title: 'איך מחברים AI',
      slug: 'connect-ai',
      kind: 'guide',
      visibility: 'public',
      guide: {
        video: {
          asset_id: video.id,
          poster_id: video.id, // a video is not a still: dropped
          captions: [
            { locale: 'he', asset_id: captions.id },
            { locale: 'en', asset_id: shot.id }, // an image is not captions: dropped
          ],
          chapters: [
            { at: 40, title: 'Second' },
            { at: 0, title: 'First' },
          ],
          duration: 80,
        },
        steps: [
          { text: 'פותחים את הגדרות AI', image_id: shot.id, marker: { x: 0.4, y: 0.3 } },
          { text: 'מדביקים מפתח', image_id: captions.id }, // captions are not a screenshot: dropped
        ],
      },
    });
    const a = await body(res);
    expect(res.status, JSON.stringify(a)).toBe(201);
    guideId = a.id;
    expect(a.kind).toBe('guide');
    expect(a.guide.video.poster_id).toBeNull();
    expect(a.guide.video.captions).toEqual([{ locale: 'he', asset_id: captions.id }]);
    expect(a.guide.video.chapters.map((c: Json) => c.at)).toEqual([0, 40]);
    expect(a.guide.steps[0].image_id).toBe(shot.id);
    expect(a.guide.steps[1].image_id).toBeNull();
  });

  it('refuses a video address that is not YouTube / Vimeo', async () => {
    const res = await con(agent).patch(`/platform/support/help/articles/${guideId}`, {
      guide: { video: { url: 'https://evil.example/v.mp4' }, steps: [] },
    });
    expect(res.status).toBe(400);
  });

  it('a guide change is a new version; readers see it only once published', async () => {
    const before = await body(await con(agent).get(`/platform/support/help/articles/${guideId}`));
    const res = await con(agent).patch(`/platform/support/help/articles/${guideId}`, {
      guide: { ...before.guide, video: { ...before.guide.video, poster_id: poster.id } },
    });
    const after = await body(res);
    expect(after.version).toBe(before.version + 1);
    expect(after.guide.video.poster_id).toBe(poster.id);
    // Not published yet: no reader.
    expect((await t.app.request('/api/v1/help/articles/connect-ai')).status).toBe(404);
    expect((await con(lead).post(`/platform/support/help/articles/${guideId}/publish`)).status).toBe(200);
    const view = await body(await t.app.request('/api/v1/help/articles/connect-ai'));
    expect(view.kind).toBe('guide');
    expect(view.guide.video.src).toMatch(new RegExp(`/api/v1/help/assets/${video.id}$`));
    expect(view.guide.video.poster).toContain(poster.id);
    expect(view.guide.video.captions[0].src).toContain(captions.id);
    expect(view.guide.steps).toHaveLength(2);
    expect(view.guide.steps[0].marker).toEqual({ x: 0.4, y: 0.3 });
    expect(view.duration).toBe(80);
    expect(view.step_count).toBe(2);
    expect(view.tour_id).toBeNull();
  });

  it('lists guides (the "practical guides" row) and finds them by their steps', async () => {
    const guides = (await body(await as(bob).get('/support/help/search?kind=guide'))).data as Json[];
    expect(guides.map((g) => g.slug)).toContain('connect-ai');
    const g = guides.find((x) => x.slug === 'connect-ai')!;
    expect(g).toMatchObject({ kind: 'guide', duration: 80, step_count: 2 });
    expect(g.poster).toContain(poster.id);
    const hits = (await body(await as(bob).get(`/support/help/search?q=${encodeURIComponent('מדביקים מפתח')}`)))
      .data as Json[];
    expect(hits.map((h) => h.slug)).toContain('connect-ai');
  });

  it('restoring an old version brings its guide back', async () => {
    const versions = (await body(await con(agent).get(`/platform/support/help/articles/${guideId}/versions`)))
      .data as Json[];
    const first = versions.find((v) => v.version === 1)!;
    const restored = await body(
      await con(agent).post(`/platform/support/help/articles/${guideId}/versions/${first.id}/restore`),
    );
    expect(restored.guide.video.poster_id).toBeNull();
  });
});

describe('guided tours', () => {
  let tourId: string;
  const steps = [
    { id: 's1', anchor: 'board.title', title: 'זה בורד', body: 'טבלה של עבודה' },
    { id: 's2', anchor: 'board.new-item', title: 'פריט חדש', wait_click: true },
  ];

  it('writers write tours; strangers get 404', async () => {
    expect((await con(bob).get('/platform/support/help/tours')).status).toBe(404);
    const res = await con(agent).post('/platform/support/help/tours', { title: 'בורד', route: 'board', steps });
    const tour = await body(res);
    expect(res.status, JSON.stringify(tour)).toBe(201);
    tourId = tour.id;
    expect(tour).toMatchObject({ status: 'draft', route: 'board', audience: 'all', start: 'offer', slug: 'בורד' });
    expect(tour.steps).toHaveLength(2);
    expect(tour.steps[1].wait_click).toBe(true);
    const dup = await con(agent).post('/platform/support/help/tours', {
      title: 'x',
      steps: [
        { id: 'a', title: 'one' },
        { id: 'a', title: 'two' },
      ],
    });
    expect(dup.status).toBe(422);
  });

  it('members see only published tours; an agent may not publish', async () => {
    expect((await body(await as(bob).get('/support/tours'))).tours).toEqual([]);
    expect((await con(agent).patch(`/platform/support/help/tours/${tourId}`, { status: 'published' })).status).toBe(
      403,
    );
    expect((await con(lead).patch(`/platform/support/help/tours/${tourId}`, { status: 'published' })).status).toBe(200);
    const mine = await body(await as(bob).get('/support/tours'));
    expect(mine).toMatchObject({ enabled: true, offers: true });
    expect(mine.tours).toHaveLength(1);
    expect(mine.tours[0]).toMatchObject({ id: tourId, route: 'board', state: null, guide_slug: null });
  });

  it('picks a step’s element on the screen', async () => {
    const res = await con(lead).post(`/platform/support/help/tours/${tourId}/anchor`, {
      step_id: 's1',
      anchor: 'board.views',
    });
    expect(res.status).toBe(200);
    expect((await body(res)).steps[0].anchor).toBe('board.views');
    expect(
      (await con(lead).post(`/platform/support/help/tours/${tourId}/anchor`, { step_id: 'nope', anchor: 'x' })).status,
    ).toBe(404);
    expect(
      (await con(lead).post(`/platform/support/help/tours/${tourId}/anchor`, { step_id: 's1', anchor: 'Bad Mark!' }))
        .status,
    ).toBe(400);
  });

  it('records progress per person; "reset all" offers every tour again', async () => {
    expect((await as(bob).put(`/support/tours/${tourId}/progress`, { state: 'done' })).status).toBe(200);
    expect((await body(await as(bob).get('/support/tours'))).tours[0].state).toBe('done');
    // Someone else's progress is their own.
    expect((await body(await as(admin).get('/support/tours'))).tours[0].state).toBeNull();
    expect((await as(bob).del('/support/tours/progress')).status).toBe(200);
    expect((await body(await as(bob).get('/support/tours'))).tours[0].state).toBeNull();
  });

  it('a tour for admins is not offered to members', async () => {
    const res = await con(lead).post('/platform/support/help/tours', {
      title: 'ניהול',
      route: 'admin',
      steps: [{ id: 'a', title: 'הגדרות' }],
    });
    const id = (await body(res)).id;
    await con(lead).patch(`/platform/support/help/tours/${id}`, { status: 'published', audience: 'admins' });
    expect(((await body(await as(bob).get('/support/tours'))).tours as Json[]).map((x) => x.id)).not.toContain(id);
    expect(((await body(await as(admin).get('/support/tours'))).tours as Json[]).map((x) => x.id)).toContain(id);
  });

  it('the person’s own switch and the account’s', async () => {
    expect((await body(await as(bob).put('/support/tours/prefs', { offers: false }))).offers).toBe(false);
    expect((await body(await as(bob).get('/support/tours'))).offers).toBe(false);
    await as(bob).put('/support/tours/prefs', { offers: true });
    // A member may not change the account's settings; its admin may turn tours off.
    expect((await as(bob).patch('/accounts/me', { settings: { tours: { enabled: false } } })).status).toBe(403);
    expect((await as(admin).patch('/accounts/me', { settings: { tours: { enabled: false } } })).status).toBe(200);
    expect(await body(await as(bob).get('/support/tours'))).toMatchObject({ enabled: false, tours: [] });
    await as(admin).patch('/accounts/me', { settings: { tours: { enabled: true } } });
    expect((await body(await as(bob).get('/support/tours'))).enabled).toBe(true);
  });

  it('"show me in the app": a guide links a published tour', async () => {
    const guide = (await body(await con(agent).get('/platform/support/help/articles?kind=guide'))).data[0];
    expect((await con(agent).patch(`/platform/support/help/articles/${guide.id}`, { tour_id: 'nope' })).status).toBe(
      422,
    );
    await con(agent).patch(`/platform/support/help/articles/${guide.id}`, { tour_id: tourId });
    await con(lead).post(`/platform/support/help/articles/${guide.id}/publish`);
    expect((await body(await as(bob).get(`/support/help/articles/${guide.id}`))).tour_id).toBe(tourId);
    // The public help center has no app to show it in.
    expect((await body(await t.app.request(`/api/v1/help/articles/${guide.slug}`))).tour_id).toBeNull();
    // The tour knows its video.
    const mine = (await body(await as(bob).get('/support/tours'))).tours as Json[];
    expect(mine.find((x) => x.id === tourId)!.guide_slug).toBe(guide.slug);
    // A tour taken down is not offered, and the guide's button goes too.
    await con(lead).patch(`/platform/support/help/tours/${tourId}`, { status: 'draft' });
    expect((await body(await as(bob).get(`/support/help/articles/${guide.id}`))).tour_id).toBeNull();
    await con(lead).patch(`/platform/support/help/tours/${tourId}`, { status: 'published' });
  });

  it('guests and support visits get no tours', async () => {
    await as(admin).post('/users/invite', { emails: ['guest@else.test'], role: 'guest' });
    const guest = await join('guest@else.test');
    expect((await as(guest).get('/support/tours')).status).toBe(403);
  });
});

describe('package import / export with guides and tours', () => {
  const md = (lines: string[], text = '') => `---\n${lines.join('\n')}\n---\n${text}\n`;
  const PKG = () =>
    zipSync({
      'tours.json': strToU8(
        JSON.stringify([
          {
            slug: 'automations-tour',
            locale: 'he',
            title: 'אוטומציות',
            route: 'automations',
            start: 'auto',
            publish: true,
            steps: [
              { id: 'one', anchor: 'automations.new', title: 'אוטומציה חדשה', media: 'images/clip.png' },
              { id: 'two', title: 'סיום' },
            ],
          },
        ]),
      ),
      'images/clip.png': png(3, 3, 21),
      'images/s1.png': png(6, 4, 22),
      'images/poster.png': png(6, 4, 23),
      'videos/first.mp4': mp4(31),
      'videos/first.he.vtt': vtt('כתובית'),
      'articles/first-automation.md': strToU8(
        md(
          [
            'title: "אוטומציה ראשונה"',
            'slug: first-automation',
            'locale: he',
            'visibility: public',
            'publish: true',
            'kind: guide',
            'tour: automations-tour',
            'video: videos/first.mp4',
            'poster: images/poster.png',
            'captions_he: videos/first.he.vtt',
            'duration: 90',
            'chapters:',
            '  - "0:00 פותחים"',
            '  - "0:30 בוחרים טריגר"',
            'steps:',
            '  - "לוחצים אוטומציה חדשה | images/s1.png | 0.5,0.25"',
            '  - "שומרים"',
          ],
          'עוד הסבר.',
        ),
      ),
    });

  it('imports tours and guides (preview first), and again changes nothing', async () => {
    const preview = await body(
      await send(lead, '/platform/support/help/import?dry_run=1', [{ name: 'p.zip', bytes: PKG() }]),
    );
    expect(preview.tours).toMatchObject({ new: 1, errors: 0 });
    expect(preview.counts.new).toBe(1);
    expect(
      (await body(await con(lead).get('/platform/support/help/tours'))).data.map((x: Json) => x.slug),
    ).not.toContain('automations-tour');
    const res = await send(lead, '/platform/support/help/import', [{ name: 'p.zip', bytes: PKG() }]);
    const r = await body(res);
    expect(res.status, JSON.stringify(r)).toBe(200);
    expect(r.tours).toMatchObject({ new: 1, errors: 0 });
    expect(r.counts).toMatchObject({ new: 1, errors: 0, published: 1 });
    expect(r.files[0].warnings).toEqual([]);
    const tours = (await body(await con(lead).get('/platform/support/help/tours'))).data as Json[];
    const tour = tours.find((x) => x.slug === 'automations-tour')!;
    expect(tour).toMatchObject({ status: 'published', start: 'auto', route: 'automations' });
    expect(tour.steps[0].media_id).toBeTruthy();
    const view = await body(await as(bob).get('/support/help/articles/first-automation'));
    expect(view.tour_id).toBe(tour.id);
    expect(view.guide.video.chapters).toEqual([
      { at: 0, title: 'פותחים' },
      { at: 30, title: 'בוחרים טריגר' },
    ]);
    expect(view.guide.video.captions).toHaveLength(1);
    expect(view.guide.steps[0]).toMatchObject({ text: 'לוחצים אוטומציה חדשה', marker: { x: 0.5, y: 0.25 } });
    expect(view.guide.steps[1].image).toBeNull();
    const again = await body(await send(lead, '/platform/support/help/import', [{ name: 'p.zip', bytes: PKG() }]));
    expect(again.tours).toMatchObject({ new: 0, updated: 0, unchanged: 1 });
    expect(again.counts).toMatchObject({ new: 0, updated: 0, unchanged: 1 });
  });

  it('exports tours and guides in a package the import reads back unchanged', async () => {
    const res = await con(lead).get('/platform/support/help/export');
    expect(res.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(zip);
    expect(names).toContain('tours.json');
    expect(names.some((n) => n.startsWith('videos/') && n.endsWith('.mp4'))).toBe(true);
    expect(names.some((n) => n.startsWith('videos/') && n.endsWith('.vtt'))).toBe(true);
    const guide = new TextDecoder().decode(zip['articles/he/first-automation.md']!);
    expect(guide).toContain('kind: guide');
    expect(guide).toContain('tour: automations-tour');
    expect(guide).toContain('"0:30 בוחרים טריגר"');
    const back = await body(
      await send(lead, '/platform/support/help/import', [
        {
          name: 'export.zip',
          bytes: new Uint8Array(await (await con(lead).get('/platform/support/help/export')).arrayBuffer()),
        },
      ]),
    );
    expect(back.counts.errors).toBe(0);
    expect(back.tours.errors).toBe(0);
    expect(back.counts.new).toBe(0);
    expect(back.tours.new).toBe(0);
    const firstAutomation = (back.files as Json[]).find((f) => f.slug === 'first-automation')!;
    expect(firstAutomation.outcome).toBe('unchanged');
  });
});
