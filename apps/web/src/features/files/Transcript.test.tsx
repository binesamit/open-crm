// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTranscript } from '@bines/shared';

/**
 * A recording's text (product owner: only when asked): "transcribe" runs only on a click, the kept text shows
 * under the player, and whoever may edit its holder corrects it in place.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stored: FileTranscript;
let transcription = true;
const calls: string[] = [];
vi.mock('../../lib/api', () => ({
  api: () => ({
    get: async (path: string) => {
      if (path === '/voice') return { recording: true, max_seconds: 600, transcription, auto: false };
      return stored;
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      stored = {
        ...stored,
        transcript: { text: 'שלום מההקלטה', model: 'stt', created_at: '2026-10-15T00:00:00Z', edited_at: null },
      };
      return { text: 'שלום מההקלטה', model: 'stt', cost_usd: 0.01 };
    },
    patch: async (path: string, body: { text: string }) => {
      calls.push(`PATCH ${path} ${body.text}`);
      stored = {
        ...stored,
        transcript: { ...stored.transcript!, text: body.text, edited_at: '2026-10-15T00:01:00Z' },
      };
      return stored;
    },
  }),
  errorMessage: String,
}));
vi.mock('../../lib/toast', () => ({ showToast: () => undefined }));
vi.mock('../../lib/entity-menu', () => ({ copyText: () => undefined }));

const { TranscriptPanel } = await import('./Transcript');

let root: Root | null = null;
let host: HTMLDivElement;
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const mount = async (initial: FileTranscript, canTranscribe = true) => {
  stored = initial;
  transcription = canTranscribe;
  calls.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TranscriptPanel, { accountId: 'A1', fileId: 'F1' }),
      ),
    ),
  );
  await flush();
};
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('transcript under a recording', () => {
  it('nothing runs by itself: a "transcribe" button, and its text only after the click', async () => {
    await mount({ transcript: null, can_edit: true });
    expect(calls).toEqual([]);
    expect($('media-transcript')).toBeNull();
    await act(async () => $('media-transcribe')!.click());
    await flush();
    expect(calls).toEqual(['POST /files/F1/transcribe']);
    expect($('media-transcript-text')!.textContent).toBe('שלום מההקלטה');
  });

  it('no button when the account does not transcribe (or for a guest)', async () => {
    await mount({ transcript: null, can_edit: false }, false);
    expect($('media-transcribe')).toBeNull();
  });

  it('a kept transcript shows for readers; an editor corrects it in place', async () => {
    await mount({
      transcript: { text: 'טקסט עם טעות', model: 'stt', created_at: '2026-10-15T00:00:00Z', edited_at: null },
      can_edit: true,
    });
    expect($('media-transcript-text')!.textContent).toBe('טקסט עם טעות');
    await act(async () => $('media-transcript-edit')!.click());
    const input = $('media-transcript-input') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'טקסט מתוקן');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => $('media-transcript-save')!.click());
    await flush();
    expect(calls).toEqual(['PATCH /files/F1/transcript טקסט מתוקן']);
    expect($('media-transcript-text')!.textContent).toBe('טקסט מתוקן');
  });

  it('a reader who may not edit sees no pencil', async () => {
    await mount({
      transcript: { text: 'טקסט', model: null, created_at: '2026-10-15T00:00:00Z', edited_at: null },
      can_edit: false,
    });
    expect($('media-transcript-edit')).toBeNull();
  });
});
