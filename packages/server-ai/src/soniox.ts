// SPDX-License-Identifier: AGPL-3.0-only
import { callJson, multipartBody, send, trimBase } from './http';
import { safeAiError } from './errors';
import type { AiClient, AiConnectionSecret, AiTranscribeRequest, AiTranscription, FetchLike } from './types';

/**
 * Soniox: speech to text only — no chat. The async API: upload the recording (`POST /v1/files`), start a
 * transcription (`POST /v1/transcriptions`), wait until it is done, read its text, then delete both (nothing stays
 * at the provider). Models come from its own list (`GET /v1/models`, the async ones) — none is fixed here.
 */
export const SONIOX_BASE_URL = 'https://api.soniox.com';

const LIST_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 2 * 60_000;
/** How long one recording may take to transcribe before we give up. */
export const SONIOX_WAIT_MS = 5 * 60_000;
const POLL_MS = 1000;

type SxModel = { id?: string; name?: string; transcription_mode?: string };
type SxTranscription = { id?: string; status?: string; error_message?: string | null; audio_duration_ms?: number };

export const createSonioxClient = (
  conn: AiConnectionSecret,
  fetchFn: FetchLike,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): AiClient => {
  const base = trimBase(conn.baseUrl || SONIOX_BASE_URL);
  const headers: Record<string, string> = { authorization: `Bearer ${conn.apiKey}` };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const listTranscriptionModels = async () => {
    const res = await callJson<{ models?: SxModel[] }>(fetchFn, `${base}/v1/models`, {
      method: 'GET',
      headers,
      timeoutMs: LIST_TIMEOUT_MS,
    });
    // Async (file) models only; the list's own order, newest last → newest first.
    return (res.models ?? [])
      .filter((m): m is SxModel & { id: string } => typeof m.id === 'string' && m.transcription_mode !== 'real_time')
      .map((m) => ({ id: m.id, display_name: m.name || m.id }))
      .reverse();
  };
  const remove = (path: string) =>
    send(fetchFn, `${base}${path}`, { method: 'DELETE', headers, timeoutMs: LIST_TIMEOUT_MS }).catch(() => undefined);
  const transcribe = async (req: AiTranscribeRequest): Promise<AiTranscription> => {
    const file = await callJson<{ id?: string }>(fetchFn, `${base}/v1/files`, {
      method: 'POST',
      headers,
      raw: multipartBody([
        ['file', { data: req.audio, mime: req.mime || 'application/octet-stream', filename: req.fileName || 'audio' }],
      ]),
      timeoutMs: CALL_TIMEOUT_MS,
    });
    if (!file.id) throw new Error('soniox_upload_failed');
    let job: SxTranscription | null = null;
    try {
      job = await callJson<SxTranscription>(fetchFn, `${base}/v1/transcriptions`, {
        method: 'POST',
        headers,
        body: { model: req.model, file_id: file.id, ...(req.language ? { language_hints: [req.language] } : {}) },
        timeoutMs: CALL_TIMEOUT_MS,
      });
      if (!job.id) throw new Error('soniox_start_failed');
      const until = now() + SONIOX_WAIT_MS;
      while (job.status !== 'completed') {
        if (job.status === 'error') throw new Error(`soniox_failed: ${job.error_message ?? 'error'}`);
        if (now() > until) throw new Error('soniox_timeout');
        await sleep(POLL_MS);
        job = await callJson<SxTranscription>(fetchFn, `${base}/v1/transcriptions/${job.id}`, {
          method: 'GET',
          headers,
          timeoutMs: LIST_TIMEOUT_MS,
        });
      }
      const out = await callJson<{ text?: string }>(fetchFn, `${base}/v1/transcriptions/${job.id}/transcript`, {
        method: 'GET',
        headers,
        timeoutMs: CALL_TIMEOUT_MS,
      });
      return {
        text: (out.text ?? '').trim(),
        model: req.model,
        durationSeconds: typeof job.audio_duration_ms === 'number' ? job.audio_duration_ms / 1000 : null,
        usage: null,
      };
    } finally {
      if (job?.id) await remove(`/v1/transcriptions/${job.id}`);
      await remove(`/v1/files/${file.id}`);
    }
  };
  return {
    provider: conn.provider,
    complete: () => Promise.reject(new Error('ai_provider_no_chat')),
    test: async () => {
      try {
        await listTranscriptionModels();
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: safeAiError(err) };
      }
    },
    // No chat models (the chat features' pickers leave it out, AI_PROVIDER_INFO.chat); the call still proves the key.
    listModels: async () => {
      await listTranscriptionModels();
      return [];
    },
    transcribe,
    listTranscriptionModels,
  };
};
