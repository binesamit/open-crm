// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { McpAgentTool, McpServer, McpServerAuth } from '@bines/shared';
import { api } from '../../lib/api';

/** Outbound MCP servers (מ10): Administration → AI ו-MCP, and the agent editor's remote tools. */
export const mcpServerKeys = {
  list: (accountId: string) => ['account', accountId, 'mcp-servers'] as const,
  tools: (accountId: string) => ['account', accountId, 'mcp-servers', 'tools'] as const,
};

export const useMcpServers = (accountId: string) =>
  useQuery({
    queryKey: mcpServerKeys.list(accountId),
    queryFn: () => api(accountId).get<{ data: McpServer[] }>('/mcp-servers'),
  });

/** Enabled remote tools (any member who edits agents). */
export const useMcpAgentTools = (accountId: string) =>
  useQuery({
    queryKey: mcpServerKeys.tools(accountId),
    queryFn: () => api(accountId).get<{ data: McpAgentTool[] }>('/mcp-servers/tools'),
    staleTime: 60_000,
  });

export type NewMcpServer = {
  key: string;
  name: string;
  url: string;
  auth: McpServerAuth;
  timeout_ms?: number;
  max_calls_per_hour?: number;
};

export const useMcpServerMutations = (accountId: string) => {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: mcpServerKeys.list(accountId) });
  return {
    create: useMutation({
      mutationFn: (v: NewMcpServer) => api(accountId).post<McpServer>('/mcp-servers', v),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (v: {
        id: string;
        name?: string;
        url?: string;
        auth?: McpServerAuth;
        enabled?: boolean;
        timeout_ms?: number;
        max_calls_per_hour?: number;
      }) => {
        const { id, ...patch } = v;
        return api(accountId).patch<McpServer>(`/mcp-servers/${id}`, patch);
      },
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(accountId).delete(`/mcp-servers/${id}`),
      onSuccess: done,
    }),
    refresh: useMutation({
      mutationFn: (id: string) => api(accountId).post<McpServer>(`/mcp-servers/${id}/refresh`, {}),
      onSuccess: done,
    }),
    tools: useMutation({
      mutationFn: (v: { id: string; tools: Record<string, { enabled: boolean; approval: boolean }> }) =>
        api(accountId).put<McpServer>(`/mcp-servers/${v.id}/tools`, { tools: v.tools }),
      onSuccess: done,
    }),
  };
};

export const testMcpTool = (accountId: string, id: string, tool: string, input: Record<string, unknown>) =>
  api(accountId).post<{ text: string; is_error: boolean; truncated: boolean }>(`/mcp-servers/${id}/test`, {
    tool,
    input,
  });
