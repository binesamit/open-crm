// SPDX-License-Identifier: AGPL-3.0-only
import {
  aiTranscriptionCost,
  AppError,
  isTranscriptionProvider,
  mediaKindOf,
  resolveAiPrice,
  type AiProvider,
  type AiSettings,
  type FileTranscript,
  type Transcription,
  type VoiceSettingsView,
} from '@bines/shared';
import { ProviderHttpError, safeAiError } from '@bines/server-ai';
import type { AppDeps, Actor } from '../../types';
import { recordAiFailure } from '../errors/errors.sources';
import { addUsage, findConnection, updateConnectionRow } from '../ai/ai.repo';
import { assertAiAvailable, loadAiSettings } from '../ai/ai.service';
import { overridesOf, secretOf } from '../ai/models.service';
import { loadPriceTable } from '../ai/prices.service';
import { recordEvent } from '../activity/activity.repo';
import { currentOf, findAsset, setAssetTranscript } from '../files/files.repo';
import { assetEditHolder, mayReadAsset } from '../files/files.service';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Voice in updates: the composer records a voice message — an ordinary audio file, uploaded and attached
 * like any other (the same rights, played in place) — and turns it into text with the speech-to-text connection the
 * account's admin chose (Administration → AI → "Voice and transcription"). Nothing is assumed: no connection, no
 * transcription. Each transcription is an AI cost: AI on, the plan, the budget, and a row in AI usage
 * (source `transcription`).
 */

/** The largest recording sent to a provider (its own limits are around this; a longer one is refused up front). */
export const MAX_TRANSCRIBE_BYTES = 100 * 1024 * 1024;

/** Transcription is for the account's people, not its guests (as AI features are). */
const mayTranscribe = (role: string) => role !== 'guest';

const transcriptionReady = (ai: AiSettings) => ai.enabled && ai.voice.transcription && !!ai.voice.connection_id;

/** GET /voice — what the composer and the players show (any member): no ids, no keys. */
export const voiceSettingsView = async (deps: Pick<AppDeps, 'db'>, a: Actor): Promise<VoiceSettingsView> => {
  const ai = await loadAiSettings(deps.db, a.ctx.accountId);
  return {
    recording: ai.voice.recording,
    max_seconds: ai.voice.max_seconds,
    transcription: transcriptionReady(ai) && mayTranscribe(a.ctx.role),
    auto: ai.voice.auto,
  };
};

/** The model: the account's choice, else the connection's newest speech-to-text model (none fixed in code). */
const pickModel = async (chosen: string | null, list: (() => Promise<{ id: string }[]>) | undefined) => {
  if (chosen) return chosen;
  const models = list ? await list().catch(() => []) : [];
  return models[0]?.id ?? null;
};

/** GET /ai/connections/{id}/transcription-models (admins): the connection's speech-to-text models, newest first. */
export const listTranscriptionModels = async (deps: AppDeps, a: Actor, connectionId: string) => {
  assertAccountAdmin(a.ctx);
  const row = await findConnection(deps.db, a.ctx.accountId, connectionId);
  if (!row) throw new AppError('not_found', 'AI connection not found');
  if (!isTranscriptionProvider(row.provider as AiProvider)) return { data: [] };
  const client = deps.aiClient(await secretOf(deps, row));
  try {
    return { data: (await client.listTranscriptionModels?.()) ?? [] };
  } catch (err) {
    throw new AppError('unprocessable', 'voice_transcription_failed', { reason: safeAiError(err) });
  }
};

/** The file version a request is about (a root id serves its current version), if this person may read it. */
const readableVersion = async (deps: Pick<AppDeps, 'db'>, a: Actor, fileId: string) => {
  const asset = await findAsset(deps.db, a.ctx.accountId, fileId);
  if (!asset || asset.uploadStatus !== 'uploaded' || !(await mayReadAsset(deps.db, a, asset)))
    throw new AppError('not_found', 'File not found');
  return asset.parentAssetId ? asset : await currentOf(deps.db, asset);
};

type StoredTranscript = {
  text: string;
  model: string | null;
  by: string | null;
  at: string;
  edited_by?: string | null;
  edited_at?: string | null;
};
const storedOf = (v: unknown): StoredTranscript | null =>
  v && typeof v === 'object' && typeof (v as StoredTranscript).text === 'string' ? (v as StoredTranscript) : null;

/**
 * POST /files/{id}/transcribe — the text of an audio / video file this person may read. Only when asked (or by the
 * account's "automatic" choice in the composer): the text is kept on the file version, so the next
 * person sees it without a new run; `force` runs it again (and is charged again).
 */
