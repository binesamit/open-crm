// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AGENT_LIVE_EVENTS, AI_LIVE_EVENTS } from '@bines/shared';
import type {
  AddAgentKnowledge,
  Agent,
  AgentApproval,
  AgentAutomationRef,
  AgentDirectory,
  AgentKnowledge,
  AgentRun,
  AgentRunDetail,
  AgentTemplate,
  CreateAgent,
  DecideApproval,
  ImproveAgentInstructions,
  ImprovedAgentInstructions,
  StartAgentRun,
  UpdateAgent,
  BoardListEntry,
  WorkspaceTree,
} from '@bines/shared';
import { api } from '../../lib/api';
import type { Workspace } from '../board/board-api';
import { useAiLive } from '../ai/ai-api';
import { fromThisTab, useEventStream } from '../../lib/realtime';

/** Agents (the planning notes "AGENTS-MCP" מ6–מ7): list, editor, runs, approvals. */
export const agentKeys = {
  all: (accountId: string) => ['account', accountId, 'agents'] as const,
  list: (accountId: string) => ['account', accountId, 'agents', 'list'] as const,
  one: (accountId: string, id: string) => ['account', accountId, 'agents', 'one', id] as const,
  runs: (accountId: string, agentId: string | null) => ['account', accountId, 'agents', 'runs', agentId] as const,
  run: (accountId: string, runId: string) => ['account', accountId, 'agents', 'run', runId] as const,
  approvals: (accountId: string, status: string) => ['account', accountId, 'agents', 'approvals', status] as const,
  templates: (accountId: string) => ['account', accountId, 'agents', 'templates'] as const,
  connections: (accountId: string) => ['account', accountId, 'agents', 'connections'] as const,
  boards: (accountId: string) => ['account', accountId, 'agents', 'boards'] as const,
  directory: (accountId: string) => ['account', accountId, 'agents', 'directory'] as const,
  knowledge: (accountId: string, id: string) => ['account', accountId, 'agents', 'knowledge', id] as const,
  automations: (accountId: string, id: string) => ['account', accountId, 'agents', 'automations', id] as const,
  docs: (accountId: string) => ['account', accountId, 'agents', 'docs'] as const,
};

export type AgentConnection = { id: string; name: string; provider: string; default_model: string | null };
export type AgentTemplateRow = AgentTemplate & { added: boolean };

export const useAgents = (accountId: string) =>
  useQuery({
    queryKey: agentKeys.list(accountId),
    queryFn: () => api(accountId).get<{ data: Agent[]; can_create: boolean; new_agent_mention?: boolean }>('/agents'),
  });

export const useAgent = (accountId: string, id: string | null) =>
  useQuery({
    queryKey: agentKeys.one(accountId, id ?? ''),
    queryFn: () => api(accountId).get<Agent>(`/agents/${id}`),
    enabled: !!id,
  });

const active = (s: string | undefined) => s === 'queued' || s === 'running';

export const useAgentRuns = (accountId: string, agentId: string | null) =>
  useQuery({
    queryKey: agentKeys.runs(accountId, agentId),
    queryFn: () =>
      api(accountId).get<{ data: AgentRun[]; next_cursor: string | null }>(
        `/agents/runs${agentId ? `?agent_id=${agentId}` : ''}`,
      ),
    refetchInterval: (q) => (q.state.data?.data.some((r) => active(r.status)) ? 2000 : false),
  });

