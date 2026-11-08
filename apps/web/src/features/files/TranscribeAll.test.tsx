// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../../lib/api';
import type * as VoiceModule from './voice-api';

/**
 * "transcribe all (N)" above an update's recordings when 2+ have no text; each file goes through its
 * own transcribe request (a few at a time), shows its own progress, and failures are reported once.
 */
const get = vi.fn();
const transcribe = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ get, post: vi.fn(), patch: vi.fn() }),
}));
vi.mock('./voice-api', async (orig) => ({
  ...(await orig<typeof VoiceModule>()),
  useVoice: () => ({ recording: true, max_seconds: 300, transcription: true, auto: false }),
  transcribe: (...a: unknown[]) => transcribe(...a),
}));
const toast = vi.fn();
vi.mock('../../lib/toast', () => ({ showToast: (...a: unknown[]) => toast(...a) }));

const { TranscribeAll, TranscriptPanel, runLimited } = await import('./Transcript');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Files a, b, c have no text; d does. */
let texts: Record<string, string | null>;
let root: Root | null = null;
beforeEach(() => {
  texts = { a: null, b: null, c: null, d: 'שלום' };
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    const id = path.split('/')[2]!;
    const text = texts[id] ?? null;
    return { transcript: text === null ? null : { text, model: 'm', created_at: '', edited_at: null }, can_edit: true };
  });
  transcribe.mockReset();
  toast.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const render = async (ids: string[]) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const qc = new QueryClient();
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TranscribeAll, { accountId: 'acc', fileIds: ids }),
        ...ids.map((id) => createElement(TranscriptPanel, { key: id, accountId: 'acc', fileId: id })),
      ),
    );
  });
  await flush();
};
const $ = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe('transcribe all', () => {
  it('shows for 2+ files without text, counting only those', async () => {
    await render(['a', 'b', 'd']);
    expect($('media-transcribe-all')!.textContent).toBe('תמלול הכל (2)');
  });

  it('hides with fewer than 2 files without text', async () => {
    await render(['a', 'd']);
    expect($('media-transcribe-all')).toBeNull();
  });

  it('transcribes only the files without text, at most 2 at once; each shows its progress', async () => {
    const waiting: Array<() => void> = [];
    let inFlight = 0;
    let most = 0;
    transcribe.mockImplementation(async (_acc: string, id: string) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise<void>((r) => waiting.push(r));
      inFlight--;
      texts[id] = `טקסט ${id}`;
      return { text: texts[id], model: 'm', cost_usd: 0 };
    });
    await render(['a', 'b', 'c', 'd']);
    await act(async () => $('media-transcribe-all')!.click());
    await flush();
    // Two requests are out; their files say "transcribing…", the button counts.
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect($('media-transcribe-all')!.textContent).toBe('מתמללים… 0/3');
    expect(all('media-transcribe').filter((b) => b.textContent === 'מתמלל…')).toHaveLength(2);
    while (waiting.length) {
      await act(async () => waiting.shift()!());
      await flush();
    }
    expect(transcribe.mock.calls.map((c) => c[1])).toEqual(['a', 'b', 'c']);
    expect(most).toBe(2);
    expect(all('media-transcript-text').map((p) => p.textContent)).toEqual(['טקסט a', 'טקסט b', 'טקסט c', 'שלום']);
    expect($('media-transcribe-all')).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('a failure does not stop the others and is reported once', async () => {
    transcribe.mockImplementation(async (_acc: string, id: string) => {
      if (id === 'b') throw new Error('provider down');
      texts[id] = 'ok';
      return { text: 'ok', model: 'm', cost_usd: 0 };
    });
    await render(['a', 'b', 'c']);
    await act(async () => $('media-transcribe-all')!.click());
    await flush();
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(toast).toHaveBeenCalledOnce();
    expect(String(toast.mock.calls[0]![0].message)).toContain('1');
  });
});

describe('runLimited', () => {
  it('runs every id, keeps going after a failure, returns the failed ones', async () => {
    const seen: string[] = [];
    const out = await runLimited(['x', 'y', 'z'], 2, async (id) => {
      seen.push(id);
      if (id === 'y') throw new Error('no');
    });
    expect(seen).toEqual(['x', 'y', 'z']);
    expect(out.failed).toEqual(['y']);
    expect((out.firstError as Error).message).toBe('no');
  });
});
