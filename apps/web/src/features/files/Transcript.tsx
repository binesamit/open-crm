// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useSyncExternalStore } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FileTranscript, t } from '@bines/shared';
import { Button } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { transcribe, useVoice } from './voice-api';

export const transcriptKey = (accountId: string, fileId: string) =>
  ['account', accountId, 'file', fileId, 'transcript'] as const;

/**
 * Files being transcribed by "transcribe all": each file's panel shows its own progress, as when it
 * was asked for alone.
 */
const pending = new Set<string>();
const listeners = new Set<() => void>();
const setPending = (fileId: string, on: boolean) => {
  if (on) pending.add(fileId);
  else pending.delete(fileId);
  for (const l of listeners) l();
};
const usePending = (fileId: string) =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending.has(fileId),
  );

/** At most this many files are sent to the provider at once (each request waits for its text). */
export const TRANSCRIBE_ALL_PARALLEL = 2;

/**
 * Runs `work` on every id, `limit` at a time, in order of start; resolves with the ids that failed and the first
 * error (the others still run).
 */
export const runLimited = async (ids: string[], limit: number, work: (id: string) => Promise<unknown>) => {
  const failed: string[] = [];
  let firstError: unknown = null;
  let next = 0;
  const lane = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try {
        await work(id);
      } catch (e) {
        failed.push(id);
        firstError ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, lane));
  return { failed, firstError };
};

/**
 * Prod (product owner: "an update with several recordings — transcribe them all with one click"): above an update's
 * audio / video, "transcribe all (N)" when 2+ of them have no text yet. Each file goes through the same request as its
 * own "transcribe" (the same rights, AI usage and kept text — one already transcribed is never charged again), a few
 * at a time; each file shows its progress in its own place.
 */
export const TranscribeAll = ({ accountId, fileIds }: { accountId: string; fileIds: string[] }) => {
  const qc = useQueryClient();
  const voice = useVoice(accountId);
  // The same queries the files' panels read (shared cache): which ones have no text yet.
  const states = useQueries({
    queries: fileIds.map((id) => ({
      queryKey: transcriptKey(accountId, id),
      queryFn: () => api(accountId).get<FileTranscript>(`/files/${id}/transcript`),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const todo = fileIds.filter((_, i) => states[i]?.data && states[i]!.data!.transcript === null);
  if (!voice?.transcription || (!running && todo.length < 2)) return null;
  const start = async () => {
    const ids = [...todo];
    setRunning({ done: 0, total: ids.length });
    const { failed, firstError } = await runLimited(ids, TRANSCRIBE_ALL_PARALLEL, async (id) => {
      setPending(id, true);
      try {
        await transcribe(accountId, id);
      } finally {
        setPending(id, false);
        setRunning((r) => (r ? { ...r, done: r.done + 1 } : r));
        await qc.invalidateQueries({ queryKey: transcriptKey(accountId, id) });
      }
    });
    setRunning(null);
    if (failed.length)
      showToast({
        message: t('voice.transcribeAllFailed', { n: failed.length, reason: errorMessage(firstError) }),
        tone: 'error',
        seconds: 10,
      });
  };
  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={!!running}
      data-testid="media-transcribe-all"
      className="self-start rounded-[6px] px-1 text-xs text-primary hover:underline disabled:opacity-60"
    >
      {running
        ? t('voice.transcribingAll', { done: running.done, n: running.total })
        : t('voice.transcribeAll', { n: todo.length })}
    </button>
  );
};

/**
 * An audio / video file's text (product owner: only when asked, not right after recording): "transcribe"
 * runs it once on request (an AI cost), the text is kept on the file and shows here for everyone who may read it;
 * whoever may edit what holds the file (the update's author, the cell's editors) may correct it.
 */
export const TranscriptPanel = ({ accountId, fileId }: { accountId: string; fileId: string }) => {
  const qc = useQueryClient();
  const voice = useVoice(accountId);
  const key = transcriptKey(accountId, fileId);
  const q = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<FileTranscript>(`/files/${fileId}/transcript`),
    staleTime: 60_000,
    // A guest / a file this person may not read: nothing to show (and nothing to retry).
    retry: false,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const inAll = usePending(fileId);
  const run = useMutation({
    mutationFn: () => transcribe(accountId, fileId),
    onSuccess: async (out) => {
      if (!out.text) showToast({ message: t('voice.empty') });
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error', seconds: 10 }),
  });
  const save = useMutation({
    mutationFn: (text: string) => api(accountId).patch<FileTranscript>(`/files/${fileId}/transcript`, { text }),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      setDraft(null);
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const data = q.data;
  if (!data) return null;
  const text = data.transcript?.text ?? null;

  if (text === null)
    return voice?.transcription ? (
      <button
        type="button"
        onClick={() => run.mutate()}
        disabled={run.isPending || inAll}
        data-testid="media-transcribe"
        className="self-start rounded-[6px] px-1 text-xs text-primary hover:underline disabled:opacity-60"
      >
        {run.isPending || inAll ? t('voice.transcribing') : t('voice.transcribe')}
      </button>
    ) : null;

  return (
    <figure className="flex flex-col gap-1 rounded-[10px] bg-surface-2 p-2 text-sm" data-testid="media-transcript">
      <figcaption className="flex items-center justify-between gap-2 text-xs text-muted">
        <span>
          {t('voice.transcript')}
          {data.transcript?.edited_at ? ` • ${t('voice.edited')}` : ''}
        </span>
        <span className="flex items-center gap-0.5">
          {data.can_edit && draft === null ? (
            <button
              type="button"
              onClick={() => setDraft(text)}
              aria-label={t('voice.editTranscript')}
              title={t('voice.editTranscript')}
              data-testid="media-transcript-edit"
              className="grid size-6 place-items-center rounded-full hover:bg-surface-3"
            >
              <Icon name="edit" size={13} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => copyText(text)}
            aria-label={t('voice.copy')}
            title={t('voice.copy')}
            className="grid size-6 place-items-center rounded-full hover:bg-surface-3"
          >
            <Icon name="copy" size={13} />
          </button>
        </span>
      </figcaption>
      {draft !== null ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            dir="auto"
            rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
            aria-label={t('voice.editTranscript')}
            data-testid="media-transcript-input"
            className="w-full resize-y rounded-[8px] border border-line bg-surface px-2 py-1.5 text-sm text-fg focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={save.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              variant="accent"
              busy={save.isPending}
              disabled={draft === text}
              onClick={() => save.mutate(draft)}
              data-testid="media-transcript-save"
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap" dir="auto" data-testid="media-transcript-text">
          {text}
        </p>
      )}
    </figure>
  );
};