/** A run's transcript; refreshed while it runs (a queued / running run changes every few seconds). */
export const useRun = (accountId: string, runId: string | null) =>
  useQuery({
    queryKey: agentKeys.run(accountId, runId ?? ''),
    queryFn: () => api(accountId).get<AgentRunDetail>(`/agents/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => (active(q.state.data?.run.status) ? 1500 : false),
  });

export const useApprovals = (accountId: string, status: 'pending' | 'all') =>
  useQuery({
    queryKey: agentKeys.approvals(accountId, status),
    queryFn: () =>
      api(accountId).get<{ data: AgentApproval[] }>(
        `/agents/approvals${status === 'pending' ? '?status=pending' : ''}`,
      ),
  });

export const useAgentTemplates = (accountId: string, enabled: boolean) =>
  useQuery({
    queryKey: agentKeys.templates(accountId),
    queryFn: () => api(accountId).get<{ data: AgentTemplateRow[] }>('/agents/templates'),
    enabled,
  });

export const useAgentConnections = (accountId: string, enabled = true) => {
  useAiLive(accountId);
  return useQuery({
    queryKey: agentKeys.connections(accountId),
    queryFn: () => api(accountId).get<{ data: AgentConnection[] }>('/agents/connections'),
    enabled,
  });
};

/** The last agent event acted on per account — every directory hook listens, one refresh per event is enough. */
const handledAgentEvent = new Map<string, string>();

/**
 * Live agents: an agent created / changed / deleted — or the account's AI connections / settings
 * changed — by anyone, in any tab, reaches `/me/events`; the directory (mention lists, people pickers) and the
 * agents' lists refetch, so a mention switched on works at once without a reload.
 */
export const useAgentsLive = (accountId: string) => {
  const qc = useQueryClient();
  useEventStream('/me/events', accountId, (e) => {
    // A plan change may add or drop `ai`: the directory's `unavailable` reasons follow it.
    const relevant =
      AGENT_LIVE_EVENTS.has(e.type) ||
      AI_LIVE_EVENTS.has(e.type) ||
      e.type === 'account.plan_changed' ||
      e.type === 'resync';
    if (!relevant || fromThisTab(e)) return;
    const key = e.id ?? `${e.type}:${Date.now()}`;
    if (e.id && handledAgentEvent.get(accountId) === key) return;
    handledAgentEvent.set(accountId, key);
    void qc.invalidateQueries({ queryKey: agentKeys.directory(accountId) });
    void qc.invalidateQueries({ queryKey: agentKeys.list(accountId) });
  });
};

/**
 * Agents that act on a mention / an assignment — "digital workers" in mention lists and people pickers (מ8) — and
 * (`unavailable`) the others one could mention, with the reason. Live (useAgentsLive); a short cache as
 * the fallback when the event stream is down.
 */
export const useAgentDirectory = (accountId: string) => {
  useAgentsLive(accountId);
  return useQuery({
    queryKey: agentKeys.directory(accountId),
    queryFn: () => api(accountId).get<AgentDirectory>('/agents/directory'),
    staleTime: 30_000,
  });
};

/** The automations that run an agent (its "when it acts" tab). */
export const useAgentAutomations = (accountId: string, agentId: string) =>
  useQuery({
    queryKey: agentKeys.automations(accountId, agentId),
    queryFn: () => api(accountId).get<{ data: AgentAutomationRef[] }>(`/agents/${agentId}/automations`),
  });

/** Knowledge sources (מ9); refreshed while one is being indexed. */
export const useAgentKnowledge = (accountId: string, agentId: string) =>
  useQuery({
    queryKey: agentKeys.knowledge(accountId, agentId),
    queryFn: () => api(accountId).get<{ data: AgentKnowledge[] }>(`/agents/${agentId}/knowledge`),
    refetchInterval: (q) => (q.state.data?.data.some((s) => s.status === 'indexing') ? 2000 : false),
  });

export const useKnowledgeMutations = (accountId: string, agentId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const refresh = () => qc.invalidateQueries({ queryKey: agentKeys.all(accountId) });
  return {
    add: useMutation({
      mutationFn: (input: AddAgentKnowledge) => client.post<AgentKnowledge>(`/agents/${agentId}/knowledge`, input),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (sourceId: string) => client.delete<{ ok: true }>(`/agents/${agentId}/knowledge/${sourceId}`),
      onSuccess: refresh,
    }),
    reindex: useMutation({
      mutationFn: (sourceId: string) => client.post<AgentKnowledge>(`/agents/${agentId}/knowledge/${sourceId}/reindex`),
      onSuccess: refresh,
    }),
  };
};

export type DocChoice = { id: string; name: string; workspace: string };

/** Every doc I can see, by workspace (knowledge sources are picked from these). */
export const useDocChoices = (accountId: string) =>
  useQuery({
    queryKey: agentKeys.docs(accountId),
    queryFn: async () => {
      const client = api(accountId);
      const { data: workspaces } = await client.get<{ data: Workspace[] }>('/workspaces');
      const out: DocChoice[] = [];
      for (const w of workspaces) {
        const tree = await client.get<WorkspaceTree>(`/workspaces/${w.id}/tree`).catch(() => null);
        for (const e of tree?.entities ?? [])
          if (e.type === 'doc') out.push({ id: e.id, name: e.name, workspace: w.name });
      }
      return out;
    },
  });

export type BoardChoice = { id: string; name: string; workspace: string };

/** Every board I can see, by workspace (the agent's boards are picked from these). */
export const useBoardChoices = (accountId: string) =>
  useQuery({
    queryKey: agentKeys.boards(accountId),
    queryFn: async () => {
      const client = api(accountId);
      // One call, not a tree per workspace (GET /boards: every board I may open, from all workspaces).
      const { data: boards } = await client.get<{ data: BoardListEntry[] }>('/boards');
      return boards.map((b): BoardChoice => ({ id: b.id, name: b.name, workspace: b.workspace_name }));
    },
  });

export const useAgentMutations = (accountId: string) => {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: agentKeys.all(accountId) });
  const client = api(accountId);
  return {
    create: useMutation({
      mutationFn: (input: CreateAgent) => client.post<Agent>('/agents', input),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: UpdateAgent & { id: string }) => client.patch<Agent>(`/agents/${id}`, patch),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.delete<{ ok: true }>(`/agents/${id}`),
      onSuccess: refresh,
    }),
    // an admin approves / rejects an agent's request to search the web.
    webSearch: useMutation({
      mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
        client.post<Agent>(`/agents/${id}/web-search/${decision}`),
      onSuccess: refresh,
    }),
    seed: useMutation({
      mutationFn: (input: { connection_id: string; keys?: string[] }) =>
        client.post<{ data: Agent[] }>('/agents/templates/seed', input),
      onSuccess: refresh,
    }),
    start: useMutation({
      mutationFn: ({ agentId, ...input }: StartAgentRun & { agentId: string }) =>
        client.post<AgentRun>(`/agents/${agentId}/runs`, input),
      onSuccess: refresh,
    }),
    decide: useMutation({
      mutationFn: ({ id, ...input }: DecideApproval & { id: string }) =>
        client.post<AgentApproval>(`/agents/approvals/${id}`, input),
      onSuccess: () => {
        void refresh();
        void qc.invalidateQueries({ queryKey: ['account', accountId, 'notifications'] });
      },
    }),
    cancel: useMutation({
      mutationFn: (runId: string) => client.post<AgentRun>(`/agents/runs/${runId}/cancel`),
      onSuccess: refresh,
    }),
    undo: useMutation({
      mutationFn: ({ runId, force }: { runId: string; force?: boolean }) =>
        client.post<{ ok: true; undone: number }>(`/agents/runs/${runId}/undo`, { force: !!force }),
      onSuccess: refresh,
    }),
    // "improve with AI" — the rewrite only comes back; nothing is saved (no refresh).
    improve: useMutation({
      mutationFn: (input: ImproveAgentInstructions) =>
        client.post<ImprovedAgentInstructions>('/agents/improve-instructions', input),
    }),
  };
};
