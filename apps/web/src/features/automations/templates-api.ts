// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutomationTemplateDto, AutomationTemplateList, TemplateProposal } from '@bines/shared';
import { api } from '../../lib/api';
import type { SavedAutomation } from './automations-api';

/** Account automation templates ("save as template", the template library and its install flow). */
export const templateKeys = {
  list: (accountId: string) => ['account', accountId, 'automation-templates'] as const,
};

export const useAutomationTemplates = (accountId: string, enabled = true) =>
  useQuery({
    queryKey: templateKeys.list(accountId),
    queryFn: () => api(accountId).get<AutomationTemplateList>('/automation-templates'),
    enabled,
  });

export const useTemplateMutations = (accountId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const refresh = () => qc.invalidateQueries({ queryKey: templateKeys.list(accountId) });
  return {
    save: useMutation({
      mutationFn: (p: { automationId: string; name?: string; description?: string; category?: string }) =>
        client.post<AutomationTemplateDto>(`/automations/${p.automationId}/save-as-template`, {
          name: p.name,
          description: p.description,
          category: p.category,
        }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: (p: { id: string; name?: string; description?: string | null; category?: string | null }) =>
        client.patch<AutomationTemplateDto>(`/automation-templates/${p.id}`, {
          name: p.name,
          description: p.description,
          category: p.category,
        }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => client.delete<{ ok: true }>(`/automation-templates/${id}`),
      onSuccess: refresh,
    }),
    install: useMutation({
      mutationFn: (p: { id: string; board_id: string; mapping: Record<string, string>; is_active: boolean }) =>
        client.post<SavedAutomation>(`/automation-templates/${p.id}/install`, {
          board_id: p.board_id,
          mapping: p.mapping,
          is_active: p.is_active,
        }),
      // The board's list and the account's list both change.
      onSuccess: () => qc.invalidateQueries({ queryKey: ['account', accountId] }),
    }),
  };
};

/** The install form for a board: re-asked when a pick changes (a label's choices follow its column). */
export const useTemplateProposal = (
  accountId: string,
  id: string,
  boardId: string | null,
  mapping: Record<string, string>,
) =>
  useQuery({
    queryKey: ['account', accountId, 'automation-template', id, 'proposal', boardId, mapping],
    queryFn: () =>
      api(accountId).post<TemplateProposal>(`/automation-templates/${id}/proposal`, { board_id: boardId, mapping }),
    enabled: !!boardId,
    placeholderData: (prev) => prev,
  });
