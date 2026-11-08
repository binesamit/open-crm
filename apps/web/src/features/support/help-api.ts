// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import type { HelpAnswer, HelpArticleView, HelpHit, HelpOptions, HelpRouteKey } from '@bines/shared';
import { api } from '../../lib/api';

/**
 * The knowledge center, the reader's side: query keys and hooks of the "?" help panel, the ticket
 * form's suggestions and the help assistant. Everything inside an account (`/support/help/*`).
 */
export const helpKeys = {
  all: (accountId: string) => ['account', accountId, 'help'] as const,
  options: (accountId: string) => ['account', accountId, 'help', 'options'] as const,
  search: (accountId: string, q: string, route: string, mode: string) =>
    ['account', accountId, 'help', 'search', q, route, mode] as const,
  article: (accountId: string, id: string) => ['account', accountId, 'help', 'article', id] as const,
  category: (accountId: string, id: string) => ['account', accountId, 'help', 'category', id] as const,
  aiSettings: (accountId: string) => ['account', accountId, 'help', 'ai-settings'] as const,
};

/** `staleTime: 0` = fetch again when this screen opens (the knowledge center page lists what is published now). */
export const useHelpOptions = (accountId: string, enabled = true, staleTime = 60_000) =>
  useQuery({
    queryKey: helpKeys.options(accountId),
    queryFn: () => api(accountId).get<HelpOptions>('/support/help/options'),
    enabled,
    staleTime,
  });

/** A value that settles `ms` after the last change (typing). */
/** Search (words) or the screen's articles (no words, a route); `typing` = suggestions, not counted as a search. */
export const useHelpSearch = (
  accountId: string,
  q: string,
  opts: { route?: HelpRouteKey; mode?: 'search' | 'typing'; limit?: number; enabled?: boolean } = {},
) => {
  const text = q.trim();
  const params = new URLSearchParams();
  if (text) params.set('q', text);
  if (opts.route && !text) params.set('route', opts.route);
  if (opts.mode) params.set('mode', opts.mode);
  if (opts.limit) params.set('limit', String(opts.limit));
  return useQuery({
    queryKey: helpKeys.search(accountId, text, opts.route ?? '', opts.mode ?? 'search'),
    queryFn: () => api(accountId).get<{ data: HelpHit[] }>(`/support/help/search?${params.toString()}`),
    enabled: (opts.enabled ?? true) && (text.length >= 2 || (!text && !!opts.route)),
    staleTime: 30_000,
  });
};

/** A category's published articles (the knowledge center page), most helpful first. */
export const useHelpCategory = (accountId: string, categoryId: string | null) =>
  useQuery({
    queryKey: helpKeys.category(accountId, categoryId ?? ''),
    queryFn: () =>
      api(accountId).get<{ data: HelpHit[] }>(
        `/support/help/search?category_id=${encodeURIComponent(categoryId!)}&limit=20`,
      ),
    enabled: !!categoryId,
    staleTime: 30_000,
  });

/** The published practical guides: the knowledge center's "practical guides" row. */
export const useHelpGuides = (accountId: string, enabled = true, limit = 8) =>
  useQuery({
    queryKey: [...helpKeys.all(accountId), 'guides', limit] as const,
    queryFn: () => api(accountId).get<{ data: HelpHit[] }>(`/support/help/search?kind=guide&limit=${limit}`),
    enabled,
    staleTime: 30_000,
  });

export const useHelpArticle = (accountId: string, id: string | null) =>
  useQuery({
    queryKey: helpKeys.article(accountId, id ?? ''),
    queryFn: () => api(accountId).get<HelpArticleView>(`/support/help/articles/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });

export const sendFeedback = (accountId: string, id: string, helpful: boolean) =>
  api(accountId).post(`/support/help/articles/${id}/feedback`, { helpful });

/** Fire-and-forget outcome events (metrics) — a failure never bothers the person. */
export const sendHelpEvent = (
  accountId: string,
  kind: 'deflected' | 'ticket_opened',
  extra: { article_id?: string | null; query?: string } = {},
) => {
  void api(accountId)
    .post('/support/help/events', { kind, ...extra })
    .catch(() => undefined);
};

export const askAssistant = (accountId: string, question: string) =>
  api(accountId).post<HelpAnswer>('/support/help/ask', { question });
