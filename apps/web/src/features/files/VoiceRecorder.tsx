// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { t } from '@bines/shared';
import { Button, cn } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { formatMediaTime } from './MediaPlayer';

/**
 * Recording a voice message: never by itself — the person presses the microphone to start and "stop" to
 * finish (or ✕ to drop it). While it records, a red dot, the time out of the account's longest length and the
 * microphone's level show; at the longest length it stops by itself. The result is an ordinary audio file
 * (`onDone`), uploaded and attached like any other.
 */

/** The best container this browser records to (WebM / Opus in Chromium and Firefox, MP4 in Safari). */
export const pickRecordingType = (supported: (type: string) => boolean): string | null =>
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(supported) ?? null;

/** The file's extension for a recorded type. */
export const recordingExtension = (mime: string) =>
  mime.startsWith('audio/mp4') ? 'm4a' : mime.startsWith('audio/ogg') ? 'ogg' : 'webm';

/** "הקלטה 2026-10-14 13-05.webm" — sortable, no characters a file system refuses. */
export const recordingName = (mime: string, at = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`;
  return `${t('voice.fileName', { date })}.${recordingExtension(mime)}`;
};

/** Why the microphone could not be opened → the explanation to show. */
export const micProblem = (err: unknown): 'voice.micDeniedHow' | 'voice.micMissing' | 'voice.micBusy' => {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'voice.micMissing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'voice.micBusy';
  return 'voice.micDeniedHow';
};

/** Milliseconds since the page opened (the recording's own clock). */
const clock = () => performance.now();

const canRecord = () =>
  typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

type Session = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  audio: AudioContext | null;
  frame: number;
  timer: ReturnType<typeof setInterval>;
  started: number;
  cancelled: boolean;
};

export const VoiceRecorder = ({
  maxSeconds,
  disabled,
  onDone,
}: {
  maxSeconds: number;
  disabled?: boolean;
  onDone: (file: File) => void;
}) => {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const session = useRef<Session | null>(null);

  const release = (s: Session) => {
    clearInterval(s.timer);
    cancelAnimationFrame(s.frame);
    s.stream.getTracks().forEach((tr) => tr.stop());
    void s.audio?.close().catch(() => undefined);
  };
  // Leaving the composer while recording drops the recording and frees the microphone.
  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.cancelled = true;
      if (s.recorder.state !== 'inactive') s.recorder.stop();
      release(s);
    },
    [],
  );

  const stop = (cancelled = false) => {
    const s = session.current;
    if (!s) return;
    s.cancelled = cancelled;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
    release(s);
    setRecording(false);
    setLevel(0);
  };

  const start = async () => {
    if (!canRecord()) return void showToast({ message: t('voice.unsupported'), tone: 'error' });
    let stream: MediaStream;
    try {
      // Straight from the press (the browser asks the person for the microphone the first time).
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // round 2: refused (now or earlier) / no microphone — our own dialog says how to allow it; "try
      // again" asks the browser once more (a new press).
      const again = await confirmDialog({
        title: t('voice.micTitle'),
        message: t(micProblem(err)),
        confirmLabel: t('voice.tryAgain'),
      });
      if (again) void start();
      return;
    }
    const type = pickRecordingType((x) => MediaRecorder.isTypeSupported(x));
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const s: Session = {
      stream,
      recorder,
      chunks: [],
      audio: null,
      frame: 0,
      timer: setInterval(() => {
        const sec = (clock() - s.started) / 1000;
        setSeconds(sec);
        if (sec >= maxSeconds) {
          stop();
          showToast({ message: t('voice.maxReached') });
        }
      }, 250),
      started: clock(),
      cancelled: false,
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size) s.chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (session.current === s) session.current = null;
      if (s.cancelled || !s.chunks.length) return;
      const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0]!;
      onDone(new File(s.chunks, recordingName(mime), { type: mime }));
    };
    // The level meter: how loud the microphone is now (0–1), so one sees it hears.
    try {
      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      audio.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
        s.frame = requestAnimationFrame(tick);
      };
      s.audio = audio;
      s.frame = requestAnimationFrame(tick);
    } catch {
      // No meter (an old browser): the recording itself still works.
    }
    session.current = s;
    recorder.start(1000);
    setSeconds(0);
    setRecording(true);
  };

  if (!recording)
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => void start()}
        data-tip={t('voice.record')}
        aria-label={t('voice.record')}
        data-testid="composer-record"
      >
        <Icon name="mic" size={15} />
        <span className="@max-sm:sr-only">{t('voice.record')}</span>
      </Button>
    );

  return (
    <span
      className="flex items-center gap-2 rounded-full border border-danger/40 bg-danger-soft px-2 py-0.5 text-xs text-danger-fg"
      role="status"
      aria-live="polite"
      data-testid="composer-recording"
    >
      <span aria-hidden className="voice-rec-dot size-2.5 rounded-full bg-danger" />
      <span className="sr-only">{t('voice.recording')}</span>
      <span className="tabular-nums" dir="ltr" data-testid="composer-recording-time">
        {formatMediaTime(seconds)} / {formatMediaTime(maxSeconds)}
      </span>
      <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full bg-danger/20">
        <span className="block h-full bg-danger transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} />
      </span>
      <button
        type="button"
        onClick={() => stop()}
        aria-label={t('voice.stop')}
        title={t('voice.stop')}
        data-testid="composer-record-stop"
        className={cn('grid size-6 place-items-center rounded-full bg-danger text-white hover:opacity-90')}
      >
        <Icon name="stop" size={12} />
      </button>
      <button
        type="button"
        onClick={() => stop(true)}
        aria-label={t('voice.cancel')}
        title={t('voice.cancel')}
        data-testid="composer-record-cancel"
        className="grid size-6 place-items-center rounded-full hover:bg-danger/15"
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
};
