// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiColumnInfo,
  AiColumnRun,
  AiColumnRunRequest,
  AssistantAgent,
  AssistantContext,
  AssistantConversation,
  AssistantMessage,
  AssistantRefType,
  AssistantStatus,
  AssistantStreamEvent,
} from '@bines/shared';
import { api } from '../../lib/api';
import { nextRequestId } from '../../lib/realtime';
import { useAiLive } from '../ai/ai-api';

/** AI columns (מ11) and the assistant panel (מ12) — the planning notes "AGENTS-MCP". */
export const ai2Keys = {
  connections: (accountId: string) => ['account', accountId, 'ai-columns', 'connections'] as const,
  column: (accountId: string, boardId: string, columnId: string) =>
    ['account', accountId, 'ai-columns', boardId, columnId] as const,
  status: (accountId: string) => ['account', accountId, 'assistant', 'status'] as const,
  conversations: (accountId: string, ctx: AssistantContext) =>
    ['account', accountId, 'assistant', 'conversations', ctx] as const,
  agents: (accountId: string) => ['account', accountId, 'assistant', 'agents'] as const,
  conversation: (accountId: string, id: string) => ['account', accountId, 'assistant', 'conversation', id] as const,
};

export type ConnectionOption = { id: string; name: string; provider: string; default_model: string | null };

export const useAiColumnConnections = (accountId: string) => {
  useAiLive(accountId);
  return useQuery({
    queryKey: ai2Keys.connections(accountId),
    queryFn: () => api(accountId).get<{ data: ConnectionOption[] }>('/ai-columns/connections'),
  });
};

export const useAiColumnInfo = (accountId: string, boardId: string, columnId: string, enabled = true) =>
  useQuery({
    queryKey: ai2Keys.column(accountId, boardId, columnId),
    queryFn: () => api(accountId).get<AiColumnInfo>(`/boards/${boardId}/ai-columns/${columnId}`),
    enabled,
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs an AI column and waits for it: small text runs answer at once; a queued run is polled until it ends. Image
 * runs are always queued (the images queue): `onStart` hears the run as it starts ("making 8
 * images…"), and every design made refreshes the board's rows so the cells show their progress. The board's rows
 * are refreshed afterwards.
 */
export const useRunAiColumn = (
  accountId: string,
  boardId: string,
  opts: { onStart?: (run: AiColumnRun) => void } = {},
) => {
  const qc = useQueryClient();
  const refreshRows = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['account', accountId, 'board', boardId, 'items'] }),
      qc.invalidateQueries({ queryKey: ['account', accountId, 'item'] }),
    ]);
  return useMutation({
    mutationFn: async ({
      columnId,
      path,
      ...req
    }: AiColumnRunRequest & {
      columnId: string;
      /** Another run endpoint of the column (retry-missing). */ path?: string;
    }) => {
      let run = await api(accountId).post<AiColumnRun>(
        `/boards/${boardId}/ai-columns/${columnId}/${path ?? 'run'}`,
        path ? {} : req,
      );
      const live = (r: AiColumnRun) => r.status === 'queued' || r.status === 'running';
      if (live(run)) {
        opts.onStart?.(run);
        await refreshRows();
      }
      // Images take longer (one after the other, retries wait): polled for up to an hour.
      const every = run.unit === 'image' ? 3000 : 1500;
      for (let i = 0; i < 1200 && live(run); i++) {
        await sleep(every);
        const seen = run.done + run.failed;
        run = await api(accountId).get<AiColumnRun>(`/ai-columns/runs/${run.id}`);
        if (run.done + run.failed !== seen) await refreshRows();
      }
      return run;
    },
    onSettled: async (_r, _e, v) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['account', accountId, 'board', boardId, 'items'] }),
        qc.invalidateQueries({ queryKey: ['account', accountId, 'item'] }),
        qc.invalidateQueries({ queryKey: ai2Keys.column(accountId, boardId, v.columnId) }),
      ]);
    },
  });
};

// ---- assistant ----

/** Whether the assistant may be used here — live: a connection or the AI settings changing refetches it (sync-ai). */
export const useAssistantStatus = (accountId: string) => {
  useAiLive(accountId);
  return useQuery({
    queryKey: ai2Keys.status(accountId),
    queryFn: () => api(accountId).get<AssistantStatus>('/ai/assistant/status'),
    staleTime: 60_000,
  });
};

/**
 * The conversations here: about an item, a board, a document or a dashboard, or none — the
 * account-level ones; with the assistant or with one agent (`agent_id`).
 */
export const useConversations = (accountId: string, ctx: AssistantContext, enabled: boolean) =>
  useQuery({
    queryKey: ai2Keys.conversations(accountId, ctx),
    queryFn: () => {
      const q = new URLSearchParams(Object.entries(ctx).filter((e): e is [string, string] => !!e[1]));
      return api(accountId).get<{ data: AssistantConversation[] }>(`/ai/assistant/conversations?${q}`);
    },
    enabled,
  });

/** The agents I may chat with in the panel — none while AI is off. */
export const useChatAgents = (accountId: string) =>
  useQuery({
    queryKey: ai2Keys.agents(accountId),
    queryFn: () => api(accountId).get<{ data: AssistantAgent[] }>('/ai/assistant/agents'),
    staleTime: 60_000,
  });

export const useConversation = (accountId: string, id: string | null) =>
  useQuery({
    queryKey: ai2Keys.conversation(accountId, id ?? ''),
    queryFn: () =>
      api(accountId).get<{ conversation: AssistantConversation; messages: AssistantMessage[] }>(
        `/ai/assistant/conversations/${id}`,
      ),
    enabled: !!id,
  });

export const createConversation = (accountId: string, ctx: AssistantContext) =>
  api(accountId).post<AssistantConversation>('/ai/assistant/conversations', ctx);

export const deleteConversation = (accountId: string, id: string) =>
  api(accountId).delete<{ ok: true }>(`/ai/assistant/conversations/${id}`);

export const decideActions = (accountId: string, messageId: string, body: { approve?: string[]; reject?: string[] }) =>
  api(accountId).post<{ batch_id: string | null; message: AssistantMessage }>(
    `/ai/assistant/messages/${messageId}/actions`,
    { approve: body.approve ?? [], reject: body.reject ?? [] },
  );

/**
 * Sends a message and reads the answer as it streams (POST + text/event-stream — EventSource cannot POST).
 * A refusal before the stream (limits, availability) throws `{ code }` like the API client does.
 */
export const streamMessage = async (
  accountId: string,
  conversationId: string,
  text: string,
  onEvent: (e: AssistantStreamEvent) => void,
  /** files uploaded for this message (POST /files/presign). */
  fileIds: string[] = [],
  /** what the message points at with "@". */
  refs: { type: AssistantRefType; id: string }[] = [],
) => {
  const res = await fetch(`/api/v1/ai/assistant/conversations/${conversationId}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'x-account-id': accountId,
      'x-request-id': nextRequestId(),
    },
    body: JSON.stringify({ text, ...(fileIds.length ? { file_ids: fileIds } : {}), ...(refs.length ? { refs } : {}) }),
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw { code: err?.error?.code ?? 'internal' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data) as AssistantStreamEvent);
    }
  }
};
