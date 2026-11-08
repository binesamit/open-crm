// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import type { Transcription, VoiceSettingsView } from '@bines/shared';
import { api } from '../../lib/api';

/**
 * Voice in updates: what the account allows me — recording, its longest length, transcription (on, AI
 * on, a connection chosen, and not a guest). Changes in Administration → AI show within a few minutes.
 */
export const useVoice = (accountId: string) =>
  useQuery({
    queryKey: ['account', accountId, 'ai', 'voice'],
    queryFn: () => api(accountId).get<VoiceSettingsView>('/voice'),
    staleTime: 5 * 60_000,
  }).data ?? null;

/** The text of an audio / video file (counted in the account's AI usage). */
export const transcribe = (accountId: string, fileId: string) =>
  api(accountId).post<Transcription>(`/files/${fileId}/transcribe`, {});
