// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_REVOKED, type StreamEvent } from '@bines/shared';
import { useEventStream } from './realtime';

/**
 * Audit 2026-10-10 web #6: a `revoked` channel leaves the registry at once, so a later subscriber to the same
 * path (access re-granted) opens a fresh stream instead of finding the dead one while an old listener still
 * hangs on it.
 */
class FakeSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeSource[] = [];
  readyState = 1;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSource.instances.push(this);
  }
  close() {
    this.readyState = 2;
  }
  deliver(e: StreamEvent) {
    this.onmessage?.({ data: JSON.stringify(e), lastEventId: '' } as MessageEvent<string>);
  }
}

const Listener = ({ path, onEvent }: { path: string; onEvent: (e: StreamEvent) => void }) => {
  useEventStream(path, 'acc', onEvent);
  return null;
};

let roots: { root: Root; host: HTMLDivElement }[] = [];
const mount = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  roots.push({ root, host });
  return root;
};

beforeEach(() => {
  FakeSource.instances = [];
  vi.stubGlobal('EventSource', FakeSource);
});
afterEach(() => {
  for (const r of roots) {
    act(() => r.root.unmount());
    r.host.remove();
  }
  roots = [];
  vi.unstubAllGlobals();
});

describe('useEventStream after `revoked`', () => {
  it('a new subscriber to the same path opens a fresh stream while the old listener is still mounted', () => {
    const seen: StreamEvent[] = [];
    mount(createElement(Listener, { path: '/boards/b1/events', onEvent: (e) => seen.push(e) }));
    expect(FakeSource.instances).toHaveLength(1);
    act(() => FakeSource.instances[0]!.deliver({ type: STREAM_REVOKED } as StreamEvent));
    expect(seen.map((e) => e.type)).toEqual([STREAM_REVOKED]);
    expect(FakeSource.instances[0]!.readyState).toBe(2);

    // Access re-granted, another component (the board page) subscribes: not the dead channel.
    const later: StreamEvent[] = [];
    mount(createElement(Listener, { path: '/boards/b1/events', onEvent: (e) => later.push(e) }));
    expect(FakeSource.instances).toHaveLength(2);
    act(() => FakeSource.instances[1]!.deliver({ type: 'item.created' } as StreamEvent));
    expect(later.map((e) => e.type)).toEqual(['item.created']);
    // The old listener is not on the new stream.
    expect(seen.map((e) => e.type)).toEqual([STREAM_REVOKED]);
  });

  it('two listeners still share one stream, and the last one leaving closes it', () => {
    const a = mount(createElement(Listener, { path: '/me/events', onEvent: () => undefined }));
    mount(createElement(Listener, { path: '/me/events', onEvent: () => undefined }));
    expect(FakeSource.instances).toHaveLength(1);
    act(() => a.unmount());
    expect(FakeSource.instances[0]!.readyState).toBe(1);
  });
});
