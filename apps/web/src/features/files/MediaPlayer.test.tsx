// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMediaTime, MediaPlayer, readMediaPrefs } from './MediaPlayer';

/** the app's own audio / video player. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const render = (kind: 'audio' | 'video') =>
  act(() => root!.render(createElement(MediaPlayer, { src: 'https://storage.test/a', kind, name: 'a' })));
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe('formatMediaTime', () => {
  it('m:ss, h:mm:ss, and 0:00 for nonsense', () => {
    expect(formatMediaTime(65)).toBe('1:05');
    expect(formatMediaTime(3723)).toBe('1:02:03');
    expect(formatMediaTime(Number.NaN)).toBe('0:00');
  });
});

describe('MediaPlayer', () => {
  it('play asks the element to play; the element’s events drive the state', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render('audio');
    expect(q('media-player').dataset.state).toBe('paused');
    act(() => q('media-play').click());
    expect(play).toHaveBeenCalled();
    act(() => void document.querySelector('audio')!.dispatchEvent(new Event('play')));
    expect(q('media-player').dataset.state).toBe('playing');
  });

  it('a chosen speed applies and is remembered on the device', () => {
    render('video');
    act(() => q('media-speed').click());
    act(() => q('media-speed-1.5').click());
    expect(document.querySelector('video')!.playbackRate).toBe(1.5);
    expect(readMediaPrefs().rate).toBe(1.5);
    expect(q('media-speed').textContent).toBe('×1.5');
  });

  it('mute toggles and is remembered; video has full screen, audio does not', () => {
    render('video');
    expect(q('media-fullscreen')).toBeTruthy();
    act(() => q('media-mute').click());
    expect(document.querySelector('video')!.muted).toBe(true);
    expect(readMediaPrefs().muted).toBe(true);
    render('audio');
    expect(document.querySelector('[data-testid="media-fullscreen"]')).toBeNull();
  });

  it('a file the browser cannot play says so', () => {
    render('audio');
    act(() => void document.querySelector('audio')!.dispatchEvent(new Event('error')));
    expect(q('media-player-failed')).toBeTruthy();
  });
});