export const transcribeFile = async (
  deps: AppDeps,
  a: Actor,
  fileId: string,
  opts: { force?: boolean } = {},
): Promise<Transcription> => {
  if (!mayTranscribe(a.ctx.role)) throw new AppError('forbidden', 'voice_transcription_not_allowed');
  const served = await readableVersion(deps, a, fileId);
  if (!mediaKindOf({ name: served.fileName, mime: served.mime }))
    throw new AppError('invalid_value', 'voice_not_audio');
  const kept = storedOf(served.transcript);
  if (kept && !opts.force) return { text: kept.text, model: kept.model ?? '', cost_usd: 0, reused: true };
  if (served.size > MAX_TRANSCRIBE_BYTES) throw new AppError('payload_too_large', 'voice_file_too_large');

  const ai = await assertAiAvailable(deps.db, a.ctx.accountId, 'transcription');
  const conf = ai.voice;
  if (!conf.transcription || !conf.connection_id) throw new AppError('unprocessable', 'voice_not_configured');
  const row = await findConnection(deps.db, a.ctx.accountId, conf.connection_id);
  if (!row || !isTranscriptionProvider(row.provider as AiProvider))
    throw new AppError('unprocessable', 'voice_not_configured');
  const client = deps.aiClient(await secretOf(deps, row));
  if (!client.transcribe)
    throw new AppError('invalid_value', 'ai_provider_no_transcription', { provider: row.provider });
  const model = await pickModel(conf.model, client.listTranscriptionModels);
  if (!model) throw new AppError('unprocessable', 'voice_no_model');

  const audio = await deps.storage.get(served.storageKey!, MAX_TRANSCRIBE_BYTES);
  if (!audio) throw new AppError('not_found', 'File not found');
  let out;
  try {
    out = await client.transcribe({
      model,
      audio: new Uint8Array(audio),
      fileName: served.fileName,
      mime: served.mime,
      language: conf.language,
    });
  } catch (err) {
    recordAiFailure(deps.db, { accountId: a.ctx.accountId, connectionId: row.id, source: 'transcription', model, err });
    throw new AppError('unprocessable', 'voice_transcription_failed', {
      reason: safeAiError(err),
      ...(err instanceof ProviderHttpError && err.providerMessage ? { provider_message: err.providerMessage } : {}),
    });
  }
  const price = resolveAiPrice(row.provider, model, overridesOf(row), await loadPriceTable(deps.db));
  const costUsd = aiTranscriptionCost(price?.price, out);
  await addUsage(deps.db, {
    accountId: a.ctx.accountId,
    day: new Date().toISOString().slice(0, 10),
    source: 'transcription',
    connectionId: row.id,
    model,
    inputTokens: out.usage?.input_tokens ?? 0,
    outputTokens: out.usage?.output_tokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  });
  await updateConnectionRow(deps.db, row.id, { lastUsedAt: new Date() });
  if (out.text.trim())
    await setAssetTranscript(deps.db, served.id, {
      text: out.text,
      model,
      by: a.user.id,
      at: new Date().toISOString(),
    } satisfies StoredTranscript);
  return { text: out.text, model, cost_usd: costUsd };
};

/** GET /files/{id}/transcript — the kept transcript of a file this person may read (no AI, no cost). */
export const getTranscript = async (deps: Pick<AppDeps, 'db'>, a: Actor, fileId: string): Promise<FileTranscript> => {
  const served = await readableVersion(deps, a, fileId);
  const kept = storedOf(served.transcript);
  return {
    transcript: kept
      ? { text: kept.text, model: kept.model ?? null, created_at: kept.at, edited_at: kept.edited_at ?? null }
      : null,
    can_edit: a.ctx.role !== 'guest' && !!(await assetEditHolder(deps.db, a, served)),
  };
};

/**
 * PATCH /files/{id}/transcript — corrects the text (empty removes it): whoever may edit what holds the file (the
 * update's author, the cell's editors). Recorded in the item's activity (`file.transcript_edited`).
 */
export const editTranscript = async (
  deps: Pick<AppDeps, 'db'>,
  a: Actor,
  fileId: string,
  input: { text: string },
): Promise<FileTranscript> => {
  const served = await readableVersion(deps, a, fileId);
  const holder = a.ctx.role === 'guest' ? null : await assetEditHolder(deps.db, a, served);
  if (!holder) throw new AppError('forbidden', 'transcript_edit_not_allowed');
  const kept = storedOf(served.transcript);
  const text = input.text.trim();
  const now = new Date().toISOString();
  const next: StoredTranscript | null = text
    ? { ...(kept ?? { model: null, by: a.user.id, at: now }), text, edited_by: a.user.id, edited_at: now }
    : null;
  await deps.db.transaction(async (tx) => {
    await setAssetTranscript(tx, served.id, next);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.transcript_edited',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: holder.boardId,
      itemId: holder.itemId,
      before: kept ? { text: kept.text } : null,
      after: next ? { text: next.text } : null,
      meta: { file_id: served.id, file_name: served.fileName },
    });
  });
  return getTranscript(deps, a, fileId);
};
