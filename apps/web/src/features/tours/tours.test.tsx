// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type HelpGuideView, type Me, type MyAccount, type MyTour, type MyTours } from '@bines/shared';

/**
 * Guided tours and practical guides in the app: the running tour (steps, the lit
 * element, "wait for a click", finish / skip), the offer card, the host (offer on a first visit, start by itself,
 * the person's switch, a tour waiting for its screen) and a guide's chapters and steps.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let path = '/a/studio/b/B1';
const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: path } }),
  Link: ({ children, params: _p, ...rest }: { children: ReactNode } & Record<string, unknown>) =>
    createElement('a', rest, children),
}));

let data: MyTours | undefined;
const setState = vi.fn();
const setOffers = vi.fn(async () => undefined);
vi.mock('./tours-api', () => ({
  useMyTours: () => ({ data, isPending: !data, isError: false }),
  useTourActions: () => ({ setState, setOffers, resetAll: vi.fn() }),
  tourKeys: { mine: (id: string) => ['account', id, 'tours'] },
  fetchConsoleTour: vi.fn(),
}));

const { TourRunner } = await import('./TourRunner');
const { TourOffer, tourTime } = await import('./TourOffer');
const { TourHost } = await import('./TourHost');
const store = await import('./tour-store');
const { GuideView, clock, guideMeta } = await import('../support/GuideView');

const me = { user: { id: 'u1', name: 'Dana' } } as unknown as Me;
const account = { id: 'A1', slug: 'studio', role: 'member', status: 'active' } as unknown as MyAccount;
const tour = (over: Partial<MyTour> = {}): MyTour => ({
  id: 'T1',
  title: 'בורד',
  route: 'board',
  start: 'offer',
  position: 0,
  state: null,
  guide_slug: null,
  steps: [
    {
      id: 'a',
      anchor: 'board.title',
      title: 'זה בורד',
      body: 'טבלה',
      media_id: null,
      wait_click: false,
      wait_event: null,
      media: null,
      media_type: null,
    },
    {
      id: 'b',
      anchor: null,
      title: 'סיום',
      body: '',
      media_id: null,
      wait_click: false,
      wait_event: null,
      media: null,
      media_type: null,
    },
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement;
const render = async (el: ReactNode) => {
  await act(async () => root!.render(el));
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  expect(el).toBeTruthy();
  await act(async () => el!.click());
};

beforeEach(() => {
  path = '/a/studio/b/B1';
  data = undefined;
  navigate.mockReset();
  setState.mockReset();
  setOffers.mockClear();
  store.stopTour();
  store.setPendingTour(null);
  localStorage.clear();
  // happy-dom lays nothing out: every element counts as on the screen.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.querySelectorAll('[data-tour]').forEach((el) => el.remove());
  vi.restoreAllMocks();
});

const anchor = (key: string) => {
  const el = document.createElement('button');
  el.dataset.tour = key;
  el.textContent = key;
  document.body.appendChild(el);
  return el;
};

describe('TourRunner', () => {
  it('lights the element, counts the steps, goes on and finishes', async () => {
    anchor('board.title');
    const onEnd = vi.fn();
    store.startTour(tour());
    await render(
      createElement(() => {
        const run = store.useRunningTour();
        return run ? createElement(TourRunner, { run, onEnd }) : null;
      }),
    );
    expect($('tour-spotlight')).toBeTruthy();
    expect($('tour-count')!.textContent).toBe(t('tour.count', { title: 'בורד', n: 1, total: 2 }));
    expect($('tour-back')).toBeNull();
    await click($('tour-next'));
    expect($('tour-count')!.textContent).toBe(t('tour.count', { title: 'בורד', n: 2, total: 2 }));
    // No element: the bubble stands in the middle, over a full dimming.
    expect($('tour-spotlight')).toBeNull();
    expect($('tour-skip')).toBeNull();
    await click($('tour-back'));
    expect(store.runningTour()!.step).toBe(0);
    await click($('tour-next'));
    await click($('tour-finish'));
    expect(onEnd).toHaveBeenCalledWith('done');
  });

  it('skip and Esc close it as dismissed', async () => {
    anchor('board.title');
    const onEnd = vi.fn();
    store.startTour(tour());
    await render(createElement(TourRunner, { run: store.runningTour()!, onEnd }));
    await click($('tour-skip'));
    expect(onEnd).toHaveBeenLastCalledWith('dismissed');
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it('"wait for a click": no next button; a click on the element goes on', async () => {
    const el = anchor('board.title');
    store.startTour(tour({ steps: [{ ...tour().steps[0]!, wait_click: true }, tour().steps[1]!] }));
    await render(
      createElement(() => {
        const run = store.useRunningTour();
        return run ? createElement(TourRunner, { run, onEnd: vi.fn() }) : null;
      }),
    );
    expect($('tour-next')).toBeNull();
    expect($('tour-wait')).toBeTruthy();
    await act(async () => el.click());
    expect(store.runningTour()!.step).toBe(1);
  });

  it('offers the guide’s video on the last step', async () => {
    const onGuide = vi.fn();
    store.startTour(tour({ guide_slug: 'board-guide' }));
    store.goToStep(1);
    await render(createElement(TourRunner, { run: store.runningTour()!, onEnd: vi.fn(), onGuide }));
    await click($('tour-guide'));
    expect(onGuide).toHaveBeenCalledWith('board-guide');
  });
});

describe('TourOffer', () => {
  it('starts, says "not now", or turns the offers off', async () => {
    const onStart = vi.fn();
    const onLater = vi.fn();
    const onNoMore = vi.fn();
    await render(createElement(TourOffer, { tour: tour(), onStart, onLater, onNoMore }));
    expect($('tour-offer')!.textContent).toContain(t('tour.offer.title', { title: 'בורד' }));
    expect($('tour-offer')!.textContent).toContain(tourTime(2));
    await click($('tour-offer-start'));
    expect(onStart).toHaveBeenCalled();
    await click($('tour-offer-later'));
    expect(onLater).toHaveBeenCalled();
    await click($('tour-offer-nomore'));
    await click($('tour-offer-close'));
    expect(onNoMore).toHaveBeenCalled();
  });

  it('says how long a tour takes', () => {
    expect(tourTime(4)).toBe(t('tour.seconds', { n: 40 }));
    expect(tourTime(6)).toBe(t('tour.minute'));
    expect(tourTime(12)).toBe(t('tour.minutes', { n: 2 }));
  });
});

describe('TourHost', () => {
  const tours = (over: Partial<MyTours> = {}, list = [tour()]): MyTours => ({
    enabled: true,
    offers: true,
    tours: list,
    ...over,
  });

  it('offers the screen’s tour once; starting it runs it, finishing records it', async () => {
    anchor('board.title');
    data = tours();
    await render(createElement(TourHost, { me, account }));
    expect($('tour-offer')).toBeTruthy();
    await click($('tour-offer-start'));
    expect($('tour-offer')).toBeNull();
    expect($('tour-bubble')).toBeTruthy();
    await click($('tour-next'));
    await click($('tour-finish'));
    expect(setState).toHaveBeenCalledWith('T1', 'done');
    expect($('tour')).toBeNull();
    expect($('tour-offer')).toBeNull();
  });

  it('"not now" marks it seen; another screen offers nothing', async () => {
    data = tours();
    await render(createElement(TourHost, { me, account }));
    await click($('tour-offer-later'));
    expect(setState).toHaveBeenCalledWith('T1', 'dismissed');
    expect($('tour-offer')).toBeNull();
  });

  it('no offer when the person turned offers off, a tour is done, or it is on another screen', async () => {
    data = tours({ offers: false });
    await render(createElement(TourHost, { me, account }));
    expect($('tour-offer')).toBeNull();
    data = tours({}, [tour({ state: 'done' })]);
    await render(createElement(TourHost, { me, account: { ...account } }));
    expect($('tour-offer')).toBeNull();
    path = '/a/studio';
    data = tours();
    await render(createElement(TourHost, { me, account: { ...account, name: 'x' } as MyAccount }));
    expect($('tour-offer')).toBeNull();
  });

  it('a tour set to start by itself starts', async () => {
    anchor('board.title');
    data = tours({}, [tour({ start: 'auto' })]);
    await render(createElement(TourHost, { me, account }));
    expect($('tour-offer')).toBeNull();
    expect($('tour-bubble')).toBeTruthy();
  });

  it('a tour that waited for its screen starts there', async () => {
    anchor('board.title');
    store.setPendingTour('T1');
    path = '/a/studio';
    data = tours({}, [tour({ state: 'done' })]);
    await render(createElement(TourHost, { me, account }));
    expect($('tour-bubble')).toBeNull();
    path = '/a/studio/b/B2';
    await render(createElement(TourHost, { me, account: { ...account } }));
    expect($('tour-bubble')).toBeTruthy();
    expect(store.pendingTour()).toBeNull();
  });

  it('nothing for guests', async () => {
    data = tours();
    await render(createElement(TourHost, { me, account: { ...account, role: 'guest' } as MyAccount }));
    expect($('tour-offer')).toBeNull();
  });
});

describe('GuideView', () => {
  const guide: HelpGuideView = {
    video: {
      src: '/api/v1/help/assets/V1',
      embed_url: null,
      poster: '/api/v1/help/assets/P1',
      captions: [{ locale: 'he', src: '/api/v1/help/assets/C1' }],
      chapters: [
        { at: 0, title: 'פתיחה' },
        { at: 65, title: 'מפתח' },
      ],
      duration: 80,
    },
    steps: [
      { text: 'פותחים הגדרות', image: '/api/v1/help/assets/S1', marker: { x: 0.25, y: 0.5 } },
      { text: 'שומרים', image: null, marker: null },
    ],
  };

  it('shows the video with captions, its chapters and the numbered steps with their markers', async () => {
    await render(createElement(GuideView, { guide }));
    const video = $('guide-video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/v1/help/assets/V1');
    expect(video.querySelector('track')!.getAttribute('srclang')).toBe('he');
    expect(document.querySelectorAll('[data-testid="guide-chapter"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-testid="guide-step"]')).toHaveLength(2);
    const marker = $('guide-marker')!;
    expect(marker.style.left).toBe('25%');
    expect(marker.style.top).toBe('50%');
    await click(document.querySelectorAll<HTMLElement>('[data-testid="guide-chapter"]')[1]!);
    expect(video.currentTime).toBe(65);
  });

  it('plays a YouTube / Vimeo video in its player', async () => {
    await render(
      createElement(GuideView, {
        guide: { ...guide, video: { ...guide.video!, src: null, embed_url: '/embed/video-1' } },
      }),
    );
    expect($('guide-embed')!.getAttribute('src')).toBe('/embed/video-1');
    expect($('guide-video')).toBeNull();
  });

  it('formats times and the guide line', () => {
    expect(clock(65)).toBe('1:05');
    expect(clock(3723)).toBe('1:02:03');
    expect(guideMeta(80, 4)).toBe(`${t('guide.meta.video', { time: '1:20' })} · ${t('guide.meta.steps', { n: 4 })}`);
    expect(guideMeta(null, 1)).toBe(t('guide.meta.step'));
  });
});

describe('the console’s picker hand-off', () => {
  it('keeps a pick request for a while, and drops a stale one', () => {
    store.setAuthorMode({ mode: 'pick', tourId: 'T1', stepId: 'a', title: 'x' });
    expect(store.readAuthorMode()).toMatchObject({ mode: 'pick', tourId: 'T1', stepId: 'a' });
    localStorage.setItem(
      'bos.tour.author',
      JSON.stringify({ mode: 'pick', tourId: 'T1', at: Date.now() - 31 * 60_000 }),
    );
    expect(store.readAuthorMode()).toBeNull();
    localStorage.setItem('bos.tour.author', '{broken');
    expect(store.readAuthorMode()).toBeNull();
  });
});
